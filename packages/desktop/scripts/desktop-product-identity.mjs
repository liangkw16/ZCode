/**
 * 构建期开关：为真时安装包使用 Preview 身份，而后端环境仍由 `ZCODE_ENV` 单独决定。
 * 典型用法是 `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1`，得到一个连接生产后端、
 * 可与正式版并排安装的 `ZCode Preview`。
 */
export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

/**
 * 构建期开关：为真时安装包使用 KCode 自用身份（个人 fork 的并排安装档）。
 * 典型用法是 `ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1`，得到一个连接生产后端、
 * 复用 Preview 全套隔离机制（appId/userData/Helper variant）但命名为 `KCode` 的安装包。
 */
export const ZCODE_KCODE_IDENTITY_ENV = "ZCODE_KCODE_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.zcode.app",
  productName: "ZCode",
  linuxExecutableName: "zcode",
  linuxPackageName: "zcode",
  cuaHelperInstallVariant: null,
  macIconPath: "build/icon.icns",
  resourceIconPath: "build/icon.png",
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.zcode.app.preview",
  productName: "ZCode Preview",
  linuxExecutableName: "zcode-preview",
  linuxPackageName: "zcode-preview",
  cuaHelperInstallVariant: "preview",
  macIconPath: "build/icon.icns",
  resourceIconPath: "build/icon.png",
});

const KCODE_IDENTITY = Object.freeze({
  flavor: "kcode",
  appId: "dev.zcode.app.kcode",
  productName: "KCode",
  linuxExecutableName: "kcode",
  linuxPackageName: "kcode",
  cuaHelperInstallVariant: "kcode",
  // KCode 用专属图标（靛蓝渐变 + 白色 K），与并排安装的 ZCode 在 Dock/启动台一眼区分；
  // production/preview 继续共用默认 ZCode 图标，上游构建零变化。路径相对 desktop 包根。
  macIconPath: "build/kcode/icon.icns",
  resourceIconPath: "build/kcode/icon.png",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
  kcode: KCODE_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * 开关只有一种开启拼写 `1`（`0` / 空 = 关闭），与 CI workflow 规则和 release 门的
 * `$ZCODE_PREVIEW_IDENTITY == "1"` 精确比较保持同一套语义。其它拼写在构建期直接失败，
 * 避免 `true` 之类在 YAML 路由层漏匹配、却在脚本层被当成开启，把 Preview 包打进生产验收目录。
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * 与 Preview 开关同一套严格 1/0 语义：KCode 是自用并排安装档，误拼写必须在构建期失败，
 * 避免半套身份（例如只改了 appId 却没改 productName）打进产物。
 */
export function isKcodeIdentityRequested(env = process.env) {
  const value = env[ZCODE_KCODE_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_KCODE_IDENTITY_ENV}=${env[ZCODE_KCODE_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * 产品身份（flavor）与后端环境（`ZCODE_ENV`）是两个轴：
 * - `ZCODE_ENV=test` 一律是 Preview，测试后端不能顶着正式 `ZCode` 身份覆盖用户的正式安装；
 * - `ZCODE_ENV=production` 默认是正式身份，显式 `ZCODE_PREVIEW_IDENTITY=1` 时改用 Preview 身份；
 * - `ZCODE_KCODE_IDENTITY=1` 优先级最高，得到自用 KCode 身份（与 Preview 同构的隔离档）。
 * 未知 `ZCODE_ENV` 继续按 test 处理，和共享层 normalizeZCodeEnv 的 fail-safe 默认值一致。
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isKcodeIdentityRequested(env)) {
    return "kcode";
  }
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * 全局数据目录 segment：决定 `~/.zcode` 与 `~/.kcode` 镜像根。默认（含 preview）一律
 * `.zcode`，只有 kcode 自用档改用 `.kcode`，保证上游默认构建零变化。tsup/vite/agent
 * 构建统一从这里取值折叠成编译期常量，是唯一事实源。
 */
export function resolveDesktopDataDirSegment(env = process.env) {
  return resolveDesktopProductFlavor(env) === "kcode" ? ".kcode" : ".zcode";
}

/**
 * 产物文件名后缀标记的是后端环境而不是身份：`_TEST` 只出现在测试后端的安装包上。
 * 生产后端的 Preview 包靠 productName（`ZCode Preview-<version>-...`）与正式包区分。
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * 返回 Windows Shell 使用的 AppUserModelId。
 *
 * 打包态必须复用 electron-builder 的 appId，否则快捷方式里的 AUMID、开始菜单索引
 * 和运行中的 Electron 进程会被 Windows 视为三个不同的应用。开发态继续保留旧身份，
 * 避免本地调试快捷方式和正式/Preview 安装包互相污染。
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    return "cn.aminer.zcode";
  }
  const normalizedFlavor = flavor === "production" ? "production" : flavor === "kcode" ? "kcode" : "preview";
  return desktopProductIdentities[normalizedFlavor].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
