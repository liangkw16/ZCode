declare const __ZCODE_DATA_DIR_SEGMENT__: string;

/**
 * 全局数据目录 segment（~/.zcode | ~/.kcode）。desktop agent bundle 构建时由
 * scripts/build-desktop-agent-cli.mjs 注入 define 折叠；独立 CLI/测试无 define 回落
 * .zcode。单一事实源是根仓 desktop-product-identity.mjs 的 resolveDesktopDataDirSegment。
 */
export const ZCODE_DATA_DIR_SEGMENT =
  (typeof __ZCODE_DATA_DIR_SEGMENT__ !== "undefined"
    ? __ZCODE_DATA_DIR_SEGMENT__
    : ".zcode") as ".zcode" | ".kcode";

export * from "./git-bash.js";
