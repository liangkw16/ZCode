import { describe, expect, it } from "vitest";
import { RelayStore } from "../src/domain/relayStore.js";

function createStore() {
  let sid = 0;
  return new RelayStore({ newSid: () => `d_${++sid}` });
}

describe("RelayStore", () => {
  it("注册同 MID 每次产生新 SID，列表在线位由 device owner 决定并携带 meta", () => {
    const store = createStore();
    const a = store.registerDevice("mid-1", 1_000);
    const b = store.registerDevice("mid-1", 2_000);
    expect(a.deviceSid).not.toBe(b.deviceSid);
    const owner = { id: "conn-1" };
    store.claimOwnership(b.deviceSid, "device", { name: "Mac" }, owner);
    const list = store.listDevices(3_000);
    expect(list).toHaveLength(2);
    const online = list.find((d) => d.device_sid === b.deviceSid)!;
    expect(online.online).toBe(true);
    expect(online.meta).toEqual({ name: "Mac" });
    expect(list.find((d) => d.device_sid === a.deviceSid)!.online).toBe(false);
  });

  it("token 一次性消费：过期返回 null，消费后不可复用", () => {
    const store = createStore();
    store.issueToken("terminal", "tok-1", 0);
    expect(store.consumeToken("tok-1", 1_000)).toBe("terminal");
    expect(store.consumeToken("tok-1", 1_100)).toBeNull();
    store.issueToken("device", "tok-2", 0);
    expect(store.consumeToken("tok-2", 61_000)).toBeNull();
  });

  it("claimOwnership 替换同角色 owner 并返回被踢引用；未知设备返回 null", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    expect(store.claimOwnership(deviceSid, "device", {}, oldOwner)!.kicked).toBeNull();
    expect(store.claimOwnership(deviceSid, "device", {}, newOwner)!.kicked).toBe(oldOwner);
    expect(store.getOwner(deviceSid, "device")!.owner).toBe(newOwner);
    expect(store.claimOwnership("d_unknown", "device", {}, newOwner)).toBeNull();
  });

  it("releaseOwnership 按引用身份释放，迟到旧连接不误伤新 owner", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    store.claimOwnership(deviceSid, "terminal", {}, oldOwner);
    store.claimOwnership(deviceSid, "terminal", {}, newOwner);
    expect(store.releaseOwnership(deviceSid, "terminal", oldOwner)).toBe(false);
    expect(store.getOwner(deviceSid, "terminal")!.owner).toBe(newOwner);
    expect(store.releaseOwnership(deviceSid, "terminal", newOwner)).toBe(true);
    expect(store.getOwner(deviceSid, "terminal")).toBeUndefined();
  });

  it("deleteDevice：在线设备 3005 语义返回 device-online，缺失幂等 missing", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    // Bugfix：owner 按引用身份释放，claim/release 必须复用同一个对象，否则测试必败。
    const owner = { id: "c" };
    store.claimOwnership(deviceSid, "device", {}, owner);
    expect(store.deleteDevice(deviceSid)).toBe("device-online");
    store.releaseOwnership(deviceSid, "device", owner);
    expect(store.deleteDevice(deviceSid)).toBe("deleted");
    expect(store.deleteDevice(deviceSid)).toBe("missing");
  });

  it("设备表序列化/恢复 roundtrip，owner 与 token 不参与持久化", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 5_000);
    store.claimOwnership(deviceSid, "device", { name: "x" }, { id: "c" });
    store.issueToken("terminal", "tok", 0);
    const persisted = JSON.parse(JSON.stringify(store.serializeDevices()));
    const restored = createStore();
    expect(restored.restoreDevices(persisted)).toBe(1);
    const list = restored.listDevices(6_000);
    expect(list[0]!.device_sid).toBe(deviceSid);
    expect(list[0]!.online).toBe(false);
    expect(restored.consumeToken("tok", 1)).toBeNull();
    expect(restored.restoreDevices({ garbage: true })).toBe(0);
    expect(restored.restoreDevices(null)).toBe(0);
  });

  it("设备变更触发 listener（注册与删除）", () => {
    const store = createStore();
    let changes = 0;
    store.setDevicesChangeListener(() => {
      changes += 1;
    });
    const { deviceSid } = store.registerDevice("mid-1", 0);
    store.issueToken("device", "t", 0);
    store.deleteDevice(deviceSid);
    expect(changes).toBe(2);
  });
});
