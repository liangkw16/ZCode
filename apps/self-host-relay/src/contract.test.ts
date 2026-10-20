import { describe, expect, it } from "vitest";
import { SELF_HOST_RELAY_CONFIG_EXAMPLE } from "./contract.example.js";
import type { SelfHostRelayConfig, SelfHostRelayStore } from "./contract.js";

describe("self-host-relay contract", () => {
  it("配置示例满足端口类型", () => {
    const config: SelfHostRelayConfig = SELF_HOST_RELAY_CONFIG_EXAMPLE;
    expect(config.port).toBe(8787);
    expect(config.secret.length).toBeGreaterThan(0);
  });

  it("Store 端口可被实现方引用（编译期契约）", () => {
    const store: SelfHostRelayStore | null = null;
    expect(store).toBeNull(); // 仅类型引用，运行时不构造
  });
});
