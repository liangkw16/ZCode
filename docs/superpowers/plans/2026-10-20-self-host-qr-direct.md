# 实施计划：自托管远控 QR / 复制链接直连（密钥随链接分发）

- 日期：2026-10-20
- Spec：`docs/superpowers/specs/2026-10-20-self-hosted-relay-design.md` 追记（二）
- 分支：kcode
- 分类：bounded（QR 生成、`#k=` 解析均为既有流程，本轮只补"密钥进链"一段）

## 全局约束

- TDD：每个任务先写 RED 测试再实现，GREEN 后才进下一任务。
- 密钥不进日志、不进提交、不进官方构建产物；任何输出不得打印 `zcodeRelaySelfHostKey` 值。
- production/preview 行为零变化：无 setting / 非 kcode / 端点未覆盖时，URL 与现状逐字节一致。
- 每个 RED/GREEN 结果如实记录；测试命令：`pnpm exec vitest run <file>`（仓库根）。
- 收尾必须跑 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，真实结果写进提交说明。

## Task 1：shared QR 构造器支持 `selfHostKey`

文件：`packages/shared/src/web-remote-control.ts`

```ts
export interface BuildWebRemoteControlExternalQrUrlOptions {
  baseUrl: string;
  deviceSid?: string;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
  // kcode 自托管：非空时把 relay 密钥放进 #k= fragment（fragment 不发往服务端），
  // 手机页 readSelfHostKey 解析后持久化并摘除。缺省必须保持无 hash 的现状。
  selfHostKey?: string | null;
}

// buildWebRemoteControlExternalQrUrl 末尾、return 之前：
const selfHostKey = selfHostKeyInput?.trim();
if (selfHostKey) {
  url.hash = `k=${encodeURIComponent(selfHostKey)}`;
}
```

注意：解构参数新增 `selfHostKey: selfHostKeyInput`（避免与 trim 后局部变量重名）。

测试：`packages/shared/test/webRemoteControlV2Qr.test.ts`（builder 既有测试所在文件，实现时若发现主战场在 `webRemoteControl.test.ts` 则放彼处并在此记录）：

1. RED→GREEN：`selfHostKey: "abc123"` → `url.hash === "#k=abc123"`，且 `sid/mid/name/app_version` query 不变。
2. RED→GREEN：不传 / 传 `null` / 传 `"  "` → `url.hash === ""`（现状）。
3. RED→GREEN：key 含需编码字符（如 `a b/c`）→ hash 中为 encodeURIComponent 结果。

## Task 2：settings 注册 `zcodeRelaySelfHostKey`

文件：`packages/shared/src/validationAppSettings.ts`（`zcodeEndpointOriginSchema` 旁，模式复用）

```ts
// kcode 自托管 relay 密钥：非法值整键丢弃而非拖垮 settings 读取（同 zcodeEndpointOrigin 策略）。
const zcodeRelaySelfHostKeySchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  // 密钥是部署方生成的随机串（当前为 64 hex）；超长值视为污染数据丢弃。
  if (!trimmed || trimmed.length > 512) {
    return undefined;
  }
  return trimmed;
}, z.string().optional());
```

- 主 schema（`zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional()` 同处）追加：`zcodeRelaySelfHostKey: zcodeRelaySelfHostKeySchema.optional()`。
- `AppSettings` 类型（实现时定位：同文件或其引用的 types）追加 `zcodeRelaySelfHostKey?: string;`。
- 不新增独立 sanitize 函数：preprocess 对非法值返回 undefined，`z.string().optional()` 解析为缺省即等价丢键。

测试（既有 settings 校验测试文件，实现时定位）：非字符串 / 空白 / 超长 → 键消失且其余字段保留；合法串 → trim 后保留。

## Task 3：desktop 门控纯函数 + manager 接线

### 3a. 门控纯函数（`packages/desktop/src/main/web-remote-relay/webRemoteControlEndpointOverride.ts` 追加）

```ts
export interface WebRemoteControlSelfHostQrKeyInput {
  flavor: ZCodeProductFlavor;
  settingOrigin?: string | null;
  settingKey?: string | null;
  finalRemoteUrl: string;
  appVersion?: string;
}

/**
 * kcode 自托管：判定本次 QR/复制链接是否携带 relay 密钥。门控落在最终手机页 URL——
 * ZCODE_WEB_REMOTE_CONTROL_URL 等 env 覆盖可能把 remoteUrl 换成其它域，此时密钥
 * 一律不注入（防止泄进官方域二维码）。origin 不匹配 / 非 kcode / key 空 → null。
 */
export function resolveWebRemoteControlSelfHostQrKey(
  input: WebRemoteControlSelfHostQrKeyInput,
): string | null {
  const key = input.settingKey?.trim();
  if (!key) return null;
  const override = resolveWebRemoteControlEndpointOverrideUrls({
    flavor: input.flavor,
    settingOrigin: input.settingOrigin,
    appVersion: input.appVersion,
  });
  if (!override) return null;
  try {
    if (new URL(input.finalRemoteUrl).origin !== override.origin) return null;
  } catch {
    return null;
  }
  return key;
}
```

### 3b. manager（`packages/desktop/src/main/webRemoteControlManager.ts`）

