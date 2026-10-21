import type {
  WebRemoteControlRelayV2Device,
  WebRemoteControlRelayV2Meta,
  WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";

export type {
  WebRemoteControlRelayV2Device,
  WebRemoteControlRelayV2Meta,
  WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";

/** 进程配置；secret 必填，其余有默认值。 */
export interface SelfHostRelayConfig {
  host: string;
  port: number;
  secret: string;
  /** 设备表 JSON 落盘路径；缺省不持久化（重启丢 SID，桌面会自动重注册）。 */
  devicesFile?: string;
  /** 手机页静态目录；提供后服务托管 `/remote/v4` 前缀。 */
  staticRoot?: string;
}

export interface SelfHostRelayRuntime {
  port: number;
  close(): Promise<void>;
}

/** 设备/一次性 token/连接 owner 的唯一状态所有者；owner 以引用身份比对。 */
export interface SelfHostRelayStore {
  registerDevice(deviceMid: string, nowMs: number): { deviceSid: string; createdAt: number };
  listDevices(nowMs: number): WebRemoteControlRelayV2Device[];
  deleteDevice(deviceSid: string): "deleted" | "missing" | "device-online";
  issueToken(role: WebRemoteControlRelayV2Role, token: string, nowMs: number): void;
  consumeToken(token: string, nowMs: number): WebRemoteControlRelayV2Role | null;
  /** 设备不存在返回 null；否则登记 device owner 并返回被替换的旧 owner 引用。 */
  claimDevice(
    deviceSid: string,
    meta: WebRemoteControlRelayV2Meta,
    owner: unknown,
  ): { kicked: unknown | null } | null;
  /** 只在 owner 引用与当前一致时释放；释放时清空该 SID 的全部 terminal 槽位并返回其引用。 */
  releaseDevice(
    deviceSid: string,
    owner: unknown,
  ): { released: boolean; terminals: { terminalId: string; owner: unknown }[] };
  getDeviceOwner(
    deviceSid: string,
  ): { owner: unknown; meta: WebRemoteControlRelayV2Meta } | undefined;
  /** 设备不存在返回 null；同 terminalId 替换旧 owner（kicked），不同 id 共存。 */
  claimTerminal(
    deviceSid: string,
    terminalId: string,
    meta: WebRemoteControlRelayV2Meta,
    owner: unknown,
  ): { kicked: unknown | null; terminalIds: string[] } | null;
  /** 只在 owner 引用一致时移除；返回剩余 id 列表（按插入顺序）。 */
  releaseTerminal(
    deviceSid: string,
    terminalId: string,
    owner: unknown,
  ): { released: boolean; terminalIds: string[] };
  getTerminalOwner(
    deviceSid: string,
    terminalId: string,
  ): { owner: unknown; meta: WebRemoteControlRelayV2Meta } | undefined;
  listTerminalIds(deviceSid: string): string[];
  serializeDevices(): { version: 1; devices: { deviceSid: string; deviceMid: string; createdAt: number }[] };
  /** 恢复持久化设备表；返回恢复条数，非法输入返回 0。 */
  restoreDevices(data: unknown): number;
  setDevicesChangeListener(listener: () => void): void;
}
