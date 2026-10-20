import { buildZCodeEndpointUrls, type ZCodeProductFlavor } from "@zcode/shared";

export interface WebRemoteControlEndpointOverrideInput {
  flavor: ZCodeProductFlavor;
  settingOrigin?: string | null;
  appVersion?: string;
}

export interface WebRemoteControlEndpointOverrideUrls {
  origin: string;
  relayWsUrl: string;
  remoteUrl: string;
}

/**
 * kcode 自用：`zcodeEndpointOrigin` setting 在 production 分支被上游忽略
 * （zcodeEndpoint.ts 只在 test 环境认 override），打包 KCode 也无法注入 env。
 * 这里仅对远控三端点（relay HTTP origin / ws / 手机页 URL）放行该 setting，
 * 遥测、帮助配置、插件市场等其余流量仍走官方域。
 */
export function resolveWebRemoteControlEndpointOverrideUrls(
  input: WebRemoteControlEndpointOverrideInput,
): WebRemoteControlEndpointOverrideUrls | null {
  if (input.flavor !== "kcode") return null;
  const settingOrigin = input.settingOrigin?.trim();
  if (!settingOrigin) return null;
  try {
    const urls = buildZCodeEndpointUrls(settingOrigin, { appVersion: input.appVersion });
    return { origin: urls.origin, relayWsUrl: urls.relayWsUrl, remoteUrl: urls.remoteUrl };
  } catch {
    // setting 键已有 zod 清洗（normalizeZCodeEndpointOrigin），此处兜底非法值：
    // 忽略覆盖并回退官方端点，不能让坏 setting 拖垮远控启动。
    return null;
  }
}

export interface WebRemoteControlSelfHostQrKeyInput {
  flavor: ZCodeProductFlavor;
  settingOrigin?: string | null;
  settingKey?: string | null;
  finalRemoteUrl: string;
  appVersion?: string;
}

/**
 * kcode 自托管：判定本次 QR/复制链接是否携带 relay 密钥。门控落在最终手机页 URL——
 * `ZCODE_WEB_REMOTE_CONTROL_URL` 等 env 覆盖可能把 remoteUrl 换成其它域，此时密钥
 * 一律不注入，防止泄进官方域二维码。origin 不匹配 / 非 kcode / key 空 → null。
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
