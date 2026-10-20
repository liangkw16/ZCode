import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

const TOKEN_TTL_MS = 60_000;

interface DeviceRecord {
  deviceSid: string;
  deviceMid: string;
  createdAt: number;
}

interface OwnerSlot {
  owner: unknown;
  meta: WebRemoteControlRelayV2Device["meta"];
}

export interface RelayStoreOptions {
  newSid: () => string;
}

/** 唯一状态所有者：设备表、一次性 token、(sid, role) owner；不持有 IO。 */
export class RelayStore implements SelfHostRelayStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly tokens = new Map<string, { role: "device" | "terminal"; expiresAt: number }>();
  private readonly owners = new Map<string, Partial<Record<"device" | "terminal", OwnerSlot>>>();
  private devicesChangeListener: (() => void) | undefined;

  constructor(private readonly options: RelayStoreOptions) {}

  setDevicesChangeListener(listener: () => void): void {
    this.devicesChangeListener = listener;
  }

  private notifyDevicesChange(): void {
    this.devicesChangeListener?.();
  }

  registerDevice(deviceMid: string, nowMs: number): { deviceSid: string; createdAt: number } {
    const record = {
      deviceSid: this.options.newSid(),
      deviceMid,
      createdAt: Math.floor(nowMs / 1000),
    };
    this.devices.set(record.deviceSid, record);
    this.notifyDevicesChange();
    return { deviceSid: record.deviceSid, createdAt: record.createdAt };
  }

  listDevices(nowMs: number): WebRemoteControlRelayV2Device[] {
    void nowMs;
    return [...this.devices.values()].map((record) => {
      const slot = this.owners.get(record.deviceSid)?.device;
      return {
        device_sid: record.deviceSid,
        device_mid: record.deviceMid,
        online: !!slot,
        created_at: record.createdAt,
        meta: slot ? { ...slot.meta } : {},
      };
    });
  }

  deleteDevice(deviceSid: string): "deleted" | "missing" | "device-online" {
    if (this.owners.get(deviceSid)?.device) return "device-online";
    if (!this.devices.delete(deviceSid)) return "missing";
    this.notifyDevicesChange();
    return "deleted";
  }

  issueToken(role: "device" | "terminal", token: string, nowMs: number): void {
    // Bugfix：未消费的过期 token 只有 consumeToken 会删；公开 device token 端点可被
    // 任意 bearer 持续签发，导致表永久增长。每次签发顺带回收过期项（项数受限流约束）。
    for (const [key, entry] of this.tokens) {
      if (entry.expiresAt <= nowMs) this.tokens.delete(key);
    }
    this.tokens.set(token, { role, expiresAt: nowMs + TOKEN_TTL_MS });
  }

  consumeToken(token: string, nowMs: number): "device" | "terminal" | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    // 升级前原子消费：无论结果如何都移除，重连必须重新申请。
    this.tokens.delete(token);
    return entry.expiresAt > nowMs ? entry.role : null;
  }

  claimOwnership(
    deviceSid: string,
    role: "device" | "terminal",
    meta: WebRemoteControlRelayV2Device["meta"],
    owner: unknown,
  ): { kicked: unknown | null } | null {
    if (!this.devices.has(deviceSid)) return null;
    const roles = this.owners.get(deviceSid) ?? {};
    const kicked = roles[role]?.owner ?? null;
    roles[role] = { owner, meta: { ...meta } };
    this.owners.set(deviceSid, roles);
    return { kicked };
  }

  releaseOwnership(deviceSid: string, role: "device" | "terminal", owner: unknown): boolean {
    const roles = this.owners.get(deviceSid);
    // Bugfix：被替换连接的 close 晚于新认证完成，必须按 owner 引用身份释放，
    // 否则旧连接异步关闭会拆掉新 owner（契约：异步 close 不得移除新 owner）。
    if (!roles || roles[role]?.owner !== owner) return false;
    delete roles[role];
    if (!roles.device && !roles.terminal) this.owners.delete(deviceSid);
    return true;
  }

  getOwner(
    deviceSid: string,
    role: "device" | "terminal",
  ): { owner: unknown; meta: WebRemoteControlRelayV2Device["meta"] } | undefined {
    const slot = this.owners.get(deviceSid)?.[role];
    return slot ? { owner: slot.owner, meta: { ...slot.meta } } : undefined;
  }

  serializeDevices(): {
    version: 1;
    devices: { deviceSid: string; deviceMid: string; createdAt: number }[];
  } {
    return {
      version: 1,
      devices: [...this.devices.values()].map((record) => ({ ...record })),
    };
  }

  restoreDevices(data: unknown): number {
    if (!data || typeof data !== "object") return 0;
    const parsed = data as { version?: unknown; devices?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return 0;
    let restored = 0;
    for (const item of parsed.devices) {
      if (!item || typeof item !== "object") continue;
      const record = item as { deviceSid?: unknown; deviceMid?: unknown; createdAt?: unknown };
      if (
        typeof record.deviceSid !== "string" ||
        typeof record.deviceMid !== "string" ||
        typeof record.createdAt !== "number" ||
        !record.deviceSid.trim() ||
        !record.deviceMid.trim()
      ) {
        continue;
      }
      this.devices.set(record.deviceSid, {
        deviceSid: record.deviceSid,
        deviceMid: record.deviceMid,
        createdAt: record.createdAt,
      });
      restored += 1;
    }
    return restored;
  }
}
