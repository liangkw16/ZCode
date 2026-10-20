import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

describe("file-config 默认目录 segment（终审 P1 回归）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("默认配置文件路径跟随 segment", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const { getDefaultConfigPath } = await import("../src/config/file-config.adapter.js");
    expect(getDefaultConfigPath()).toBe(join(homedir(), ".kcode", "cli", "config.json"));
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/config/file-config.adapter.js");
    expect(fallback.getDefaultConfigPath()).toBe(join(homedir(), ".zcode", "cli", "config.json"));
  });
});
