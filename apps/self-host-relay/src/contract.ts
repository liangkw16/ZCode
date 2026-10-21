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

/** 设备/一次性 token/device owner 的唯一状态所有者；owner 以引用身份比对。
 * terminal 集合端口见 wsGateway 的 SelfHostRelayTerminalStore（其唯一消费者）。 */
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
  serializeDevices(): { version: 1; devices: { deviceSid: string; deviceMid: string; createdAt: number }[] };
  /** 恢复持久化设备表；返回恢复条数，非法输入返回 0。 */
  restoreDevices(data: unknown): number;
  setDevicesChangeListener(listener: () => void): void;
}
