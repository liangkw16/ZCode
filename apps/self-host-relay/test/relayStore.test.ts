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
    store.claimDevice(b.deviceSid, { name: "Mac" }, owner);
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

  it("claimDevice 替换 owner 并返回被踢引用；未知设备返回 null", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    expect(store.claimDevice(deviceSid, {}, oldOwner)!.kicked).toBeNull();
    expect(store.claimDevice(deviceSid, {}, newOwner)!.kicked).toBe(oldOwner);
    expect(store.getDeviceOwner(deviceSid)!.owner).toBe(newOwner);
    expect(store.claimDevice("d_unknown", "device" as never, {}, newOwner)).toBeNull();
  });

  it("多个 terminal 共存；同 id 才替换；release 按引用身份", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const ownerA = { id: "a" };
    const ownerB = { id: "b" };
    const ownerA2 = { id: "a2" };

    expect(store.claimTerminal(deviceSid, "tA", {}, ownerA)!.terminalIds).toEqual(["tA"]);
    expect(store.claimTerminal(deviceSid, "tB", {}, ownerB)!.terminalIds).toEqual(["tA", "tB"]);
    expect(store.listTerminalIds(deviceSid)).toEqual(["tA", "tB"]);

    const replaced = store.claimTerminal(deviceSid, "tA", {}, ownerA2)!;
    expect(replaced.kicked).toBe(ownerA);
    expect(store.getTerminalOwner(deviceSid, "tA")!.owner).toBe(ownerA2);

    expect(store.releaseTerminal(deviceSid, "tA", ownerA)).toEqual({
      released: false,
      terminalIds: ["tA", "tB"],
    });
    expect(store.releaseTerminal(deviceSid, "tA", ownerA2)).toEqual({
      released: true,
      terminalIds: ["tB"],
    });
    expect(store.listTerminalIds(deviceSid)).toEqual(["tB"]);
  });

  it("releaseDevice 只在引用一致时释放，并清空该 SID 的全部 terminal", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const deviceOwner = { id: "device" };
    const terminalOwner = { id: "terminal" };
    store.claimDevice(deviceSid, {}, deviceOwner);
    store.claimTerminal(deviceSid, "tA", {}, terminalOwner);

    expect(store.releaseDevice(deviceSid, { id: "other" })).toEqual({
      released: false,
      terminals: [],
    });
    const released = store.releaseDevice(deviceSid, deviceOwner)!;
    expect(released.released).toBe(true);
    expect(released.terminals).toEqual([{ terminalId: "tA", owner: terminalOwner }]);
    expect(store.listTerminalIds(deviceSid)).toEqual([]);
    expect(store.getDeviceOwner(deviceSid)).toBeUndefined();
  });

  it("claimTerminal 对未知设备返回 null；deleteDevice 清理 terminal 槽位", () => {
    const store = createStore();
    expect(store.claimTerminal("d_unknown", "tA", {}, {})).toBeNull();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    store.claimTerminal(deviceSid, "tA", {}, {});
    expect(store.deleteDevice(deviceSid)).toBe("deleted");
    expect(store.listTerminalIds(deviceSid)).toEqual([]);
  });

  it("deleteDevice：在线设备 3005 语义返回 device-online，缺失幂等 missing", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    // owner 按引用身份释放，claim/release 必须复用同一个对象，否则测试必败。
    const owner = { id: "c" };
    store.claimDevice(deviceSid, {}, owner);
    expect(store.deleteDevice(deviceSid)).toBe("device-online");
    store.releaseDevice(deviceSid, owner);
    expect(store.deleteDevice(deviceSid)).toBe("deleted");
    expect(store.deleteDevice(deviceSid)).toBe("missing");
  });

  it("设备表序列化/恢复 roundtrip，owner 与 token 不参与持久化", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 5_000);
    store.claimDevice(deviceSid, { name: "x" }, { id: "c" });
    store.claimTerminal(deviceSid, "tA", {}, { id: "t" });
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

describe("token 回收", () => {
  it("后续签发时清理过期 token（未消费项不永久驻留）", () => {
    const store = createStore();
    store.issueToken("terminal", "tok-old", 0);
    store.issueToken("device", "tok-new", 61_000); // 触发过期清理
    // 若旧项仍在，以其原过期窗口内的时间消费会成功；被清理后必须为 null。
    expect(store.consumeToken("tok-old", 59_000)).toBeNull();
    expect(store.consumeToken("tok-new", 62_000)).toBe("device");
  });
});
