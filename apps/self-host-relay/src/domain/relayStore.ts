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

/** 唯一状态所有者：设备表、一次性 token、device owner 与 terminal 集合；不持有 IO。 */
export class RelayStore implements SelfHostRelayStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly tokens = new Map<string, { role: "device" | "terminal"; expiresAt: number }>();
  private readonly deviceOwners = new Map<string, OwnerSlot>();
  private readonly terminalOwners = new Map<string, Map<string, OwnerSlot>>();
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
      const slot = this.deviceOwners.get(record.deviceSid);
      return {
        device_sid: record.deviceSid,
        device_mid: record.deviceMid,
        online: Boolean(slot),
        created_at: record.createdAt,
        meta: slot ? { ...slot.meta } : {},
      };
    });
  }

  deleteDevice(deviceSid: string): "deleted" | "missing" | "device-online" {
    if (this.deviceOwners.has(deviceSid)) return "device-online";
    if (!this.devices.delete(deviceSid)) return "missing";
    this.terminalOwners.delete(deviceSid);
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

  claimDevice(
    deviceSid: string,
    meta: WebRemoteControlRelayV2Device["meta"],
    owner: unknown,
  ): { kicked: unknown | null } | null {
    if (!this.devices.has(deviceSid)) return null;
    const kicked = this.deviceOwners.get(deviceSid)?.owner ?? null;
    this.deviceOwners.set(deviceSid, { owner, meta: { ...meta } });
    return { kicked };
  }

  releaseDevice(
    deviceSid: string,
    owner: unknown,
  ): { released: boolean; terminals: { terminalId: string; owner: unknown }[] } {
    const slot = this.deviceOwners.get(deviceSid);
    if (!slot || slot.owner !== owner) return { released: false, terminals: [] };
    this.deviceOwners.delete(deviceSid);
    // device 位换人后不能看到上一代残留 terminal：槽位整体清空，引用交还 gateway 关闭连接。
    const slots = this.terminalOwners.get(deviceSid);
    const terminals = slots
      ? [...slots].map(([terminalId, entry]) => ({ terminalId, owner: entry.owner }))
      : [];
    this.terminalOwners.delete(deviceSid);
    return { released: true, terminals };
  }

  getDeviceOwner(
    deviceSid: string,
  ): { owner: unknown; meta: WebRemoteControlRelayV2Device["meta"] } | undefined {
    const slot = this.deviceOwners.get(deviceSid);
    return slot ? { owner: slot.owner, meta: { ...slot.meta } } : undefined;
  }

  claimTerminal(
    deviceSid: string,
    terminalId: string,
    meta: WebRemoteControlRelayV2Device["meta"],
    owner: unknown,
  ): { kicked: unknown | null; terminalIds: string[] } | null {
    if (!this.devices.has(deviceSid)) return null;
    let slots = this.terminalOwners.get(deviceSid);
    if (!slots) {
      slots = new Map();
      this.terminalOwners.set(deviceSid, slots);
    }
    const kicked = slots.get(terminalId)?.owner ?? null;
    slots.set(terminalId, { owner, meta: { ...meta } });
    return { kicked, terminalIds: [...slots.keys()] };
  }

  releaseTerminal(
    deviceSid: string,
    terminalId: string,
    owner: unknown,
  ): { released: boolean; terminalIds: string[] } {
    const slots = this.terminalOwners.get(deviceSid);
    const slot = slots?.get(terminalId);
    // 被同 id 新连接替换后的迟到 close 不能移除新 owner（引用身份比对）。
    if (!slots || !slot || slot.owner !== owner) {
      return { released: false, terminalIds: slots ? [...slots.keys()] : [] };
    }
    slots.delete(terminalId);
    const terminalIds = [...slots.keys()];
    if (slots.size === 0) this.terminalOwners.delete(deviceSid);
    return { released: true, terminalIds };
  }

  getTerminalOwner(
    deviceSid: string,
    terminalId: string,
  ): { owner: unknown; meta: WebRemoteControlRelayV2Device["meta"] } | undefined {
    const slot = this.terminalOwners.get(deviceSid)?.get(terminalId);
    return slot ? { owner: slot.owner, meta: { ...slot.meta } } : undefined;
  }

  listTerminalIds(deviceSid: string): string[] {
    return [...(this.terminalOwners.get(deviceSid)?.keys() ?? [])];
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
