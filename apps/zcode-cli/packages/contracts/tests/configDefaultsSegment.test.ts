import { afterEach, describe, expect, it, vi } from "vitest";

describe("CLI 运行时默认配置 segment（终审 P1 回归）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("注入 .kcode 时 storage 默认与 db 默认跟随镜像根", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const { DefaultRuntimeConfig } = await import("../src/config/index.js");
    expect(DefaultRuntimeConfig.storage.dir).toBe("~/.kcode");
    expect(DefaultRuntimeConfig.storage.sessionDbPath).toBe("~/.kcode/cli/db/db.sqlite");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/config/index.js");
    expect(fallback.DefaultRuntimeConfig.storage.dir).toBe("~/.zcode");
    expect(fallback.DefaultRuntimeConfig.storage.sessionDbPath).toBe("~/.zcode/cli/db/db.sqlite");
  });
});