```ts
// WebRemoteControlManagerDependencies 追加：
// kcode 自托管：以"将要嵌入的最终手机页 URL"为参取回 relay 密钥；null/缺省 = 官方行为。
// 入参传最终 URL，让门控在 index 侧校验 origin，避免 env 覆盖后密钥泄往其它域。
getSelfHostQrKey?: (mobileRemoteControlUrl: string) => string | null | Promise<string | null>;

// createQrUrl 改签名（~L1466）：
function createQrUrl(
  deviceSid: string,
  mobileRemoteControlUrl: string,
  selfHostKey: string | null,
): string {
  return buildWebRemoteControlExternalQrUrl({
    baseUrl: mobileRemoteControlUrl,
    deviceSid,
    deviceMid: dependencies.deviceMid,
    deviceName: dependencies.deviceName,
    appVersion: dependencies.appVersion,
    selfHostKey,
  });
}

// 唯一调用点（~L1646）：
const selfHostKey =
  (await dependencies.getSelfHostQrKey?.(mobileRemoteControlUrl)) ?? null;
runtime.qrUrl = runtime.connectUrl = createQrUrl(deviceSid, mobileRemoteControlUrl, selfHostKey);
```

密钥不落日志：确认该路径无 `logger.*` 打印 URL（实现时 grep 复核 `connectUrl|qrUrl`）。

### 3c. index.ts 接线（`packages/desktop/src/main/index.ts` createWebRemoteControlManager deps）

```ts
getSelfHostQrKey: (mobileRemoteControlUrl) =>
  resolveWebRemoteControlSelfHostQrKey({
    flavor: ZCODE_PRODUCT_FLAVOR,
    settingOrigin: settingsCache.zcodeEndpointOrigin,
    settingKey: settingsCache.zcodeRelaySelfHostKey,
    finalRemoteUrl: mobileRemoteControlUrl,
    appVersion: webRemoteControlAppVersion,
  }),
```

（实现时 `settingsCache` 为读取 `mainSettingService.get()` 的 await 结果；注意该 dep 是同步签名时可直接返回，异步则包 async。）

### 3d. 测试

`packages/desktop/test/webRemoteControlEndpointOverride.test.ts` 追加（RED→GREEN）：

1. kcode + origin + key + finalRemoteUrl 同源（含路径 `http://39.105.89.226:8787/remote/v4?x=1`）→ 返回 key。
2. **跨域 env 覆盖组合**：finalRemoteUrl 指向官方域（`https://zcode.z.ai/remote/v4`）→ null。
3. flavor 非 kcode / key 空白 / finalRemoteUrl 非法串 → null。
4. settingOrigin 非法（resolver null）→ null。

`packages/desktop/test/webRemoteControlManagerV2.test.ts` 追加：

- fixture 增加可选参数 `selfHostKey?: string | null`：仅当显式传入时提供 `getSelfHostQrKey: (url) => (new URL(url).origin === relay.httpUrl ? selfHostKey : null)`（同时守护门控入参语义）。
- RED→GREEN：`selfHostKey: "test-secret"` → `result.qrUrl` 的 `hash === "#k=test-secret"`、query 与既有断言完全一致；`getStatus(1)` 的 connectUrl 同值。
- 既有测试"懒注册…返回无密钥V4二维码"追加断言 `url.hash === ""`（不注入 dep 的现状守护）。

## Task 4：部署物、重建与验收

1. `apps/self-host-relay/deploy/README.md`：密钥分发说明改为"KCode 设置 `zcodeRelaySelfHostKey` 后扫码直连；书签 `#k=` 保留为备用通道"。
2. 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm exec vitest run` 相关文件（shared 两处 + managerV2 + settings 校验）。
3. 重建 KCode（**本轮含源码改动，必须先重编 `out/` 再打包**，不得复用旧暂存）：
   1. `packages/desktop` 下以相同身份编译：`ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 npm_config_user_agent="pnpm/10.33.2" mise exec -- node ../../scripts/mise-run.mjs pnpm run build:no-runtime-assets`；
   2. 验证产物含本轮代码（`out/` 主进程 bundle 可 grep 到 `zcodeRelaySelfHostKey`）后再打包：`ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 npm_config_user_agent="pnpm/10.33.2" mise exec -- node ../../scripts/mise-run.mjs pnpm exec electron-builder --config electron-builder.config.js --mac zip`；
   3. 重装 `/Applications/KCode.app`。
4. 运行时密钥写入（不经转录）：`ssh alecs` 读 `/etc/self-host-relay.env` 的 SECRET，管道写 `~/.kcode/v2/setting.json` 的 `zcodeRelaySelfHostKey`（node 脚本原地改写，不回显）。
5. 真机验收 Q5：KCode 开远控 → 手机扫码 → 直接配对进入（用户执行）。
6. 提交 + `git push --no-verify origin kcode`。

## 审查关注（给 codex-review）

- 密钥泄漏面：官方构建（无 setting / 非 kcode）URL 必须逐字节不变；**最终手机页 URL origin ≠ 自建 origin（含 env 覆盖组合）时 key 不得进 URL**。
- `url.hash` 赋值与手机页 `URLSearchParams(hash.replace(/^#/,""))` 的往返一致性（含编码字符）。
- settings 清洗：坏值整键丢弃不得影响其余键；`AppSettings` 类型面（desktopCommandHandlers 的 Pick 泛型自动兼容）。
- manager 存量测试不变式：无 dep 时 qrUrl 断言不破坏。
- 重建链：源码改动必须先 `build:no-runtime-assets` 再 electron-builder，产物需验证含新代码。
- 上游零变化声明是否与改动面一致。

## 修订记录

- 2026-10-20 codex-review（spec+plan，83k tokens）2 项发现，均已修订：
  - P1 门控只查 setting origin，未防 `ZCODE_WEB_REMOTE_CONTROL_URL` env 覆盖后密钥泄往其它域 → 门控改为纯函数 `resolveWebRemoteControlSelfHostQrKey` 校验最终 URL origin，并补跨域回归测试。
  - P2 重建步骤复用旧 `out/` 暂存，本轮源码改动不会进包 → Task 4 改为先 `build:no-runtime-assets` 再打包，并加产物含新代码的验证步骤。
