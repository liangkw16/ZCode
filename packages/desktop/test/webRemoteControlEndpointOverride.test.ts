import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlEndpointOverrideUrls } from "../src/main/web-remote-relay/webRemoteControlEndpointOverride.js";

describe("resolveWebRemoteControlEndpointOverrideUrls", () => {
  it("kcode + 有效 setting：覆盖远控三端点，http origin 推导 ws", () => {
    const result = resolveWebRemoteControlEndpointOverrideUrls({
      flavor: "kcode",
      settingOrigin: "http://ecs.example.com:8787",
      appVersion: "3.16.1",
    });
    expect(result).toEqual({
      origin: "http://ecs.example.com:8787",
      relayWsUrl: "ws://ecs.example.com:8787/api/v1/remote/ws2",
      remoteUrl: "http://ecs.example.com:8787/remote/v4",
    });
  });

  it("kcode 无 setting / 空 setting 返回 null", () => {
    expect(resolveWebRemoteControlEndpointOverrideUrls({ flavor: "kcode" })).toBeNull();
    expect(resolveWebRemoteControlEndpointOverrideUrls({ flavor: "kcode", settingOrigin: "  " })).toBeNull();
  });

  it("非 kcode flavor 即使有 setting 也返回 null（官方行为不变）", () => {
    expect(
      resolveWebRemoteControlEndpointOverrideUrls({
        flavor: "production",
        settingOrigin: "http://ecs.example.com:8787",
      }),
    ).toBeNull();
    expect(
      resolveWebRemoteControlEndpointOverrideUrls({
        flavor: "preview",
        settingOrigin: "http://ecs.example.com:8787",
      }),
    ).toBeNull();
  });

  it("非法 origin 返回 null 而不是抛错（兜底回官方域）", () => {
    expect(resolveWebRemoteControlEndpointOverrideUrls({ flavor: "kcode", settingOrigin: "not-a-url" })).toBeNull();
  });

  it("低于 v4 门槛的 appVersion 仍按既有版本分界推导 v3 remoteUrl", () => {
    const result = resolveWebRemoteControlEndpointOverrideUrls({
      flavor: "kcode",
      settingOrigin: "https://ecs.example.com",
      appVersion: "3.3.0",
    });
    expect(result!.remoteUrl).toBe("https://ecs.example.com/remote/v3");
  });
});
