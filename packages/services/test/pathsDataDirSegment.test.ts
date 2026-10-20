import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

async function importFreshPaths() {
  vi.resetModules();
  return await import("../src/paths.js");
}

describe("data dir segment（KCode 镜像根）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("注入 .kcode 时全局根镜像为 {base}/.kcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", "/tmp/kcode-base");
    const paths = await importFreshPaths();
    expect(paths.getZCodeDataRootDir()).toBe(join("/tmp/kcode-base", ".kcode"));
    expect(paths.getAppConfigDir()).toBe(join("/tmp/kcode-base", ".kcode", "v2"));
    expect(paths.getConversationWorkspaceDir()).toBe(join("/tmp/kcode-base", ".kcode", "workspace", "default"));
    expect(paths.getProviderWorkspaceConfigDir()).toBe(join("/tmp/kcode-base", ".kcode", "cli"));
  });

  it("未注入 segment 时保持 .zcode（默认构建零变化）", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.stubEnv("ZCODE_DATA_BASE_DIR", "/tmp/kcode-base");
    const paths = await importFreshPaths();
    expect(paths.getZCodeDataRootDir()).toBe(join("/tmp/kcode-base", ".zcode"));
    expect(paths.getProviderWorkspaceConfigDir()).toBe(join("/tmp/kcode-base", ".zcode", "cli"));
  });
});
