import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { type WebRemoteControlRelayV2OutgoingData } from "@zcode/shared/web-remote-relay";

export type WebRemoteControlPayloadSendResult =
  | { kind: "sent"; bytes: number }
  | { kind: "unavailable" }
  | { kind: "oversize"; bytes: number; maxBytes: number };

export interface SerializedWebRemoteControlRelayPayload {
  readonly message: Omit<WebRemoteControlRelayV2OutgoingData, "payload"> & {
    payload: WebRemoteControlAppPayload;
  };
  readonly json: string;
  readonly bytes: number;
}

/**
 * 为同一个 immutable app payload 固定唯一 final relay JSON。
 *
 * Bugfix：旧路径在 meter 与 send 时分别调用 Date.now()/JSON.stringify，导致 replay accounting
 * 记录的并非 WebSocket 实际写入 bytes。WeakMap 让 cache 生命周期跟随 adapter 持有的 frame，
 * cumulative ACK 释放 frame 后即可被 GC，不形成第二个 replay owner。
 * 多 terminal 路由：target_terminal_id 是 final JSON 的一部分，参与缓存 key 与字节数。
 */
export class WebRemoteControlRelayPayloadSerializer {
  private readonly cache = new WeakMap<
    object,
    Map<string, SerializedWebRemoteControlRelayPayload>
  >();

  prepare(
    payload: WebRemoteControlAppPayload,
    clientTimestamp = Math.floor(Date.now() / 1000),
    targetTerminalId?: string,
  ): SerializedWebRemoteControlRelayPayload {
    const cacheKey = targetTerminalId ?? "";
    const cached = this.cache.get(payload)?.get(cacheKey);
    if (cached) return cached;
    const message: Omit<WebRemoteControlRelayV2OutgoingData, "payload"> & {
      payload: WebRemoteControlAppPayload;
    } = {
      type: "data",
      payload,
      client_ts: clientTimestamp,
      ...(targetTerminalId ? { target_terminal_id: targetTerminalId } : {}),
    };
    const json = JSON.stringify(message);
    const prepared = Object.freeze({
      message,
      json,
      bytes: new TextEncoder().encode(json).byteLength,
    });
    let byTarget = this.cache.get(payload);
    if (!byTarget) {
      byTarget = new Map();
      this.cache.set(payload, byTarget);
    }
    byTarget.set(cacheKey, prepared);
    return prepared;
  }

  isOversize(prepared: SerializedWebRemoteControlRelayPayload): boolean {
    return prepared.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;
  }
}
