import { expect, it } from "vitest";
import {
  buildWebRemoteControlExternalQrUrl,
  parseWebRemoteControlExternalQrParams,
} from "@zcode/shared";
import {
  getWebRemoteControlHeartbeatDelayMs,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
} from "@zcode/shared/web-remote-relay";

it("builds V2 links without secrets, including removal of stale base URL credentials", () => {
  const url = buildWebRemoteControlExternalQrUrl({
    baseUrl: "https://zcode.z.ai/remote/v4?hash=old&t=123",
    deviceSid: "d_1",
    deviceMid: "mid-1",
    deviceName: "我的桌面",
    appVersion: "3.13.0",
  });
  const params = new URL(url).searchParams;
  expect([...params.keys()]).toEqual(["sid", "mid", "name", "app_version"]);
  expect(parseWebRemoteControlExternalQrParams(params)).toEqual({
    deviceSid: "d_1",
    deviceMid: "mid-1",
    deviceName: "我的桌面",
    appVersion: "3.13.0",
  });
});

it("accepts every V2 routing hint independently or none and rejects legacy credentials", () => {
  for (const [query, result] of [
    ["", {}],
    ["sid=d_1", { deviceSid: "d_1" }],
    ["mid=m1", { deviceMid: "m1" }],
    ["name=Desk", { deviceName: "Desk" }],
    ["app_version=3.13.0", { appVersion: "3.13.0" }],
    ["sid=%20&name=%20", {}],
  ] as const)
    expect(parseWebRemoteControlExternalQrParams(new URLSearchParams(query))).toEqual(result);
  for (const query of ["sid=d_1&hash=secret&t=123", "hash=", "t=123"]) {
    expect(parseWebRemoteControlExternalQrParams(new URLSearchParams(query))).toBeNull();
  }
});

it("selfHostKey 非空时密钥进入 #k= fragment，query 配对参数不受影响", () => {
  const url = new URL(
    buildWebRemoteControlExternalQrUrl({
      baseUrl: "https://relay.example.com/remote/v4",
      deviceSid: "d_1",
      deviceMid: "mid-1",
      deviceName: "Desk",
      appVersion: "3.13.0",
      selfHostKey: "abc123",
    }),
  );
  expect(url.hash).toBe("#k=abc123");
  expect([...url.searchParams.keys()]).toEqual(["sid", "mid", "name", "app_version"]);
});

it("selfHostKey 缺省/空串时不追加 hash，保持官方构建现状", () => {
  for (const selfHostKey of [undefined, null, "  "] as const) {
    const url = new URL(
      buildWebRemoteControlExternalQrUrl({
        baseUrl: "https://zcode.z.ai/remote/v4",
        deviceSid: "d_1",
        selfHostKey,
      }),
    );
    expect(url.hash).toBe("");
  }
});

it("selfHostKey 含需编码字符时按 encodeURIComponent 写入 fragment", () => {
  const url = new URL(
    buildWebRemoteControlExternalQrUrl({
      baseUrl: "https://relay.example.com/remote/v4",
      selfHostKey: "a b/c?d",
    }),
  );
  expect(url.hash).toBe(`#k=${encodeURIComponent("a b/c?d")}`);
  // 手机页 readSelfHostKey 的解析往返必须一致
  expect(new URLSearchParams(url.hash.replace(/^#/, "")).get("k")).toBe("a b/c?d");
});

it("uses the V2 heartbeat bounds as the helper defaults", () => {
  expect(
    getWebRemoteControlHeartbeatDelayMs(
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
      () => 0,
    ),
  ).toBe(4_000);
  expect(
    getWebRemoteControlHeartbeatDelayMs(
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
      () => 1,
    ),
  ).toBe(6_000);
  expect(getWebRemoteControlHeartbeatDelayMs(undefined, undefined, () => 0.5)).toBe(5_000);
});
