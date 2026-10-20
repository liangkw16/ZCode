import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractBootstrapDataBaseDir,
  resolveBootstrapSettingsFile,
} from "../src/main/desktopDataBaseDirBootstrap.js";

describe("desktopDataBaseDirBootstrap", () => {
  it("应从 bootstrap setting 中提取并裁剪 dataBaseDir", () => {
    expect(
      extractBootstrapDataBaseDir({
        dataBaseDir: "  /tmp/zcode-data  ",
      }),
    ).toBe("/tmp/zcode-data");
  });

  it("应忽略无效的 bootstrap 配置", () => {
    expect(extractBootstrapDataBaseDir(null)).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: "" })).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: 123 })).toBeNull();
  });

  it("应拼出默认 bootstrap setting 路径", () => {
    const result = resolveBootstrapSettingsFile("/Users/tester");
    // Windows 下 path.join 使用反斜杠，统一为正斜杠后再比较
    expect(result.replace(/\\/g, "/")).toBe(
      "/Users/tester/.zcode/v2/setting.json",
    );
  });
});

describe("desktopDataBaseDirBootstrap segment（KCode 镜像根）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bootstrap 设置文件跟随 segment，未注入回落 .zcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const kcode = await import("../src/main/desktopDataBaseDirBootstrap.js");
    expect(kcode.resolveBootstrapSettingsFile("/tmp/home").replace(/\\/g, "/")).toBe(
      "/tmp/home/.kcode/v2/setting.json",
    );
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/main/desktopDataBaseDirBootstrap.js");
    expect(fallback.resolveBootstrapSettingsFile("/tmp/home").replace(/\\/g, "/")).toBe(
      "/tmp/home/.zcode/v2/setting.json",
    );
  });
});
