import { describe, expect, it } from "vitest";
import {
  measureSessionDataWith,
  purgeSessionDataWith,
  type SessionDataHost,
} from "../src/zcode-protocol/session-data/index.js";

function harness(
  options: {
    busy?: string[];
    loaded?: string[];
    failFiles?: string[];
    referrers?: Record<string, string[]>;
    onRemoveSession?: (id: string) => void;
  } = {},
) {
  const trees: Record<string, string[]> = {
    sess_a: ["sess_a", "sess_a_child"],
    sess_b: ["sess_b"],
    sess_c: ["sess_c"],
  };
  const sizes: Record<string, number> = { sess_a: 10, sess_a_child: 5, sess_b: 7, sess_gone: 3 };
  const calls: string[] = [];
  // 镜像真实 store 语义：行被 purgeSessions 删除后，其引用从后续查询中消失。
  const deletedRows = new Set<string>();
  const host: SessionDataHost = {
    store: {
      listOwnedSessionTrees: async (ids) =>
        new Map(ids.map((id) => [id, trees[id] ?? []] as const)) as never,
      listArtifactReferrers: async (ids) =>
        new Map(
          ids.flatMap((id) =>
            options.referrers?.[id]
              ? [[id, options.referrers[id].filter((r) => !deletedRows.has(r))] as const]
              : [],
          ),
        ) as never,
      purgeSessions: async (ids) => {
        calls.push(`purge:${ids.join(",")}`);
        for (const id of ids) deletedRows.add(id);
      },
    },
    files: {
      measureSession: async (id) => sizes[id] ?? 0,
      removeSession: async (id) => {
        options.onRemoveSession?.(id);
        if (options.failFiles?.includes(id)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        calls.push(`files:${id}`);
        return sizes[id] ?? 0;
      },
      measureMemory: async () => 4,
      removeMemory: async ({ workspacePath }) => {
        calls.push(`memory:${workspacePath}`);
        return 4;
      },
    },
    residency: (id) =>
      options.busy?.includes(id) ? "busy" : options.loaded?.includes(id) ? "idle" : null,
    release: async (id) => {
      calls.push(`release:${id}`);
    },
    forgetIndexed: (id) => {
      calls.push(`forget:${id}`);
    },
  };
  return { host, calls };
}

const directories = [{ workspacePath: "/work/a" }];

describe("session data", () => {
  it("measures each root with its owned children and each directory's memory", async () => {
    const { host } = harness();
    expect(
      await measureSessionDataWith(host, { sessionIds: ["sess_a", "sess_b"], directories }),
    ).toEqual({
      sessions: [
        { sessionId: "sess_a", bytes: 15 },
        { sessionId: "sess_b", bytes: 7 },
      ],
      memory: [{ workspacePath: "/work/a", bytes: 4 }],
    });
  });

  it("releases loaded idle sessions, removes files before rows, then drops them from the index", async () => {
    const { host, calls } = harness({ loaded: ["sess_a_child"] });
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_a"], directories });
    expect(result).toEqual({
      deleted: [{ sessionId: "sess_a", bytes: 15 }],
      kept: [],
      failed: [],
      memory: [{ workspacePath: "/work/a", bytes: 4 }],
    });
    expect(calls).toEqual([
      "release:sess_a_child",
      "files:sess_a",
      "files:sess_a_child",
      "purge:sess_a",
      "forget:sess_a",
      "forget:sess_a_child",
      "memory:/work/a",
    ]);
  });

  it("keeps a tree whose root or child is running, without touching its files", async () => {
    const { host, calls } = harness({ busy: ["sess_a_child"] });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    expect(result.kept).toEqual([{ sessionId: "sess_a", reason: "running" }]);
    expect(result.deleted).toEqual([{ sessionId: "sess_b", bytes: 7 }]);
    expect(calls.some((call) => call.includes("sess_a"))).toBe(false);
  });

  it("leaves the rows when a file cannot be removed so a retry can find them", async () => {
    const { host, calls } = harness({ failFiles: ["sess_a_child"] });
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_a"], directories: [] });
    expect(result.failed).toEqual([{ sessionId: "sess_a", code: "EBUSY" }]);
    expect(result.deleted).toEqual([]);
    expect(calls).not.toContain("purge:sess_a");
    // 删除没完成：不能先从列表投影移除，否则 Host 会把仍存在的会话当作已删除。
    expect(calls.some((call) => call.startsWith("forget:"))).toBe(false);
  });

  it("keeps a tree whose attachments a session outside the request still uses", async () => {
    const { host, calls } = harness({ referrers: { sess_a_child: ["sess_fork_elsewhere"] } });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    expect(result.kept).toEqual([{ sessionId: "sess_a", reason: "referenced" }]);
    expect(result.deleted).toEqual([{ sessionId: "sess_b", bytes: 7 }]);
    expect(calls.some((call) => call.includes("sess_a"))).toBe(false);
  });

  it("deletes a source together with a fork that is deleted in the same request", async () => {
    const { host } = harness({ referrers: { sess_a: ["sess_b"] } });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    expect(result.kept).toEqual([]);
    // 2026-10-30 修正后引用方先删：fork 先落地，source 在下一轮确认引用消失后删除。
    expect(result.deleted.map((entry) => entry.sessionId)).toEqual(["sess_b", "sess_a"]);
  });

  it("keeps every tree in a chain once one link is kept", async () => {
    // sess_c 正在运行并引用 sess_b，sess_b 又引用 sess_a：三棵都不能删。
    const { host } = harness({
      busy: ["sess_c"],
      referrers: { sess_a: ["sess_b"], sess_b: ["sess_c"] },
    });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b", "sess_c"],
      directories: [],
    });
    expect(result.kept).toEqual([
      { sessionId: "sess_a", reason: "referenced" },
      { sessionId: "sess_b", reason: "referenced" },
      { sessionId: "sess_c", reason: "running" },
    ]);
    expect(result.deleted).toEqual([]);
  });

  it("keeps a tree that becomes busy after the batch started, without purging its rows", async () => {
    // 上游同步审查 P1 回归：running 不能只在批次开始计算——删除 sess_a 文件期间
    // sess_b 被命令准入变为 busy，必须整棵保留，不能删文件/行。
    const busy: string[] = [];
    const { host, calls } = harness({ onRemoveSession: (id) => {
      if (id === "sess_a") busy.push("sess_b");
    } });
    // harness 的 residency 读取 options.busy；这里通过闭包注入动态数组。
    const dynamicHost: SessionDataHost = {
      ...host,
      residency: (id) => (busy.includes(id) ? "busy" : host.residency(id)),
    };
    const result = await purgeSessionDataWith(dynamicHost, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    expect(result.deleted).toEqual([{ sessionId: "sess_a", bytes: 15 }]);
    expect(result.kept).toEqual([{ sessionId: "sess_b", reason: "running" }]);
    expect(calls.some((call) => call.includes("sess_b"))).toBe(false);
  });

  it("keeps the referenced source when its referrer candidate fails to delete", async () => {
    // 上游同步审查 P2 回归：sess_b 引用 sess_a 的附件且删除失败（EBUSY）时，
    // sess_a 必须保留——附件不能先于引用方消失，否则保留会话留下永久悬挂引用。
    const { host, calls } = harness({
      referrers: { sess_a: ["sess_b"] },
      failFiles: ["sess_b"],
    });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    expect(result.failed).toEqual([{ sessionId: "sess_b", code: "EBUSY" }]);
    expect(result.kept).toEqual([{ sessionId: "sess_a", reason: "referenced" }]);
    expect(result.deleted).toEqual([]);
    expect(calls.some((call) => call.startsWith("files:sess_a"))).toBe(false);
    expect(calls).not.toContain("purge:sess_a");
  });

  it("treats a session that no longer exists as deleted, still clearing leftover files", async () => {
    const { host, calls } = harness();
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_gone"], directories: [] });
    expect(result.deleted).toEqual([{ sessionId: "sess_gone", bytes: 3 }]);
    expect(calls).toEqual(["files:sess_gone", "purge:sess_gone", "forget:sess_gone"]);
  });
});
