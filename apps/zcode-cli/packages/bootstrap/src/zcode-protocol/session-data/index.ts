// 项目数据彻底删除的 CLI 执行面（v4/storage/sessionData/*）。
// 规格：docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」。
import type { SessionId } from "@zcode/contracts";
import {
  v4SessionDataParamsSchema,
  type V4SessionDataMeasureResult,
  type V4SessionDataParams,
  type V4SessionDataPurgeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createSessionResidentPoolHost, deactivateSessionRecord } from "../session-residency.js";
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
 * `zcode-artifact://<源会话>/…` 仍指向源会话的附件目录。保留判定在 purgeSessionDataWith
 * 的轮次循环里按"删除进行时"快照执行（见其注释），这里不再做批次头的一次性预计算。
 */
export async function purgeSessionDataWith(
  host: SessionDataHost,
  params: V4SessionDataParams,
): Promise<V4SessionDataPurgeResult> {
  const result: V4SessionDataPurgeResult = { deleted: [], kept: [], failed: [], memory: [] };
  const all = await trees(host, params);
  // Bug 修复（上游同步审查 2026-10-30，P1+P2）：批次头的 running/referenced 快照在执行
  // 期间会失真——前一棵树删文件时，后一棵树可能被命令准入变为 busy（照删会抽掉运行中
  // 会话的持久数据）；引用方候选删除失败后，被它引用的附件不能先于它消失。改为按轮次
  // 处理：每轮对剩余候选重取引用快照（真实 store 只返回仍存活会话的引用，已删行自然
  // 消失），引用方先删、失败方阻断被引用树；每棵树删除前逐树复查运行态。
  let remaining = all.map(({ root, ids }) => ({ root, ids }));
  while (remaining.length > 0) {
    const pendingIds = new Set(remaining.flatMap(({ ids }) => ids));
    const referrers = await host.store.listArtifactReferrers(
      remaining.flatMap(({ ids }) => ids) as SessionId[],
    );
    let progressed = false;
    const deferred: typeof remaining = [];
    for (const { root, ids } of remaining) {
      // 运行中的会话（含其子会话在跑）整棵保留：删掉正在写入的会话会让 turn 写库失败。
      if (ids.some((id) => host.residency(id) === "busy")) {
        result.kept.push({ sessionId: root, reason: "running" });
        progressed = true;
        continue;
      }
      // 引用方分两类：仍在待删集合 → 本轮推迟（后续轮先删引用方，被引用的附件
      // 才能随之消失）；不在待删集合（批外会话，或本批中删除失败/被保留的树）→
      // 被引用树整棵保留，附件不能先于引用方消失。
      const liveReferrers = ids.flatMap((id) => (referrers.get(id as SessionId) ?? []));
      const hasLiveBlocker = liveReferrers.some((referrer) => !pendingIds.has(referrer));
      if (hasLiveBlocker) {
        result.kept.push({ sessionId: root, reason: "referenced" });
        progressed = true;
        continue;
      }
      const hasPendingReferrer = liveReferrers.some((referrer) => pendingIds.has(referrer));
      if (hasPendingReferrer) {
        deferred.push({ root, ids });
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
        progressed = true;
      } catch (error) {
        // 失败也是进展：它退出 remaining，被它引用的树下一轮被阻断并保留。
        result.failed.push({ sessionId: root, code: failureCode(error) });
        progressed = true;
      }
    }
    remaining = deferred;
    if (!progressed) {
      // 剩余树的引用方全部是本批保留树或批外会话：按附件引用规则整棵保留。
      for (const { root } of remaining) result.kept.push({ sessionId: root, reason: "referenced" });
      break;
    }
  }
  // 保留项按请求顺序输出：轮次处理会让 running/referenced 的产生顺序与入参不同，
  // 对外结果保持稳定的入参序，调用方（进度与警告横幅）不依赖内部轮次。
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
  if (!store?.listOwnedSessionTrees || !store.listArtifactReferrers || !store.purgeSessions || !files)
    throw new Error("Session data deletion is unavailable");
  const residency = createSessionResidentPoolHost(context);
  return {
    store: {
      listOwnedSessionTrees: store.listOwnedSessionTrees.bind(store),
      listArtifactReferrers: store.listArtifactReferrers.bind(store),
      purgeSessions: store.purgeSessions.bind(store),
    },
    files,
    residency(sessionId) {
      const facts = residency.readResidencyFacts(sessionId);
      if (!facts) return null;
      return facts.hasResidencyBlockingWork || facts.hasPendingInteractions || facts.hasQueuedCommands
        ? "busy"
        : "idle";
    },
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
