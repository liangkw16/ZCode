import { describe, expect, it, vi } from "vitest";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { parseWebRemoteControlRelayV2OutgoingMessage } from "@zcode/shared/web-remote-relay";
import { WebRemoteControlRelayPayloadSerializer } from "../src/webRemoteControlRelayPayloadSerializer.js";

describe("WebRemoteControlRelayPayloadSerializer", () => {
  it("reuses the identical final JSON and byte count for one immutable raw payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const [payload] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });

    const first = serializer.prepare(payload, 100);
    const replay = serializer.prepare(payload, 200);

    expect(replay).toBe(first);
    expect(replay.json).toBe(first.json);
    expect(replay.message.client_ts).toBe(100);
    expect(replay.bytes).toBe(new TextEncoder().encode(replay.json).byteLength);
  });

  it("uses Unix seconds for the default V2 data timestamp", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_123);
    try {
      const prepared = new WebRemoteControlRelayPayloadSerializer().prepare({
        zcode_type: "bootstrap-request",
        requestId: "request-1",
      });
      expect(prepared.message.client_ts).toBe(1_800_000_000);
      expect(parseWebRemoteControlRelayV2OutgoingMessage(JSON.parse(prepared.json))).not.toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("distinguishes a permanent oversize envelope from a bounded payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const bounded: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "中文🙂bounded",
    };
    const oversize: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes),
    };

    const preparedBounded = serializer.prepare(bounded, 1);
    expect(serializer.isOversize(preparedBounded)).toBe(false);
    expect(preparedBounded.bytes).toBe(new TextEncoder().encode(preparedBounded.json).byteLength);
    const preparedOversize = serializer.prepare(oversize, 1);
    expect(serializer.isOversize(preparedOversize)).toBe(true);
    expect(preparedOversize.bytes).toBeGreaterThan(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    );
  });
});

describe("targeted serialization", () => {
  it("includes target_terminal_id in JSON, byte count and cache key", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const payload: WebRemoteControlAppPayload = {
      zcode_type: "bootstrap-request",
      requestId: "request-targeted",
    };

    const targeted = serializer.prepare(payload, 100, "t_a");
    expect(targeted.message).toMatchObject({ target_terminal_id: "t_a" });
    expect(JSON.parse(targeted.json).target_terminal_id).toBe("t_a");
    expect(targeted.bytes).toBe(new TextEncoder().encode(targeted.json).byteLength);
    expect(serializer.prepare(payload, 200, "t_a")).toBe(targeted);

    const other = serializer.prepare(payload, 100, "t_b");
    expect(other).not.toBe(targeted);
    expect(JSON.parse(other.json).target_terminal_id).toBe("t_b");

    const untargeted = serializer.prepare(payload, 100);
    expect(JSON.parse(untargeted.json).target_terminal_id).toBeUndefined();
  });
});
