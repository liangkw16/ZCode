import { ZAI_PROVIDER_ID, type WebRemoteControlFailure } from "@zcode/shared";
import type { WebAuthService } from "#src/auth/webAuthService.js";

export type WebRemoteControlAuthPort = Pick<
  WebAuthService,
  "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout"
>;

export interface SelfHostBuildEnv {
  readonly VITE_ZCODE_REMOTE_SELF_HOSTED?: string;
}

export const SELF_HOST_KEY_STORAGE_KEY = "zcode-self-host-key";

export function isSelfHostRemoteBuild(env: SelfHostBuildEnv): boolean {
  return !!env.VITE_ZCODE_REMOTE_SELF_HOSTED?.trim();
}

/**
 * 密钥经书签 URL 的 `#k=` fragment 首次分发（fragment 不发往服务端），解析后持久化到
 * 同源 localStorage 并由调用方摘除 fragment；之后 QR 直连（无 fragment）凭 storage 工作。
 * 构建产物不携带密钥——公开静态资源不得包含任何授权凭据。
 */
export function readSelfHostKey(input: {
  hash: string;
  storage: Pick<Storage, "getItem" | "setItem">;
}): string | null {
  const params = new URLSearchParams(input.hash.replace(/^#/, ""));
  const fromHash = params.get("k")?.trim();
  if (fromHash) {
    try {
      input.storage.setItem(SELF_HOST_KEY_STORAGE_KEY, fromHash);
    } catch {
      // iOS 私密模式可能禁写存储：本次会话仍返回密钥，仅丢失持久化。
    }
    return fromHash;
  }
  try {
    return input.storage.getItem(SELF_HOST_KEY_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 自托管免登录：auth 端口以手机本地密钥充当 JWT，登录页/OAuth 回调在该部署不可达；
 * 密钥缺失或失效（relay 401）只能落服务不可用失败页，不得引导用户去真实 OAuth。
 */
export function createSelfHostAuth(
  key: string | null,
  onFailure: (failure: WebRemoteControlFailure) => void,
): WebRemoteControlAuthPort {
  return {
    getZCodeJwtToken: () => key,
    getActiveAccount: () => (key ? { displayName: "Self-host", provider: ZAI_PROVIDER_ID } : null),
    startLogin: () => onFailure({ reason: "relay-unavailable" }),
    logout: () => {
      onFailure({ reason: "relay-unavailable" });
      return Promise.resolve();
    },
  };
}
