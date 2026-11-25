// 项目数据彻底删除的 CLI 执行面（v4/storage/sessionData/*）。
// 规格：docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」。
import type { SessionId } from "@zcode/contracts";
import {
  v4SessionDataParamsSchema,
  type V4SessionDataMeasureResult,
  type V4SessionDataParams,
  type V4SessionDataPurgeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { deactivateSessionRecord, readSessionBusyState } from "../session-residency.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "../server-types.js";
import type { SessionDataHost } from "./contract.js";

export type { SessionDataHost } from "./contract.js";

const UNKNOWN_FAILURE_CODE = "unknown";

function failureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code ? code : UNKNOWN_FAILURE_CODE;
}

async function trees(host: SessionDataHost, params: V4SessionDataParams) {
  const owned = await host.store.listOwnedSessionTrees(params.sessionIds as SessionId[]);
  // 库里已不存在的根仍按自身 ID 处理：清理可能残留的会话文件，结果按 0 行删除成功。
  return params.sessionIds.map((root) => {
    const ids = owned.get(root as SessionId) ?? [];
    return { root, ids: ids.length ? ids : [root] };
  });
}

export async function measureSessionDataWith(
  host: SessionDataHost,
  params: V4SessionDataParams,
): Promise<V4SessionDataMeasureResult> {
  const sessions = [];
  for (const { root, ids } of await trees(host, params)) {
    const sizes = await Promise.all(ids.map((id) => host.files.measureSession(id)));
    sessions.push({ sessionId: root, bytes: sizes.reduce((sum, bytes) => sum + bytes, 0) });
  }
  const memory = await Promise.all(
    params.directories.map(async (directory) => ({
      workspacePath: directory.workspacePath,
      bytes: await host.files.measureMemory(directory),
    })),
  );
  return { sessions, memory };
}

/**
 * 附件仍被本次不删除的会话引用的树整棵保留：fork、回退、工作流转录按值复制 part，
 * `zcode-artifact://<源会话>/…` 仍指向源会话的附件目录。引用关系按树建立依赖，只取一次快照，
 * 之后按本批的删除结果推进（见 purgeSessionDataWith 的注释）。
 */
