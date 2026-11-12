import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

describe("exportLogs 数据目录 segment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("全局 CLI 目录与 CUA run 目录跟随 segment，未注入回落 .zcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const mod = await import("../src/main/exportLogs.js");
    expect(mod.resolveGlobalZCodeCliDir()).toBe(join(homedir(), ".kcode", "cli"));
    expect(mod.resolveCuaRunDir()).toBe(join(homedir(), ".kcode", "computer-use", "run"));
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/main/exportLogs.js");
    expect(fallback.resolveGlobalZCodeCliDir()).toBe(join(homedir(), ".zcode", "cli"));
  });
});
