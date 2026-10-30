import type {
  WebRemoteControlDeviceListView,
  WebRemoteControlEntryConnection,
  WebRemoteControlEntryOptions,
  WebRemoteControlDeviceGroup,
} from "#src/web-remote-control/contract.js";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import {
  parseWebRemoteControlExternalQrParams,
  type WebRemoteControlFailure,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import { groupWebRemoteControlDevices } from "#src/web-remote-control/domain/webRemoteControlDeviceGroups.js";
import {
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/app/webRemoteControlKnownDevices.js";

export function isWebRemoteControlOAuthCallback(url: URL): boolean {
  return (
    ["/remote/v4", "/remote/v4/"].includes(url.pathname) &&
    url.searchParams.has("state") &&
    // BigModel 使用 authCode；必须先进入既有回调校验，不能落回未登录门禁。
    (url.searchParams.has("code") ||
      url.searchParams.has("authCode") ||
      url.searchParams.has("error"))
  );
}

const LAST_DEVICE_KEY = "zcode-web-remote-last-device-sid";
const LAST_DEVICE_MID_KEY = "zcode-web-remote-last-device-mid";

/**
 * 最近设备的自动落点：最近 SID 在线优先；否则同一台电脑（最近 MID）恰好一个在线 SID 时接上它。
 * 桌面重新注册会换 SID 并尽力删除旧 SID，因此最近 MID 缺失时只能从列表里旧 SID 的离线记录取。
 * 同 MID 多个在线 SID 时不猜测目标，交给用户在列表中选择。
 */
function resolveAutoConnectSid(
  records: readonly WebRemoteControlRelayV2Device[],
  groups: readonly WebRemoteControlDeviceGroup[],
  lastSid: string | null,
  lastMid: string | null,
): string | undefined {
  if (!lastSid && !lastMid) return undefined;
  const lastRecord = lastSid
    ? records.find((record) => record.device_sid === lastSid)
    : undefined;
  if (lastRecord?.online) return lastRecord.device_sid;
  const mid = lastMid || lastRecord?.device_mid;
  const connections =
    groups.find((group) => group.deviceMid === mid)?.onlineConnections ?? [];
  return connections.length === 1 ? connections[0]?.device_sid : undefined;
}

/** 这两类失败说明当前 SID 已接不上桌面，可按 MID 接续；其余失败（含 session-conflict）保持原行为。 */
const LOST_TARGET_FAILURES: ReadonlySet<WebRemoteControlFailure["reason"]> =
  new Set(["device-not-owned", "desktop-disconnected"]);

/** 只负责连接前的 admission；配对后的 workspace/恢复仍归既有 bootstrap。 */
export class WebRemoteControlEntry {
  private scope = new AbortController();
  private list:
    | {
        view: WebRemoteControlDeviceListView;
        unsubscribe: () => void;
        request?: Promise<void>;
        lastSid: string | null;
        lastMid: string | null;
        acceptedJwt?: string;
      }
    | undefined;
  /** 最近一次成功的在线设备快照；selectDevice 在列表重建/竞态窗口用它兜底。 */
  private lastOnlineDevices: WebRemoteControlRelayV2Device[] | undefined;

  constructor(private readonly options: WebRemoteControlEntryOptions) {}

  dispose(): void {
    this.scope.abort();
    this.list?.unsubscribe();
    this.list = undefined;
  }

  private reset(): void {
    this.dispose();
    this.scope = new AbortController();
  }

  async start(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    if (isWebRemoteControlOAuthCallback(url)) {
      this.options.onView({ kind: "callback" });
      return;
    }
    if (!this.options.auth.getZCodeJwtToken()) {
      this.options.onView({ kind: "login" });
      return;
    }
    const params = parseWebRemoteControlExternalQrParams(url.searchParams);
    if (!params) {
      this.options.onView({
        kind: "failure",
        failure: { reason: "invalid-mobile-connection" },
      });
      return;
    }
    if (!params.deviceSid) {
      await this.openDevices(true);
      return;
    }
    this.connect({ ...params, deviceSid: params.deviceSid });
  }

  private async openDevices(autoConnect: boolean): Promise<void> {
    this.reset();
    let lastSid: string | null = null;
    let lastMid: string | null = null;
    try {
      if (autoConnect) {
        lastSid = this.options.storage.getItem(LAST_DEVICE_KEY);
        lastMid = this.options.storage.getItem(LAST_DEVICE_MID_KEY);
      }
    } catch {
      // iOS 私密模式等环境可能禁用存储；最近设备只是偏好，不阻断入口。
    }
    const account = this.options.auth.getActiveAccount() ?? undefined;
    this.list = {
      view: {
        kind: "devices",
        devices: [],
        loading: false,
        error: false,
        ...(account ? { account } : {}),
      },
      unsubscribe: this.options.subscribeVisible(() => {
        void this.refreshDevices();
      }),
      lastSid,
      lastMid,
    };
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<void> {
    const list = this.list;
    if (!list) return;
    if (list.request) return list.request;
    const jwt = this.options.auth.getZCodeJwtToken();
    if (!jwt) return this.switchAccount();
    if (list.acceptedJwt && list.acceptedJwt !== jwt) return this.start();
    const { signal } = this.scope;
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    list.request = (async () => {
      try {
        const devices = await this.options.devices(jwt, signal);
        if (signal.aborted) return;
        // 账号变更后的响应不能为新账号提供设备或自动连接依据。
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        list.acceptedJwt = jwt;
        // 先读缓存补全离线记录的名字/平台，再把本次在线记录写回；它们只是展示偏好，不进入 admission。
        const knownDevices = readKnownDevices(this.options.storage);
        const groups = groupWebRemoteControlDevices(
          devices,
          this.options.locale,
          knownDevices,
        );
        rememberKnownDevices(this.options.storage, knownDevices, groups);
        list.view = {
          ...list.view,
          devices: groups,
          loading: false,
          error: false,
        };
        // 成功快照（仅在线记录）供 selectDevice 竞态兜底：列表重建窗口（reset 后 devices
        // 为空）里点击不应静默失效；离线记录不得进入兜底，避免连上已下线的 SID。
        this.lastOnlineDevices = devices.filter((device) => device.online);
        const autoSid = resolveAutoConnectSid(
          devices,
          groups,
          list.lastSid,
          list.lastMid,
        );
        // 自动落点只消费首次成功的列表；后续刷新不能打断用户选择。
        list.lastSid = null;
        list.lastMid = null;
        if (autoSid) this.selectDevice(autoSid);
        else this.options.onView(list.view);
      } catch (error) {
        if (signal.aborted) return;
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        if (
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          await this.switchAccount();
          return;
        }
        list.view = { ...list.view, loading: false, error: true };
        this.options.onView(list.view);
      } finally {
        list.request = undefined;
      }
    })();
    return list.request;
  }

  selectDevice(sid: string, viaRefresh = false): void {
    // 连接已开始（reset 清空列表）后的重复点击直接忽略，不能重启入口。
    if (!this.list) return;
    if (
      this.list.acceptedJwt &&
      this.list.acceptedJwt !== this.options.auth.getZCodeJwtToken()
    ) {
      void this.start();
      return;
    }
    // loading/error 期间的旧列表数据不可信（"禁用旧列表"语义保留）：不直接连接，
    // 而是自动刷新一次，只有新鲜数据确认在线才放行，避免用户点击被静默吞掉。
    const trustworthy = !this.list.view.loading && !this.list.view.error;
    const groups = this.list.view.devices;
    const device = trustworthy
      ? groups.length
        ? groups
            .flatMap((group) => group.onlineConnections)
            .find((item) => item.device_sid === sid)
        : this.lastOnlineDevices?.find((item) => item.device_sid === sid)
      : undefined;
    if (device) {
      this.admit(device, true);
      return;
    }
    // Bug 原因：列表处于 loading/error 或 reset 重建窗口（devices 为空）时旧逻辑直接
    // return，点击无任何反馈；设备列表刷新一旦偶发失败（限流/网络抖动），之后每次
    // 点击都无效，页面看似正常却进不去（IAB 真机验收实测复现）。仅在数据不可信或
    // 为空的窗口自动刷新重试一次；可信数据里确实离线的 SID 保持静默（旧语义）。
    if (!viaRefresh && (!trustworthy || !groups.length)) {
      void this.refreshDevices().then(() => this.selectDevice(sid, true));
    }
  }

  /** 手动选择、最近设备与旧 SID 接续共用的 admission：回写 URL 与最近设备后走既有建连路径。 */
  private admit(
    device: WebRemoteControlRelayV2Device,
    canResolveLostTarget: boolean,
  ): void {
    const url = new URL(this.options.getHref());
    url.searchParams.set("sid", device.device_sid);
    url.searchParams.set("mid", device.device_mid);
    const name = device.meta.name?.trim();
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    this.options.replaceHref(url.href);
    this.rememberDevice(device.device_sid, device.device_mid);
    this.connect(
      {
        deviceSid: device.device_sid,
        deviceMid: device.device_mid,
        deviceName: name || undefined,
        appVersion: url.searchParams.get("app_version") || undefined,
      },
      canResolveLostTarget,
    );
  }

  /**
   * Bugfix: 桌面收到 AUTH_FAILED 后会重新注册，同一台电脑（MID）换了新 SID；旧链接或已配对页面仍带旧 SID，
   * 旧实现只显示失败页，用户要手动“选择其他设备”或重新扫码。这里复用无 SID 入口的最近设备落点规则，
   * 用当前账号设备列表查一次：同 MID 恰好一个其他在线 SID 才接续，其余情况仍显示原失败页。
   */
  private async resolveLostTarget(
    params: WebRemoteControlEntryConnection["params"],
    failure: WebRemoteControlFailure,
  ): Promise<void> {
    this.reset();
    const { signal } = this.scope;
    const jwt = this.options.auth.getZCodeJwtToken();
    if (!jwt) return this.switchAccount();
    try {
      const devices = await this.options.devices(jwt, signal);
      if (signal.aborted) return;
      // 与列表一致：账号变更后的响应不能作为接续依据。
      if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
      const groups = groupWebRemoteControlDevices(
        devices,
        this.options.locale,
        readKnownDevices(this.options.storage),
      );
      const sid = resolveAutoConnectSid(
        devices,
        groups,
        params.deviceSid,
        params.deviceMid ?? null,
      );
      const device =
        sid && sid !== params.deviceSid
          ? groups
              .flatMap((group) => group.onlineConnections)
              .find((item) => item.device_sid === sid)
          : undefined;
      if (device) return this.admit(device, false);
    } catch (error) {
      if (signal.aborted) return;
      if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
      if (
        error instanceof WebRemoteControlV2ConnectionError &&
        error.reason === "auth-required"
      )
        return this.switchAccount();
    }
    this.options.onView({ kind: "failure", failure });
  }

  async chooseOtherDevice(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    for (const key of ["sid", "mid", "name", "hash", "t"])
      url.searchParams.delete(key);
    this.options.replaceHref(url.href);
    await this.openDevices(false);
  }

  private rememberDevice(sid: string, mid: string | undefined): void {
    try {
      this.options.storage.setItem(LAST_DEVICE_KEY, sid);
      if (mid) this.options.storage.setItem(LAST_DEVICE_MID_KEY, mid);
    } catch {
      // 偏好持久化失败不影响连接，也不修改按 SID 隔离的业务状态。
    }
  }

  private connect(
    params: WebRemoteControlEntryConnection["params"],
    canResolveLostTarget = true,
  ): void {
    this.reset();
    const { signal } = this.scope;
    // 接续出的连接配对前不能再接续，避免新目标立即失败时在 SID 间循环；配对成功后恢复。
    let resolveLostTarget = canResolveLostTarget;
    this.options.connect({
      params,
      signal,
      getToken: async (tokenSignal) => {
        const jwt = this.options.auth.getZCodeJwtToken();
        if (!jwt) throw new WebRemoteControlV2ConnectionError("auth-required");
        try {
          return await this.options.token(jwt, tokenSignal);
        } catch (error) {
          // Bugfix: 401 只否定这次请求用的 JWT。请求在途时其他标签页写入了新 JWT，旧实现仍按 401
          // 登出，把新登录一起清掉并回登录页；这里改为可重试，transport 下一轮读取新 JWT 重新申请。
          const current = this.options.auth.getZCodeJwtToken();
          if (
            error instanceof WebRemoteControlV2ConnectionError &&
            error.reason === "auth-required" &&
            current &&
            current !== jwt
          )
            throw new WebRemoteControlV2ConnectionError(
              "relay-unavailable",
              true,
            );
          throw error;
        }
      },
      onPaired: () => {
        if (signal.aborted) return;
        resolveLostTarget = true;
        this.rememberDevice(params.deviceSid, params.deviceMid);
      },
      onFailure: (failure) => {
        if (signal.aborted) return;
        if (failure.reason === "auth-required") void this.switchAccount();
        else if (resolveLostTarget && LOST_TARGET_FAILURES.has(failure.reason))
          void this.resolveLostTarget(params, failure);
        else this.options.onView({ kind: "failure", failure });
      },
    });
  }

  startLogin(provider?: WebOAuthProviderId): void {
    this.options.auth.startLogin({
      ...this.options.loginOptions,
      ...(provider ? { provider } : {}),
      appReturnTo: this.options.getHref(),
    });
  }

  async switchAccount(): Promise<void> {
    this.reset();
    const { signal } = this.scope;
    await this.options.auth.logout();
    if (!signal.aborted) this.options.onView({ kind: "login" });
  }
}
