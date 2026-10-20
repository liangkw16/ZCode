import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

describe("settingService 路径 segment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("设置文件路径跟随 segment，未注入回落 .zcode", async () => {
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "/tmp/kcode-home");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const { resolveSettingsFilePath } = await import("../src/setting/settingService.js");
    expect(resolveSettingsFilePath()).toBe(join("/tmp/kcode-home", ".kcode", "v2", "setting.json"));
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/setting/settingService.js");
    expect(fallback.resolveSettingsFilePath()).toBe(join("/tmp/kcode-home", ".zcode", "v2", "setting.json"));
  });
});
