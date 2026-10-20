import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  desktopProductIdentities,
  resolveDesktopArtifactSuffix,
  resolveDesktopDataDirSegment,
  resolveDesktopProductFlavor,
  resolveWindowsAppUserModelId,
  resolveWindowsAppUserModelIdForFlavor,
  resolveDesktopProductIdentity,
} from "../scripts/desktop-product-identity.mjs";

describe("desktop product identity", () => {
  it("根锁文件的发布版本与构建版本一致", () => {
    // 合并上游发布提交只对齐当前版本，不恢复上游旧版本，也不重算依赖锁。
    const readRootJson = (name: string) =>
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../../..", name), "utf8"));
    const version = readRootJson("package.json").version;
    const lock = readRootJson("package-lock.json");
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
  });

  it("ZCODE_ENV=test 使用可与生产版并排安装的 Preview 身份", () => {
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "test" })).toEqual({
      flavor: "preview",
      appId: "dev.zcode.app.preview",
      productName: "ZCode Preview",
      linuxExecutableName: "zcode-preview",
      linuxPackageName: "zcode-preview",
      cuaHelperInstallVariant: "preview",
    });
  });

  it("ZCODE_PREVIEW_IDENTITY=1 让生产后端的构建改用 Preview 身份", () => {
    // 身份与后端环境分轴：同一份 Preview 身份既可以连测试后端，也可以连生产后端。
    for (const flag of ["1", " 1 "]) {
      const env = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag };
      expect(resolveDesktopProductFlavor(env)).toBe("preview");
      expect(resolveDesktopProductIdentity(env)).toBe(desktopProductIdentities.preview);
    }
    for (const flag of ["", "0"]) {
      const env = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag };
      expect(resolveDesktopProductFlavor(env)).toBe("production");
    }
  });

  it("开关只认 1/0：其它拼写在构建期直接失败，不能在路由层漏匹配却在脚本层开启", () => {
    // CI workflow 规则与 release 门做 == "1" 精确比较；若脚本层再接受 true/yes/on，
    // `ZCODE_PREVIEW_IDENTITY=true` 会落入 @electron/dev 生产验收目录却打出 Preview 身份包。
    for (const flag of ["true", "yes", "on", "false", "no", "off", "2"]) {
      expect(() =>
        resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag }),
      ).toThrow(/expected 1 or 0/);
    }
  });

  it("测试后端永远是 Preview 身份，开关无法把它变成正式 ZCode", () => {
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_PREVIEW_IDENTITY: "0" })).toBe(
      "preview",
    );
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_PREVIEW_IDENTITY: "1" })).toBe(
      "preview",
    );
  });

  it("ZCODE_KCODE_IDENTITY=1 得到自用 KCode 身份，优先级高于 Preview 开关", () => {
    // KCode 是与 Preview 同构的并排安装档：独立 appId/productName/userData/Helper variant，
    // 但必须显式选择，普通构建（含生产后端）不受影响。
    const env = { ZCODE_ENV: "production", ZCODE_KCODE_IDENTITY: "1" };
    expect(resolveDesktopProductFlavor(env)).toBe("kcode");
    expect(resolveDesktopProductIdentity(env)).toEqual({
      flavor: "kcode",
      appId: "dev.zcode.app.kcode",
      productName: "KCode",
      linuxExecutableName: "kcode",
      linuxPackageName: "kcode",
      cuaHelperInstallVariant: "kcode",
    });
    expect(resolveDesktopProductIdentity(env)).toBe(desktopProductIdentities.kcode);
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "production" })).toBe("production");
    expect(
      resolveDesktopProductFlavor({
        ZCODE_ENV: "production",
        ZCODE_PREVIEW_IDENTITY: "1",
        ZCODE_KCODE_IDENTITY: "1",
      }),
    ).toBe("kcode");
    // 身份与后端环境分轴：测试后端 + KCode 开关仍是 KCode 身份。
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_KCODE_IDENTITY: "1" })).toBe(
      "kcode",
    );
  });

  it("KCode 开关与 Preview 开关共用严格 1/0 语义，误拼写必须构建期失败", () => {
    for (const flag of ["true", "yes", "on", "false", "no", "off", "2"]) {
      expect(() =>
        resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_KCODE_IDENTITY: flag }),
      ).toThrow(/expected 1 or 0/);
    }
    for (const flag of ["", "0"]) {
      expect(
        resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_KCODE_IDENTITY: flag }),
      ).toBe("production");
    }
  });

  it("产物后缀只标记后端环境，生产后端的 KCode 包靠 productName 区分", () => {
    expect(resolveDesktopArtifactSuffix({ ZCODE_ENV: "test" })).toBe("_TEST");
    expect(resolveDesktopArtifactSuffix({ ZCODE_ENV: "production" })).toBe("");
    expect(
      resolveDesktopArtifactSuffix({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe("");
    expect(
      resolveDesktopArtifactSuffix({ ZCODE_ENV: "production", ZCODE_KCODE_IDENTITY: "1" }),
    ).toBe("");
    expect(resolveDesktopArtifactSuffix({})).toBe("_TEST");
  });

  it("ZCODE_ENV=production 完整保留正式包身份", () => {
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "production" })).toBe(
      desktopProductIdentities.production,
    );
    expect(desktopProductIdentities.production).toEqual({
      flavor: "production",
      appId: "dev.zcode.app",
      productName: "ZCode",
      linuxExecutableName: "zcode",
      linuxPackageName: "zcode",
      cuaHelperInstallVariant: null,
    });
  });

  it("未注入或未知环境时不应误生成正式安装身份", () => {
    expect(resolveDesktopProductIdentity({}).flavor).toBe("preview");
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "staging" }).flavor).toBe("preview");
  });

  it("打包态 Windows AUMID 必须和 NSIS appId 保持一致", () => {
    expect(resolveWindowsAppUserModelId({ ZCODE_ENV: "production" })).toBe(
      desktopProductIdentities.production.appId,
    );
    expect(resolveWindowsAppUserModelId({ ZCODE_ENV: "test" })).toBe(
      desktopProductIdentities.preview.appId,
    );
    expect(
      resolveWindowsAppUserModelId({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe(desktopProductIdentities.preview.appId);
    // 主进程按编译期 flavor 取 AUMID，不依赖安装后机器上的环境变量。
    expect(resolveWindowsAppUserModelIdForFlavor("preview")).toBe(
      desktopProductIdentities.preview.appId,
    );
    expect(resolveWindowsAppUserModelIdForFlavor("production")).toBe(
      desktopProductIdentities.production.appId,
    );
    expect(resolveWindowsAppUserModelIdForFlavor("kcode")).toBe(
      desktopProductIdentities.kcode.appId,
    );
  });

  it("开发态继续使用独立 AUMID，避免污染打包版 Shell 身份", () => {
    expect(resolveWindowsAppUserModelId({}, { isPackaged: false })).toBe("cn.aminer.zcode");
  });

  it("数据目录 segment 跟随 flavor：kcode 用 .kcode，其余一律 .zcode", () => {
    expect(
      resolveDesktopDataDirSegment({ ZCODE_ENV: "production", ZCODE_KCODE_IDENTITY: "1" }),
    ).toBe(".kcode");
    expect(resolveDesktopDataDirSegment({ ZCODE_ENV: "production" })).toBe(".zcode");
    expect(
      resolveDesktopDataDirSegment({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe(".zcode");
    expect(resolveDesktopDataDirSegment({ ZCODE_ENV: "test" })).toBe(".zcode");
    expect(resolveDesktopDataDirSegment({})).toBe(".zcode");
  });
});