export async function purgeSessionDataWith(
  host: SessionDataHost,
  params: V4SessionDataParams,
): Promise<V4SessionDataPurgeResult> {
  const result: V4SessionDataPurgeResult = { deleted: [], kept: [], failed: [], memory: [] };
  const all = await trees(host, params);
  const idsOf = new Map(all.map(({ root, ids }) => [root, ids] as const));
  const treeOf = new Map<string, string>();
  for (const { root, ids } of all) for (const id of ids) treeOf.set(id, root);

  // 引用关系只取一次：listArtifactReferrers 是对 part 表的全表 instr 扫描，此前按轮次对剩余候选
  // 重取快照，32 棵树的单向引用链要把整库扫 32 遍。之后只按本批的删除结果推进依赖：
  // 引用方删除成功，它的引用随行一起消失；引用方被保留（运行中）或删除失败，被它引用的树整棵
  // 保留——附件不能先于引用方消失，否则留下永久悬挂引用。
  const referrers = await host.store.listArtifactReferrers(
    [...treeOf.keys()] as SessionId[],
  );
  // root → 本批内必须先删除的引用方树；root → 引用它的那些树。
  const blockers = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, from: string, to: string) =>
    map.set(from, (map.get(from) ?? new Set<string>()).add(to));
  const referencedFromOutside = new Set<string>();
  for (const [id, root] of treeOf) {
    for (const referrer of referrers.get(id as SessionId) ?? []) {
      // 同一棵树内的引用（子会话引用父会话附件）随树一起删除，不构成阻塞。此前它被算作
      // “待删集合里的引用方”，一棵空闲的树因此被反复推迟，最后按“被引用”保留，重试也无法释放。
      const referrerTree = treeOf.get(referrer);
      if (referrerTree === root) continue;
      if (referrerTree === undefined) {
        referencedFromOutside.add(root);
        continue;
      }
      link(blockers, root, referrerTree);
      link(dependents, referrerTree, root);
    }
  }

  const removed = new Set<string>();
  const finished = new Set<string>();
  // 引用方仍在（批外会话、被保留或删除失败）：它引用的树以及下游全部保留。
  const keepReferenced = (root: string): void => {
    if (finished.has(root)) return;
    finished.add(root);
    result.kept.push({ sessionId: root, reason: "referenced" });
    for (const dependent of dependents.get(root) ?? []) keepReferenced(dependent);
  };
  for (const root of referencedFromOutside) keepReferenced(root);

  let pending = all.map(({ root }) => root).filter((root) => !finished.has(root));
  while (pending.length > 0) {
    const ready = pending.filter((root) =>
      [...(blockers.get(root) ?? [])].every((blocker) => removed.has(blocker)),
    );
    if (ready.length === 0) {
      // 剩余的树互相引用（不动点链），没有可以先删的一端：整批保留。
      for (const root of pending) keepReferenced(root);
      break;
    }
    for (const root of pending) {
      if (!ready.includes(root)) continue;
      const ids = idsOf.get(root) ?? [];
      // 运行中的会话（含其子会话在跑）整棵保留：删掉正在写入的会话会让 turn 写库失败。
      // 上游同步审查 2026-10-30 P1：批次头的快照在执行期间会失真——前一棵树删文件时，后一棵树
      // 可能被命令准入变为 busy，所以每棵树删除前逐树复查运行态。
      if (ids.some((id) => host.residency(id) === "busy")) {
        finished.add(root);
        result.kept.push({ sessionId: root, reason: "running" });
        for (const dependent of dependents.get(root) ?? []) keepReferenced(dependent);
        continue;
      }
      try {
        for (const id of ids) if (host.residency(id) === "idle") await host.release(id);
        // 先删文件再删行：文件删除失败时行还在，重试仍能按会话找到这些文件。
        let bytes = 0;
        for (const id of ids) bytes += await host.files.removeSession(id);
        await host.store.purgeSessions([root as SessionId]);
        // 文件与行都删除后才从列表投影移除；失败时 sessions-index 与 Host 镜像保持原样。
        for (const id of ids) host.forgetIndexed(id);
        result.deleted.push({ sessionId: root, bytes });
        finished.add(root);
        removed.add(root);
      } catch (error) {
        finished.add(root);
        result.failed.push({ sessionId: root, code: failureCode(error) });
        for (const dependent of dependents.get(root) ?? []) keepReferenced(dependent);
      }
    }
    pending = pending.filter((root) => !finished.has(root));
  }
  // 保留项按请求顺序输出：依赖处理会让 running/referenced 的产生顺序与入参不同，
  // 对外结果保持稳定的入参序，调用方（进度与警告横幅）不依赖内部顺序。
  const order = new Map(all.map(({ root }, index) => [root, index]));
  result.kept.sort((a, b) => (order.get(a.sessionId) ?? 0) - (order.get(b.sessionId) ?? 0));
  for (const directory of params.directories) {
    try {
      result.memory.push({
        workspacePath: directory.workspacePath,
        bytes: await host.files.removeMemory(directory),
      });
    } catch (error) {
      result.failed.push({ workspacePath: directory.workspacePath, code: failureCode(error) });
    }
  }
  return result;
}

function hostFromContext(context: ZCodeProtocolAgentServerContext): SessionDataHost {
  const store = context.deps.sessionStore;
  const files = context.deps.sessionDataFiles;
  if (
    !store?.listOwnedSessionTrees ||
    !store.listArtifactReferrers ||
    !store.purgeSessions ||
    !files
  )
    throw new Error("Session data deletion is unavailable");
  return {
    store: {
      listOwnedSessionTrees: store.listOwnedSessionTrees.bind(store),
      listArtifactReferrers: store.listArtifactReferrers.bind(store),
      purgeSessions: store.purgeSessions.bind(store),
    },
    files,
    residency: (sessionId) => readSessionBusyState(context, sessionId),
    // 修复原因：曾按 deleteSession 同序 dispose(deleted:true)，在文件删除前就发布 session.removed；
    // 文件删除失败（EACCES/EBUSY）时 Host 已把任务当作删除，CLI 行却还在。这里只做驻留去激活。
    release: (sessionId) => deactivateSessionRecord(context, sessionId),
    forgetIndexed: (sessionId) => context.v4Gateway?.forgetIndexedSession(sessionId),
  };
}

export async function measureSessionData(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SessionDataMeasureResult> {
  return measureSessionDataWith(hostFromContext(context), parseParams(v4SessionDataParamsSchema, rawParams));
}

export async function purgeSessionData(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SessionDataPurgeResult> {
  const params = parseParams(v4SessionDataParamsSchema, rawParams);
  const result = await purgeSessionDataWith(hostFromContext(context), params);
  context.logger?.info("Session data purged", {
    event: "zcode_protocol.session_data.purged",
    deleted: result.deleted.length,
    kept: result.kept.length,
    failed: result.failed.length,
  });
  return result;
}

export { previewSessionDeletion, executeSessionDeletion } from "./permanent-deletion.js";
