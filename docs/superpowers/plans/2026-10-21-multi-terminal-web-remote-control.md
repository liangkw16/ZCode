# 手机远控多网页独立会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一桌面窗口的远控链接可以同时被多个浏览器页面连接，每个页面拥有独立的 bridge/attachment 与视图状态，互不踢下线。

**Architecture:** relay 把 `(device_sid, terminal)` 单 owner 改为按 `terminal_id` 的集合，并在 `data` 上用 `from_terminal_id` / `target_terminal_id` 做定向路由；desktop manager 把单 bridge 状态拆成 `Map<terminalId, TerminalSession>`，每个 session 独立持有 bridge、attachment、outbound buffer 和视图状态；web 页面加载时生成稳定的 `terminal_id` 并随 `auth_init` 上报。

**Tech Stack:** TypeScript、Node 22、`ws`、zod、Vitest、Electron main、React（web 入口）。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-terminal-web-remote-control-design.md`

## Global Constraints

- Node 版本以 `mise.toml` 为准；本机构建/测试命令使用 `mise exec --`。
- 所有 wire 新增字段必须可选；官方 relay 与旧客户端行为零变化。
- 不把凭据、自托管密钥、真实 ECS 地址写入代码、测试、日志或提交。
- 每个行为改动先写失败测试，再写最小实现；每个任务结束时运行该任务指定的测试。
- 任务完成后运行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；如实记录失败。
- 仓库提交需用户明确同意；未获授权时执行 `git add` 后跳过 `git commit`，保留工作区改动。
- 不修改与任务无关的文件；不恢复已删除的 V1 模块。

### Preflight（每个任务开始前执行一次）

```bash
node scripts/check-workspace-freshness.mjs
pnpm architecture:check --changed
pnpm architecture:context web-remote-relay
pnpm architecture:context desktop-web-remote-relay
pnpm architecture:context web-remote-control
```

## Review Focus

- **页面重连与宽限期**：terminal 在 30s 宽限内以同一 `terminal_id` 重连时，必须复用原 bridge/attachment；迟到的旧连接 close 不得释放新 owner。
- **官方 relay 兼容**：没有 `from_terminal_id` / `terminal_ids` 时全部落 DEFAULT session；发往官方 relay 的 `data` 不能携带 `target_terminal_id`。
- **断开方向性**：单个 terminal 断开不能给 device 发 `DEVICE_OFFLINE`，也不能关闭其他 terminal；device 断开必须只发一次 `waiting` + `DEVICE_OFFLINE` 并关闭全部 terminal。
- **帧大小**：`target_terminal_id` 必须计入 `maxPhysicalFrameBytes`；接近上限的帧应被判 oversize，而不是截断或静默丢弃。
- **重复 terminal_id**：只允许踢同 id 的旧连接；不同页面的 id 必须共存，不能互相 KICKED。

---

### Task 1: Shared wire schema

**Files:**

- Modify: `packages/shared/src/web-remote-relay/contract.ts`
- Test: `packages/shared/test/webRemoteControlRelayV2.test.ts`

**Interfaces:**

- Produces: `auth_init.terminal_id?: string`、`auth_ack.terminal_id?: string`、
  `auth_ack.terminal_ids?: string[]`、`pair_status_ack.terminal_ids?: string[]`、outgoing
  `data.target_terminal_id?: string`、incoming `data.from_terminal_id?: string`。

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/webRemoteControlRelayV2.test.ts` 末尾添加：

```ts
it("accepts optional multi-terminal routing fields in the correct direction", () => {
  const auth = { type: "auth_init", device_sid: "d_1", terminal_id: "t_a" };
  expect(parseWebRemoteControlRelayV2OutgoingMessage(auth)).toEqual(auth);

  const outgoingData = {
    type: "data",
    payload: { hello: "desktop" },
    target_terminal_id: "t_b",
  };
  expect(parseWebRemoteControlRelayV2OutgoingMessage(outgoingData)).toEqual(
    outgoingData,
  );
  expect(
    parseWebRemoteControlRelayV2OutgoingMessage({
      ...outgoingData,
      from_terminal_id: "t_a",
    }),
  ).toBeNull();

  const incomingData = {
    type: "data",
    payload: { hello: "phone" },
    from_terminal_id: "t_a",
  };
  expect(parseWebRemoteControlRelayV2IncomingMessage(incomingData)).toEqual(
    incomingData,
  );
  expect(
    parseWebRemoteControlRelayV2IncomingMessage({
      ...incomingData,
      target_terminal_id: "t_b",
    }),
  ).toBeNull();

  const ack = {
    type: "auth_ack",
    device_sid: "d_1",
    pair_status: "matched",
    terminal_id: "t_a",
    terminal_ids: ["t_a", "t_b"],
  };
  expect(parseWebRemoteControlRelayV2IncomingMessage(ack)).toEqual(ack);

  const pairAck = {
    type: "pair_status_ack",
    pair_status: "matched",
    terminal_ids: ["t_a", "t_b"],
  };
  expect(parseWebRemoteControlRelayV2IncomingMessage(pairAck)).toEqual(pairAck);
});

it("rejects blank or malformed terminal ids", () => {
  expect(
    parseWebRemoteControlRelayV2OutgoingMessage({
      type: "auth_init",
      device_sid: "d_1",
      terminal_id: " ",
    }),
  ).toBeNull();
  expect(
    parseWebRemoteControlRelayV2OutgoingMessage({
      type: "data",
      payload: {},
      target_terminal_id: "",
    }),
  ).toBeNull();
  expect(
    parseWebRemoteControlRelayV2IncomingMessage({
      type: "pair_status_ack",
      pair_status: "matched",
      terminal_ids: ["t_a", " "],
    }),
  ).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/shared/test/webRemoteControlRelayV2.test.ts`
Expected: FAIL，新增字段被 `strictObject` 拒绝。

- [ ] **Step 3: 实现 schema**

在 `packages/shared/src/web-remote-relay/contract.ts` 中：

```ts
const terminalIdList = z.array(identifier).max(64);

const authInit = z.strictObject({
  type: z.literal("auth_init"),
  device_sid: deviceSid,
  terminal_id: identifier.optional(),
  meta: meta.optional(),
  client_ts: unixSeconds.optional(),
});

const outgoingData = z.strictObject({
  type: z.literal("data"),
  payload: z.json(),
  target_terminal_id: identifier.optional(),
  client_ts: unixSeconds.optional(),
});

const authAck = z.strictObject({
  type: z.literal("auth_ack"),
  device_sid: deviceSid,
  terminal_sid: z.string().optional(),
  terminal_id: identifier.optional(),
  terminal_ids: terminalIdList.optional(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});

const pairStatusAck = z.strictObject({
  type: z.literal("pair_status_ack"),
  terminal_sid: z.string().optional(),
  terminal_ids: terminalIdList.optional(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});

const incomingData = z.strictObject({
  type: z.literal("data"),
  payload: z.json(),
  from_terminal_id: identifier.optional(),
  server_ts: unixSeconds.optional(),
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm exec vitest run packages/shared/test/webRemoteControlRelayV2.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/web-remote-relay/contract.ts packages/shared/test/webRemoteControlRelayV2.test.ts
git commit -m "feat(relay): add optional multi-terminal wire fields"
```

---

### Task 2: Relay store terminal set

**Files:**

- Modify: `apps/self-host-relay/src/contract.ts`
- Modify: `apps/self-host-relay/src/domain/relayStore.ts`
- Test: `apps/self-host-relay/test/relayStore.test.ts`
- Test: `apps/self-host-relay/test/httpRouter.test.ts`

**Interfaces:**

- Produces: `claimDevice`、`releaseDevice`、`getDeviceOwner`、`claimTerminal`、`releaseTerminal`、`getTerminalOwner`、`listTerminalIds`。
- Consumes: Task 1 的 `WebRemoteControlRelayV2Meta`（类型未变）。

- [ ] **Step 1: 写失败测试**

替换 `apps/self-host-relay/test/relayStore.test.ts` 中旧的 `claimOwnership` / `releaseOwnership` / `getOwner` 用例，并添加：

```ts
it("多个 terminal 共存；同 id 才替换；release 按引用身份", () => {
  const store = createStore();
  const { deviceSid } = store.registerDevice("mid-1", 0);
  const ownerA = { id: "a" };
  const ownerB = { id: "b" };
  const ownerA2 = { id: "a2" };

  expect(store.claimTerminal(deviceSid, "tA", {}, ownerA)!.terminalIds).toEqual(
    ["tA"],
  );
  expect(store.claimTerminal(deviceSid, "tB", {}, ownerB)!.terminalIds).toEqual(
    ["tA", "tB"],
  );
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
  expect(released.terminals).toEqual([
    { terminalId: "tA", owner: terminalOwner },
  ]);
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
```

同时把该文件中其他用例改为 `claimDevice` / `releaseDevice` / `getDeviceOwner`。
`apps/self-host-relay/test/httpRouter.test.ts` 的两处同样替换：
`store.claimOwnership(deviceSid, "device", {}, owner)` →
`store.claimDevice(deviceSid, {}, owner)`；
`store.releaseOwnership(deviceSid, "device", owner)` →
`store.releaseDevice(deviceSid, owner)`。

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm --filter @zcode/self-host-relay exec vitest run test/relayStore.test.ts`
Expected: FAIL，新方法不存在。

- [ ] **Step 3: 实现 store**

在 `apps/self-host-relay/src/contract.ts` 用以下签名替换 `claimOwnership` / `releaseOwnership` / `getOwner`：

```ts
claimDevice(
  deviceSid: string,
  meta: WebRemoteControlRelayV2Meta,
  owner: unknown,
): { kicked: unknown | null } | null;
releaseDevice(
  deviceSid: string,
  owner: unknown,
): { released: boolean; terminals: { terminalId: string; owner: unknown }[] };
getDeviceOwner(
  deviceSid: string,
): { owner: unknown; meta: WebRemoteControlRelayV2Meta } | undefined;

claimTerminal(
  deviceSid: string,
  terminalId: string,
  meta: WebRemoteControlRelayV2Meta,
  owner: unknown,
): { kicked: unknown | null; terminalIds: string[] } | null;
releaseTerminal(
  deviceSid: string,
  terminalId: string,
  owner: unknown,
): { released: boolean; terminalIds: string[] };
getTerminalOwner(
  deviceSid: string,
  terminalId: string,
): { owner: unknown; meta: WebRemoteControlRelayV2Meta } | undefined;
listTerminalIds(deviceSid: string): string[];
```

在 `apps/self-host-relay/src/domain/relayStore.ts`：

```ts
private readonly deviceOwners = new Map<string, OwnerSlot>();
private readonly terminalOwners = new Map<string, Map<string, OwnerSlot>>();

claimDevice(deviceSid, meta, owner) {
  if (!this.devices.has(deviceSid)) return null;
  const kicked = this.deviceOwners.get(deviceSid)?.owner ?? null;
  this.deviceOwners.set(deviceSid, { owner, meta: { ...meta } });
  return { kicked };
}

releaseDevice(deviceSid, owner) {
  const slot = this.deviceOwners.get(deviceSid);
  if (!slot || slot.owner !== owner) return { released: false, terminals: [] };
  this.deviceOwners.delete(deviceSid);
  const slots = this.terminalOwners.get(deviceSid);
  const terminals = slots
    ? [...slots].map(([terminalId, entry]) => ({ terminalId, owner: entry.owner }))
    : [];
  this.terminalOwners.delete(deviceSid);
  return { released: true, terminals };
}

getDeviceOwner(deviceSid) {
  const slot = this.deviceOwners.get(deviceSid);
  return slot ? { owner: slot.owner, meta: { ...slot.meta } } : undefined;
}

claimTerminal(deviceSid, terminalId, meta, owner) {
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

releaseTerminal(deviceSid, terminalId, owner) {
  const slots = this.terminalOwners.get(deviceSid);
  const slot = slots?.get(terminalId);
  if (!slots || !slot || slot.owner !== owner) {
    return { released: false, terminalIds: slots ? [...slots.keys()] : [] };
  }
  slots.delete(terminalId);
  const terminalIds = [...slots.keys()];
  if (slots.size === 0) this.terminalOwners.delete(deviceSid);
  return { released: true, terminalIds };
}

getTerminalOwner(deviceSid, terminalId) {
  const slot = this.terminalOwners.get(deviceSid)?.get(terminalId);
  return slot ? { owner: slot.owner, meta: { ...slot.meta } } : undefined;
}

listTerminalIds(deviceSid) {
  return [...(this.terminalOwners.get(deviceSid)?.keys() ?? [])];
}
```

同时：

- `listDevices` 的 `online` 改为 `this.deviceOwners.has(record.deviceSid)`，`meta` 从 `deviceOwners` 取；
- `deleteDevice` 的在线判断改为 `this.deviceOwners.has(deviceSid)`，删除时同时 `this.terminalOwners.delete(deviceSid)`；
- 删除旧的 `owners` map。

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm --filter @zcode/self-host-relay exec vitest run test/relayStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/contract.ts apps/self-host-relay/src/domain/relayStore.ts apps/self-host-relay/test/relayStore.test.ts
git commit -m "feat(relay): track terminal owners as a set"
```

---

### Task 3: Relay gateway multi-terminal routing

**Files:**

- Modify: `apps/self-host-relay/src/adapters/wsGateway.ts`
- Test: `apps/self-host-relay/test/wsGateway.test.ts`

**Interfaces:**

- Consumes: Task 2 的 store API。
- Produces: relay 行为（terminal 集合、定向 data、`terminal_ids` 推送）。

- [ ] **Step 1: 写失败测试**

在 `apps/self-host-relay/test/wsGateway.test.ts` 的第二个 `describe` 中，把旧的“现任 terminal 立即接管”用例替换为：

```ts
it("不同 terminal_id 共存：两个页面都 matched，互不 KICKED", async () => {
  const sid = freshSid();
  const device = await auth2("device", sid);
  await device.messages.next();

  const a = await auth2("terminal", sid, "tA");
  expect(await a.messages.next()).toMatchObject({
    type: "auth_ack",
    pair_status: "matched",
    terminal_id: "tA",
  });
  expect(await device.messages.next()).toMatchObject({
    type: "pair_status_ack",
    pair_status: "matched",
    terminal_ids: ["tA"],
  });

  const b = await auth2("terminal", sid, "tB");
  expect(await b.messages.next()).toMatchObject({
    type: "auth_ack",
    pair_status: "matched",
    terminal_id: "tB",
  });
  expect(await device.messages.next()).toMatchObject({
    type: "pair_status_ack",
    pair_status: "matched",
    terminal_ids: ["tA", "tB"],
  });

  a.socket.send(JSON.stringify({ type: "data", payload: { from: "a" } }));
  expect(await device.messages.next()).toMatchObject({
    type: "data",
    payload: { from: "a" },
    from_terminal_id: "tA",
  });

  device.socket.send(
    JSON.stringify({
      type: "data",
      payload: { to: "b" },
      target_terminal_id: "tB",
    }),
  );
  expect(await b.messages.next()).toMatchObject({
    type: "data",
    payload: { to: "b" },
  });

  // 共存不变量：B 全程接入、定向收发之后，A 仍然在线。
  expect(a.socket.readyState).toBe(WebSocket.OPEN);
  a.socket.close();
  device.socket.close();
  b.socket.close();
});

it("terminal 先在线等待，device 上线后拿到 terminal_ids 并配对", async () => {
  const sid = freshSid();
  const terminal = await auth2("terminal", sid, "tA");
  expect(await terminal.messages.next()).toMatchObject({
    type: "auth_ack",
    pair_status: "waiting",
  });

  const device = await auth2("device", sid);
  expect(await device.messages.next()).toMatchObject({
    type: "auth_ack",
    pair_status: "matched",
    terminal_ids: ["tA"],
  });
  expect(await terminal.messages.next()).toMatchObject({
    type: "pair_status_ack",
    pair_status: "matched",
  });

  device.socket.close();
  terminal.socket.close();
});

it("单个 terminal 断开只更新 device 的集合，不关闭其他 terminal", async () => {
  const sid = freshSid();
  const device = await auth2("device", sid);
  await device.messages.next();
  const a = await auth2("terminal", sid, "tA");
  await a.messages.next();
  await device.messages.next();
  const b = await auth2("terminal", sid, "tB");
  await b.messages.next();
  await device.messages.next();

  a.socket.close();
  expect(await device.messages.next()).toMatchObject({
    type: "pair_status_ack",
    pair_status: "matched",
    terminal_ids: ["tB"],
  });
  device.socket.send(JSON.stringify({ type: "pair_status_query" }));
  expect(await device.messages.next()).toMatchObject({
    type: "pair_status_ack",
    pair_status: "matched",
    terminal_ids: ["tB"],
  });
  device.socket.close();
  b.socket.close();
});

it("device 断开时通知并关闭全部 terminal", async () => {
  const sid = freshSid();
  const device = await auth2("device", sid);
  await device.messages.next();
  const a = await auth2("terminal", sid, "tA");
  await a.messages.next();
  await device.messages.next();
  const b = await auth2("terminal", sid, "tB");
  await b.messages.next();
  await device.messages.next();

  device.socket.close();
  for (const terminal of [a, b]) {
    expect(await terminal.messages.next()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });
    expect(await terminal.messages.next()).toMatchObject({
      type: "error",
      code: "DEVICE_OFFLINE",
    });
    await waitClosed(terminal.socket);
  }
});

it("同 terminal_id 重连只踢旧连接", async () => {
  const sid = freshSid();
  const device = await auth2("device", sid);
  await device.messages.next();
  const first = await auth2("terminal", sid, "tSame");
  await first.messages.next();
  await device.messages.next();

  const second = await auth2("terminal", sid, "tSame");
  expect(await second.messages.next()).toMatchObject({
    type: "auth_ack",
    terminal_id: "tSame",
  });
  expect(await first.messages.next()).toMatchObject({
    type: "error",
    code: "KICKED",
  });
  await waitClosed(first.socket);
  device.socket.close();
  second.socket.close();
});

it("未提供 terminal_id 的旧客户端各自使用连接级 sid 作为 id", async () => {
  const sid = freshSid();
  const device = await auth2("device", sid);
  await device.messages.next();
  const a = await auth2("terminal", sid);
  const ackA = await a.messages.next();
  expect(ackA.type).toBe("auth_ack");
  expect(ackA.terminal_id).toBe(ackA.terminal_sid);
  await device.messages.next();
  const b = await auth2("terminal", sid);
  const ackB = await b.messages.next();
  expect(ackB.terminal_id).toBe(ackB.terminal_sid);
  expect(ackB.terminal_id).not.toBe(ackA.terminal_id);
  device.socket.close();
  a.socket.close();
  b.socket.close();
});
```

把 `auth2` 扩展为可选 `terminalId`：

```ts
async function auth2(
  role: "device" | "terminal",
  sidToUse: string,
  terminalId?: string,
) {
  const connection = await open2(await mint2(role));
  connection.socket.send(
    JSON.stringify({
      type: "auth_init",
      device_sid: sidToUse,
      ...(terminalId ? { terminal_id: terminalId } : {}),
      meta: { name: "takeover-test" },
    }),
  );
  return connection;
}
```

新增 `waitClosedA` 可复用现有 `waitClosed`；上面示例里的 `waitClosedA` 改为直接调用 `waitClosed(a.socket)`。

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm --filter @zcode/self-host-relay exec vitest run test/wsGateway.test.ts`
Expected: FAIL，第二个 terminal 会踢掉第一个。

- [ ] **Step 3: 实现 gateway**

在 `apps/self-host-relay/src/adapters/wsGateway.ts`：

连接对象：

```ts
interface RelayConnection {
  role: WebRemoteControlRelayV2Role;
  terminalSid: string;
  terminalId: string | null;
  deviceSid: string | null;
  ownerRef: unknown;
  socket: WebSocket;
}
```

把 `peerOf` 替换为：

```ts
const deviceConnectionOf = (deviceSid: string): RelayConnection | undefined => {
  const slot = store.getDeviceOwner(deviceSid);
  return slot ? connections.get(slot.owner) : undefined;
};

const terminalConnectionsOf = (deviceSid: string): RelayConnection[] => {
  const result: RelayConnection[] = [];
  for (const terminalId of store.listTerminalIds(deviceSid)) {
    const slot = store.getTerminalOwner(deviceSid, terminalId);
    const connection = slot ? connections.get(slot.owner) : undefined;
    if (connection) result.push(connection);
  }
  return result;
};
```

`auth_init` 分支按以下逻辑重写（保留现有错误处理和 close 语义）：

```ts
if (message.type === "auth_init") {
  if (connection.deviceSid || connection.terminalId) {
    send(connection, { type: "error", code: "WRONG_PARAM" });
    ws.close();
    return;
  }
  if (connection.role === "terminal") {
    const terminalId = (message.terminal_id ?? connection.terminalSid).trim();
    const existing = store.getTerminalOwner(message.device_sid, terminalId);
    if (
      !existing &&
      store.listTerminalIds(message.device_sid).length >= maxTerminals
    ) {
      send(connection, { type: "error", code: "KICKED" });
      ws.close();
      return;
    }
    const claimed = store.claimTerminal(
      message.device_sid,
      terminalId,
      message.meta ?? {},
      connection.ownerRef,
    );
    if (!claimed) {
      send(connection, { type: "error", code: "AUTH_FAILED" });
      ws.close();
      return;
    }
    const kickedConnection = claimed.kicked
      ? connections.get(claimed.kicked)
      : undefined;
    if (kickedConnection) {
      send(kickedConnection, { type: "error", code: "KICKED" });
      kickedConnection.socket.close();
    }
    connection.deviceSid = message.device_sid;
    connection.terminalId = terminalId;
    const device = deviceConnectionOf(message.device_sid);
    const pairStatus = device ? "matched" : "waiting";
    // 兼容开关：仅当 terminal 自己携带 terminal_id 时才回显该字段。
    // 旧 web 的 strict schema 会拒绝未知字段，无条件回显会让旧页面认证超时重连。
    send(connection, {
      type: "auth_ack",
      device_sid: message.device_sid,
      terminal_sid: connection.terminalSid,
      ...(message.terminal_id ? { terminal_id: terminalId } : {}),
      pair_status: pairStatus,
    });
    if (device) {
      send(device, {
        type: "pair_status_ack",
        pair_status: "matched",
        terminal_ids: claimed.terminalIds,
      });
    }
    return;
  }

  const claimed = store.claimDevice(
    message.device_sid,
    message.meta ?? {},
    connection.ownerRef,
  );
  if (!claimed) {
    send(connection, { type: "error", code: "AUTH_FAILED" });
    ws.close();
    return;
  }
  const kickedConnection = claimed.kicked
    ? connections.get(claimed.kicked)
    : undefined;
  if (kickedConnection) {
    send(kickedConnection, { type: "error", code: "KICKED" });
    kickedConnection.socket.close();
  }
  connection.deviceSid = message.device_sid;
  const terminalIds = store.listTerminalIds(message.device_sid);
  const pairStatus = terminalIds.length > 0 ? "matched" : "waiting";
  send(connection, {
    type: "auth_ack",
    device_sid: message.device_sid,
    terminal_sid: "",
    terminal_ids: terminalIds,
    pair_status: pairStatus,
  });
  if (terminalIds.length > 0) {
    for (const terminal of terminalConnectionsOf(message.device_sid)) {
      send(terminal, {
        type: "pair_status_ack",
        pair_status: "matched",
        terminal_sid: "",
      });
    }
  }
  return;
}
```

`pair_status_query`：

```ts
if (message.type === "pair_status_query") {
  if (connection.role === "terminal") {
    const device = deviceConnectionOf(connection.deviceSid ?? "");
    send(connection, {
      type: "pair_status_ack",
      pair_status: device ? "matched" : "waiting",
      terminal_sid: "",
    });
    return;
  }
  const terminalIds = store.listTerminalIds(connection.deviceSid ?? "");
  send(connection, {
    type: "pair_status_ack",
    pair_status: terminalIds.length > 0 ? "matched" : "waiting",
    terminal_sid: "",
    terminal_ids: terminalIds,
  });
  return;
}
```

`data`：

```ts
if (message.type === "data") {
  if (connection.role === "terminal") {
    const device = deviceConnectionOf(connection.deviceSid ?? "");
    if (!device) {
      send(connection, { type: "error", code: "INTERNAL" });
      return;
    }
    send(device, {
      type: "data",
      payload: message.payload,
      from_terminal_id: connection.terminalId ?? "",
    });
    return;
  }

  const targetId = message.target_terminal_id;
  if (targetId) {
    const slot = store.getTerminalOwner(connection.deviceSid ?? "", targetId);
    const target = slot ? connections.get(slot.owner) : undefined;
    if (!target) {
      console.debug("[self-host-relay] dropping data for unknown terminal", {
        targetId,
      });
      return;
    }
    send(target, { type: "data", payload: message.payload });
    return;
  }

  const terminals = terminalConnectionsOf(connection.deviceSid ?? "");
  if (terminals.length === 0) {
    send(connection, { type: "error", code: "INTERNAL" });
    return;
  }
  for (const terminal of terminals) {
    send(terminal, { type: "data", payload: message.payload });
  }
  return;
}
```

`close`：

```ts
ws.on("close", () => {
  connections.delete(connection.ownerRef);
  if (!connection.deviceSid) return;

  if (connection.role === "device") {
    const released = store.releaseDevice(
      connection.deviceSid,
      connection.ownerRef,
    );
    if (!released.released) return;
    for (const terminal of released.terminals) {
      const target = connections.get(terminal.owner);
      if (!target) continue;
      send(target, {
        type: "pair_status_ack",
        pair_status: "waiting",
        terminal_sid: "",
      });
      send(target, { type: "error", code: "DEVICE_OFFLINE" });
      target.socket.close();
    }
    return;
  }

  const released = store.releaseTerminal(
    connection.deviceSid,
    connection.terminalId ?? connection.terminalSid,
    connection.ownerRef,
  );
  if (!released.released) return;
  const device = deviceConnectionOf(connection.deviceSid);
  if (device) {
    send(device, {
      type: "pair_status_ack",
      pair_status: released.terminalIds.length > 0 ? "matched" : "waiting",
      terminal_ids: released.terminalIds,
    });
  }
});
```

在 `attachSelfHostRelayWsGateway` 顶部增加：

```ts
export interface SelfHostRelayWsGatewayOptions {
  store: SelfHostRelayStore;
  now?: () => number;
  maxTerminals?: number;
}

const maxTerminals = options.maxTerminals ?? 32;
```

注意：`send()` 会附加 `server_ts`；转发给 terminal 的 `data` 不要带 `target_terminal_id`。

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm --filter @zcode/self-host-relay exec vitest run test/wsGateway.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/adapters/wsGateway.ts apps/self-host-relay/test/wsGateway.test.ts
git commit -m "feat(relay): route data across multiple terminals"
```

---

### Task 4: 契约文档同步

**Files:**

- Modify: `apps/self-host-relay/src/CONTRACT.md`
- Modify: `docs/web-remote-control/relay-v2-pairing.md`
- Modify: `docs/superpowers/specs/2026-10-20-self-hosted-relay-design.md`

- [ ] **Step 1: 更新 relay CONTRACT.md**

在 `apps/self-host-relay/src/CONTRACT.md` 增加：

```md
## 多 terminal 扩展（2026-10-21）

- 同一 `device_sid` 允许多个 terminal 连接，按 `terminal_id` 区分；同 id 重连只替换旧连接。
- `auth_init.terminal_id?` 由客户端提供；缺省时使用连接级 `terminal_sid`。
- `auth_ack.terminal_id?` 回显生效 id。
- relay → device 的 `data` 增加 `from_terminal_id?`；device → relay 的 `data` 支持
  `target_terminal_id?`，缺省广播给全部 terminal。
- `pair_status_ack.terminal_ids?` 是 device 的对账列表；单个 terminal 断开只更新列表，
  device 断开才关闭全部 terminal 并发送 `DEVICE_OFFLINE`。
- terminal 上限默认 32（`maxTerminals` 可配置），超出回 `KICKED`。
```

- [ ] **Step 2: 更新官方契约文档**

在 `docs/web-remote-control/relay-v2-pairing.md` 的 WebSocket 契约表后增加一段“自托管扩展”说明：新增字段全部可选、官方 relay 仍是单 terminal、旧客户端不受影响。

- [ ] **Step 3: 标记旧 spec 被取代**

在 `docs/superpowers/specs/2026-10-20-self-hosted-relay-design.md` 的 §3.1 标题下增加：

```md
> 2026-10-21 更新：terminal 多连接语义由
> [multi-terminal 设计](./2026-10-21-multi-terminal-web-remote-control-design.md)
> 取代；device 角色“新替旧”不变。
```

- [ ] **Step 4: 提交**

```bash
git add apps/self-host-relay/src/CONTRACT.md docs/web-remote-control/relay-v2-pairing.md docs/superpowers/specs/2026-10-20-self-hosted-relay-design.md
git commit -m "docs(relay): document multi-terminal extension"
```

---

### Task 5: Client serializer target support and routing reserve

**Files:**

- Modify: `packages/client/src/webRemoteControlRelayPayloadSerializer.ts`
- Modify: `packages/shared/src/web-remote-control-rpc-transport.ts`
- Modify: `packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts`
- Test: `packages/client/test/webRemoteControlRelayPayloadSerializer.test.ts`
- Test: `packages/client/test/webRemoteControlRelayProtocol.test.ts`

**Interfaces:**

- Produces: `prepare(payload, clientTimestamp?, targetTerminalId?)`（target 计入 `bytes` 与缓存 key）、
  `WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.routingFieldReserveBytes: 1024`。

- [ ] **Step 1: 写失败测试**

```ts
it("includes target_terminal_id in JSON, byte count and cache key", () => {
  const serializer = new WebRemoteControlRelayPayloadSerializer();
  const payload: WebRemoteControlAppPayload = {
    zcode_type: "bootstrap-request",
    requestId: "request-targeted",
  };

  const targeted = serializer.prepare(payload, 100, "t_a");
  expect(targeted.message).toMatchObject({ target_terminal_id: "t_a" });
  expect(JSON.parse(targeted.json).target_terminal_id).toBe("t_a");
  expect(targeted.bytes).toBe(
    new TextEncoder().encode(targeted.json).byteLength,
  );
  expect(serializer.prepare(payload, 200, "t_a")).toBe(targeted);

  const other = serializer.prepare(payload, 100, "t_b");
  expect(other).not.toBe(targeted);
  expect(JSON.parse(other.json).target_terminal_id).toBe("t_b");

  const untargeted = serializer.prepare(payload, 100);
  expect(JSON.parse(untargeted.json).target_terminal_id).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/client/test/webRemoteControlRelayPayloadSerializer.test.ts`
Expected: FAIL，`prepare` 只有两个参数。

- [ ] **Step 3: 实现**

```ts
private readonly cache = new WeakMap<object, Map<string, SerializedWebRemoteControlRelayPayload>>();

prepare(
  payload: WebRemoteControlAppPayload,
  clientTimestamp = Math.floor(Date.now() / 1000),
  targetTerminalId?: string,
): SerializedWebRemoteControlRelayPayload {
  const cacheKey = targetTerminalId ?? "";
  let cachedByTarget = this.cache.get(payload);
  const cached = cachedByTarget?.get(cacheKey);
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
  if (!cachedByTarget) {
    cachedByTarget = new Map();
    this.cache.set(payload, cachedByTarget);
  }
  cachedByTarget.set(cacheKey, prepared);
  return prepared;
}
```

- [ ] **Step 4: 分片预算为路由字段预留余量（先写失败测试）**

`packages/client/test/webRemoteControlRelayProtocol.test.ts` 的
`createAcknowledgedWebRemoteControlRelayProtocol` describe 内新增（复用现有 `outbound` 收集
与 `isTransportFrame` helper，参照"2MB+7 消息分片"用例的写法）：

```ts
it("分片预算为 relay 路由字段预留余量：追加 target/from 字段后仍不超 1MiB", async () => {
  const outbound: WebRemoteControlRpcTransportPayload[] = [];
  const sender = createAcknowledgedWebRemoteControlRelayProtocol({
    ...acknowledgedIdentity,
    sendFrame: (payload) => {
      outbound.push(payload);
      return true;
    },
  });
  // codex 复现尺寸：900_000 字节消息按裸 envelope 贴满 1MiB 分片，
  // 追加路由字段后达 1_048_603 > 1_048_576。
  const bytes = new Uint8Array(900_000).fill(65);
  sender.protocol.send(VSBuffer.wrap(bytes));

  const frames = outbound.filter(isTransportFrame);
  expect(frames.length).toBeGreaterThan(0);
  expect(sender.protocol.isDegraded()).toBe(false);
  const limit = WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;
  // 最坏合法 terminal_id：identifier 上限 128 字符，控制字符 JSON 转义后每字符 6 字节。
  const worstTerminalId = "\u0000".repeat(128);
  const serializer = new WebRemoteControlRelayPayloadSerializer();
  for (const frame of frames) {
    // desktop 方向：serializer 附加 target_terminal_id 后的实际发送字节。
    expect(
      serializer.prepare(frame, 1_800_000_000, worstTerminalId).bytes,
    ).toBeLessThanOrEqual(limit);
    // web 方向：relay 附加 from_terminal_id 后 device 收到的字节。
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          type: "data",
          payload: frame,
          from_terminal_id: worstTerminalId,
          server_ts: 1_800_000_000,
        }),
      ).byteLength,
    ).toBeLessThanOrEqual(limit);
  }
});
```

顶部 import 补充 `WebRemoteControlRelayPayloadSerializer`（来自
`../src/webRemoteControlRelayPayloadSerializer.js`）。

- [ ] **Step 5: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/client/test/webRemoteControlRelayProtocol.test.ts`
Expected: 新增用例 FAIL——900_000 字节消息的分片 envelope 贴满 1MiB，追加路由字段后超限
（oversize 会使 protocol degraded 或断言字节数超限）。

- [ ] **Step 6: 实现预留**

`packages/shared/src/web-remote-control-rpc-transport.ts` 的 limits 对象新增：

```ts
export const WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS = {
  maxPhysicalFrameBytes: PROTOCOL_V4_LIMITS.maxFrameBytes,
  // relay 多 terminal 路由字段（target/from_terminal_id）在分片之后追加到最终 wire envelope；
  // terminal_id ≤128 字节、JSON 转义最坏 ×6，加字段名与引号 <1024。分片预算按本值预留，
  // 否则贴满 1MiB 的合法大 RPC 会在追加路由字段后被 oversize 拒绝并 degraded bridge。
  routingFieldReserveBytes: 1024,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFragments: 64,
  assemblyTimeoutMs: 30_000,
  transportIdMaxChars: PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars,
} as const;
```

`packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts` 的 `reserveMessage` 中，
encode 调用显式传入缩减后的分片预算：

```ts
frames = encodeWebRemoteControlRpcTransportMessage(bytes, {
  ...this.identity,
  firstPhysicalSeq: this.nextPhysicalSeq,
  messageSeq: this.nextMessageSeq,
  maxPhysicalFrameBytes:
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes -
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.routingFieldReserveBytes,
});
```

（`WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS` 已在该文件 import，确认包含新常量即可。）

- [ ] **Step 7: 运行测试确认通过**

Run: `mise exec -- pnpm exec vitest run packages/client/test/webRemoteControlRelayProtocol.test.ts packages/client/test/webRemoteControlRelayPayloadSerializer.test.ts packages/shared/test/webRemoteControlRpcTransport.test.ts`
Expected: PASS——新增预留用例通过；既有分片用例（小消息、显式小预算 override）不受影响。

- [ ] **Step 8: 提交**

```bash
git add packages/client/src/webRemoteControlRelayPayloadSerializer.ts packages/shared/src/web-remote-control-rpc-transport.ts packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts packages/client/test/webRemoteControlRelayPayloadSerializer.test.ts packages/client/test/webRemoteControlRelayProtocol.test.ts
git commit -m "feat(client): support targeted serialization and routing reserve"
```

---

### Task 6: Desktop device transport routing metadata

**Files:**

- Modify: `packages/desktop/src/main/web-remote-relay/contract.ts`
- Modify: `packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts`
- Modify: `packages/shared/test/fixtures/fake-relay-v2.ts`
- Test: `packages/desktop/test/webRemoteControlTransport.test.ts`
- Test: `packages/shared/test/fakeRelayV2.test.ts`（更新精确 ACK 断言）

**Interfaces:**

- Consumes: Task 1 schema、Task 5 serializer。
- Produces:
  - `WebRemoteControlDeviceTransportOptions.onPayload(payload, terminalId?)`
  - `onRawTransportPayload?(payload, terminalId?)`
  - `onTerminalIdsChange?(terminalIds: string[])`
  - `sendPayloadResult(payload, targetTerminalId?)`
  - `measurePayloadBytes(payload, targetTerminalId?)`

- [ ] **Step 1: 写失败测试**

在 `packages/desktop/test/webRemoteControlTransport.test.ts` 增加：

```ts
it("透传 from_terminal_id、发送 target_terminal_id、上报 terminal_ids", async () => {
  const relay = await createFakeRelayV2({ users: { jwt: "user" } });
  cleanups.push(() => relay.close());
  const terminalId = "t_page";
  const onPayload = vi.fn();
  const onTerminalIdsChange = vi.fn();
  const { data: device } = await (
    await fetch(`${relay.httpUrl}/api/v1/remote/device`, {
      method: "POST",
      headers: {
        Authorization: "Bearer jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_mid: "mid-1" }),
    })
  ).json();
  const transport = new WebRemoteControlDeviceTransport({
    relayWsUrl: relay.wsUrl,
    deviceMid: "mid-1",
    getToken: (signal) =>
      createWebRemoteControlV2Http(relay.httpUrl).token("jwt", signal),
    resolveDeviceSid: async () => device.device_sid,
    meta: { name: "desktop" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onStateChange: vi.fn(),
    onPayload,
    onTerminalIdsChange,
    onError: vi.fn(),
  });
  cleanups.push(() => transport.dispose());
  transport.start();
  await vi.waitFor(() =>
    expect(relay.messages.some((entry) => entry.role === "device")).toBe(true),
  );

  // 模拟 relay 侧已有一个 terminal 并让它发来 data。
  const terminal = await (async () => {
    const {
      data: { token },
    } = await (
      await fetch(`${relay.httpUrl}/api/v1/remote/token`, {
        method: "POST",
        headers: {
          Authorization: "Bearer jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "terminal" }),
      })
    ).json();
    const socket = new WebSocket(relay.wsUrl + `?token=${token}`);
    cleanups.push(() => socket.close());
    await new Promise<void>((resolve) =>
      socket.addEventListener("open", () => resolve(), { once: true }),
    );
    socket.send(
      JSON.stringify({
        type: "auth_init",
        device_sid: device.device_sid,
        terminal_id: terminalId,
      }),
    );
    return socket;
  })();

  await vi.waitFor(() =>
    expect(onTerminalIdsChange).toHaveBeenCalledWith([terminalId]),
  );
  const appPayload = {
    zcode_type: "bootstrap-request",
    requestId: "from-terminal",
  };
  terminal.send(JSON.stringify({ type: "data", payload: appPayload }));
  await vi.waitFor(() =>
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining(appPayload),
      terminalId,
    ),
  );

  transport.sendPayloadResult(
    {
      zcode_type: "bootstrap-response",
      requestId: "r",
      success: true,
      result: {} as never,
    },
    terminalId,
  );
  await vi.waitFor(() =>
    expect(relay.messages).toContainEqual(
      expect.objectContaining({
        role: "device",
        message: expect.objectContaining({ target_terminal_id: terminalId }),
      }),
    ),
  );
});
```

`createFakeRelayV2` 需要同步扩展（测试基础设施）：

- `Connection` 增加 `terminalId?: string`，terminal 认证时设为
  `parsed.terminal_id ?? connection.terminalSid`；
- terminal 认证成功时，给 device 的 `pair_status_ack` 附带
  `terminal_ids: [connection.terminalId]`（这是 desktop transport 触发
  `onTerminalIdsChange` 的来源）；
- terminal → device 的 `data` 附带 `from_terminal_id: connection.terminalId`；
- device → terminal 的 `data` 若带 `target_terminal_id` 且与目标 terminal 的 id 不符，则丢弃；
- device 的 `pair_status_ack`（仅 device 角色）附带
  `terminal_ids: other ? [other.terminalId] : []`；
- terminal 断开时给 device 的推送附带 `terminal_ids: []`；
- `packages/shared/test/fakeRelayV2.test.ts` 中两处精确的 `toContainEqual` ACK 断言
  （terminal 认证后的 matched 推送、device 的 `pair_status_query` 应答）补上
  `terminal_ids: [expect.stringMatching(/^t_/)]` 或 `terminal_ids: []`，否则新增字段会让
  精确匹配失败。

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlTransport.test.ts`
Expected: FAIL，回调没有第二个参数、发送没有 target、fake relay 不识别新字段。

- [ ] **Step 3: 实现**

`packages/desktop/src/main/web-remote-relay/contract.ts`：

```ts
onPayload(payload: WebRemoteControlAppPayload, terminalId?: string): void;
onRawTransportPayload?(payload: unknown, terminalId?: string): boolean;
onTerminalIdsChange?(terminalIds: string[]): void;
```

`webRemoteControlTransport.ts`：

```ts
measurePayloadBytes(payload: WebRemoteControlAppPayload, targetTerminalId?: string): number {
  return this.serializer.prepare(
    payload,
    Math.floor(Date.now() / 1000),
    targetTerminalId,
  ).bytes;
}

sendPayloadResult(
  payload: WebRemoteControlAppPayload,
  targetTerminalId?: string,
): WebRemoteControlPayloadSendResult {
  const prepared = this.serializer.prepare(
    payload,
    Math.floor(Date.now() / 1000),
    targetTerminalId,
  );
  if (this.serializer.isOversize(prepared)) {
    return {
      kind: "oversize",
      bytes: prepared.bytes,
      maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    };
  }
  if (this.state !== "paired" || this.socket?.readyState !== WebSocket.OPEN)
    return { kind: "unavailable" };
  this.socket.send(prepared.json);
  return { kind: "sent", bytes: prepared.bytes };
}
```

在 `handleMessage` 中：

```ts
} else if (message.type === "data" && this.state === "paired") {
  const value = message.payload;
  if (
    value &&
    typeof value === "object" &&
    "zcode_type" in value &&
    (value.zcode_type === "rpc-frame" || value.zcode_type === "rpc-frame-ack") &&
    this.options.onRawTransportPayload?.(value, message.from_terminal_id)
  )
    return;
  const payload = parseWebRemoteControlAppPayload(value);
  if (payload) this.options.onPayload(payload, message.from_terminal_id);
}
```

在 `auth_ack` / `pair_status_ack` 处理之后：

```ts
if (
  (message.type === "auth_ack" || message.type === "pair_status_ack") &&
  message.terminal_ids
) {
  this.options.onTerminalIdsChange?.(message.terminal_ids);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlTransport.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/web-remote-relay/contract.ts packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts packages/shared/test/fixtures/fake-relay-v2.ts packages/desktop/test/webRemoteControlTransport.test.ts
git commit -m "feat(desktop): route relay data by terminal id"
```

---

### Task 7: Manager session indirection（行为不变）

**Files:**

- Modify: `packages/desktop/src/main/webRemoteControlManager.ts`
- Test: `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`

**Interfaces:**

- Consumes: Task 6 的 transport 回调。
- Produces: `TerminalSession`、`terminalSessions`、`LEGACY_TERMINAL_SESSION_KEY`（空串）、session 级别的全部 helper；对外行为与单 terminal 完全一致。

**迁移映射（逐项替换）：**

| 旧                                                     | 新                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `runtime.currentBridge`                                | `session.currentBridge`                                                |
| `runtime.bridgeOpen`                                   | `session.bridgeOpen`                                                   |
| `runtime.pendingBridgeInvalidation`                    | `session.pendingBridgeInvalidation`                                    |
| `runtime.pendingOutboundPayloads`                      | `session.pendingOutboundPayloads`                                      |
| `runtime.pendingOutboundPayloadTimer`                  | `session.pendingOutboundPayloadTimer`                                  |
| `runtime.mobileViewState`                              | `session.mobileViewState`（同时写 `runtime.mobileViewState` 共享偏好） |
| `runtime.mobileTaskView`                               | `session.mobileTaskView`                                               |
| `runtime.mobileTaskViewEpoch`                          | `session.mobileTaskViewEpoch`                                          |
| `runtime.mobileTaskViewSeq`                            | `session.mobileTaskViewSeq`                                            |
| `runtime.mobileDeviceInfo`                             | `session.mobileDeviceInfo`                                             |
| `cancelBridgeOpen(runtime)`                            | `cancelBridgeOpen(runtime, session)`                                   |
| `disposeRuntimeBridgeResources(runtime)`               | `disposeRuntimeBridgeResources(runtime, session)`                      |
| `isCurrentBridgeRuntime(runtime, bridge)`              | `isCurrentBridgeRuntime(runtime, session, bridge)`                     |
| `degradeBridgeAfterRawFault(runtime, ...)`             | `degradeBridgeAfterRawFault(runtime, session, ...)`                    |
| `clearMobileTaskView(runtime)`                         | `clearMobileTaskView(runtime, session)`                                |
| `createWorkspaceBridge(runtime, request)`              | `createWorkspaceBridge(runtime, session, request)`                     |
| `buildWorkspaceBridge(runtime, request, ...)`          | `buildWorkspaceBridge(runtime, session, request, ...)`                 |
| `respondToWorkspaceBridgeOpen(runtime, ...)`           | `respondToWorkspaceBridgeOpen(runtime, session, ...)`                  |
| `respondToPlatformRequest(runtime, payload)`           | `respondToPlatformRequest(runtime, session, payload)`                  |
| `respondToWorkspaceReconnectRequest(runtime, payload)` | `respondToWorkspaceReconnectRequest(runtime, session, payload)`        |
| `routeRpcTransportPayload(runtime, payload)`           | `routeRpcTransportPayload(runtime, session, payload)`                  |
| `logMobileDiagnostic(runtime, payload)`                | `logMobileDiagnostic(runtime, session, payload)`                       |
| `sendPendingBridgeInvalidation(runtime)`               | `sendPendingBridgeInvalidation(runtime, session)`                      |
| `bufferOutboundPayload(runtime, payload)`              | `bufferOutboundPayload(runtime, session, payload)`                     |
| `flushPendingOutboundPayloads(runtime)`                | `flushPendingOutboundPayloads(runtime, session)`                       |
| `sendAppPayload(runtime, payload)`                     | `sendAppPayload(runtime, payload, session?)`                           |
| `routePayload(runtime, payload)`                       | `routePayload(runtime, session, payload)`                              |
| `routeRawTransportCandidate(runtime, payload)`         | `routeRawTransportCandidate(runtime, session, payload)`                |
| `applyMobileViewStateUpdate(runtime, ...)`             | `applyMobileViewStateUpdate(runtime, session, ...)`                    |
| `applyMobileTaskViewUpdate(runtime, payload)`          | `applyMobileTaskViewUpdate(runtime, session, payload)`                 |
| `requestMobileTaskView(runtime)`                       | `requestMobileTaskView(runtime, session)`                              |
| `getRuntimeWorkspaceTarget(runtime)`                   | `getSessionWorkspaceTarget(runtime, session)`                          |
| `getAvailableWorkspaces(runtime)`                      | `getAvailableWorkspaces(runtime, session)`                             |
| `buildBootstrapResult(runtime)`                        | `buildBootstrapResult(runtime, session)`                               |
| `buildWorkspaceListResult(runtime)`                    | `buildWorkspaceListResult(runtime, session)`                           |
| `pushWorkspaceListUpdated(runtime)`                    | 遍历 session，逐个 `pushWorkspaceListUpdated(runtime, session)`        |

- [ ] **Step 1: 写失败测试**

在 `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts` 的 harness 中：

```ts
let deliverPayload:
  | ((payload: WebRemoteControlAppPayload, terminalId?: string) => void)
  | undefined;
let emitTerminalIds: ((terminalIds: string[]) => void) | undefined;
const sentTargets: (string | undefined)[] = [];
let attachmentSeq = 0;

// 默认 attach mock 改为每次返回新 attachment，第一个仍是 attachment-1。
const defaultAttachWorkspaceHost = vi.fn(async () => ({
  entryId: `entry-${++attachmentSeq}`,
  attachmentId: `attachment-${attachmentSeq}`,
  process: {} as never,
  port: createFakePort() as never,
}));

// createDeviceTransport 的 start() 内，现有 deliverPayload 赋值之后：
emitTerminalIds = transportOptions.onTerminalIdsChange;

// fake transport 的 sendPayloadResult 增加 target 参数：
sendPayloadResult: (payload, targetTerminalId) => {
  sentTargets.push(targetTerminalId);
  sentPayloads.push(payload);
  return { kind: "sent" as const, bytes: JSON.stringify(payload).length };
},

// 返回值增加：
emitTerminalIds: (terminalIds) => {
  if (!emitTerminalIds) throw new Error("transport not started");
  emitTerminalIds(terminalIds);
},
deliverPayload: (payload, terminalId) => {
  if (!deliverPayload) throw new Error("transport not started");
  deliverPayload(payload, terminalId);
},
sentTargets,
```

添加测试：

```ts
it("带 terminalId 的请求响应会定向发送；缺省时保持旧行为", async () => {
  const h = createManagerHarness();
  await h.manager.start(1, { workspacePath: localWorkspace.workspacePath });
  h.emitTransportState("paired");
  h.sentPayloads.length = 0;
  h.sentTargets.length = 0;

  h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "r-a" }, "tA");
  h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "r-b" });
  await vi.waitFor(() =>
    expect(
      h.sentPayloads.filter((p) => p.zcode_type === "bootstrap-response"),
    ).toHaveLength(2),
  );

  const bootstrapTargets = h.sentPayloads
    .map((payload, index) => ({ payload, target: h.sentTargets[index] }))
    .filter((entry) => entry.payload.zcode_type === "bootstrap-response")
    .map((entry) => entry.target);
  expect(bootstrapTargets).toEqual(["tA", undefined]);
  expect(h.sentPayloads).toContainEqual(
    expect.objectContaining({
      zcode_type: "bootstrap-response",
      requestId: "r-a",
    }),
  );
  await h.manager.stop(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
Expected: FAIL，`onTerminalIdsChange` / 第二个参数 / `sentTargets` 未接线。

- [ ] **Step 3: 实现 session 间接层**

在 `packages/desktop/src/main/webRemoteControlManager.ts`：

1. 添加类型与常量：

```ts
// legacy 兼容 session 的 map 键：wire identifier 强制非空白，空串不会与真实 terminal_id 冲突。
// 不用 "default" 这类字面值——它在 schema 上是合法 terminal_id，会被对账逻辑误删。
const LEGACY_TERMINAL_SESSION_KEY = "";

interface TerminalSession {
  terminalId: string;
  currentBridge?: WorkspaceBridgeRuntime;
  bridgeOpen?: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    intentKey: string;
    hostRequestId: string;
    preparingProject: boolean;
    promise: Promise<WebRemoteControlExternalWorkspaceBridge>;
  };
  pendingBridgeInvalidation?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "bridge-degraded" }
  >;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileTaskView?: NonNullable<WebRemoteControlStatus["mobileTaskView"]>;
  mobileTaskViewEpoch?: string;
  mobileTaskViewSeq?: number;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  lastActivityAt: number;
  detachedAt?: number;
  detachTimer?: ReturnType<typeof setTimeout>;
  workspaceListSignature?: string;
}
```

2. `WindowControlRuntime` 删除上述下沉字段，新增：

```ts
terminalSessions: Map<string, TerminalSession>;
mobileViewState?: WebRemoteControlMobileViewState;
```

3. 添加 helper：

```ts
function createTerminalSession(terminalId: string): TerminalSession {
  return {
    terminalId,
    pendingOutboundPayloads: [],
    lastActivityAt: Date.now(),
  };
}

function getOrCreateTerminalSession(
  runtime: WindowControlRuntime,
  terminalId?: string,
): TerminalSession {
  const id = terminalId ?? LEGACY_TERMINAL_SESSION_KEY;
  let session = runtime.terminalSessions.get(id);
  if (!session) {
    session = createTerminalSession(id);
    runtime.terminalSessions.set(id, session);
    if (runtime.transportState === "paired") {
      session.mobileTaskViewEpoch = randomUUID();
      session.mobileTaskViewSeq = -1;
      requestMobileTaskView(runtime, session);
    }
  }
  session.lastActivityAt = Date.now();
  return session;
}

function getStatusProjection(
  runtime: WindowControlRuntime,
): TerminalSession | undefined {
  let latest: TerminalSession | undefined;
  for (const session of runtime.terminalSessions.values()) {
    if (session.detachedAt !== undefined) continue;
    if (!latest || session.lastActivityAt > latest.lastActivityAt)
      latest = session;
  }
  if (latest) return latest;
  for (const session of runtime.terminalSessions.values()) {
    if (!latest || session.lastActivityAt > latest.lastActivityAt)
      latest = session;
  }
  return latest;
}
```

4. 按迁移映射逐个函数改签名。关键实现：

```ts
function sendPayloadToTransport(
  runtime: WindowControlRuntime,
  payload: WebRemoteControlAppPayload,
  session: TerminalSession,
): WebRemoteControlPayloadSendResult {
  const target =
    session.terminalId === LEGACY_TERMINAL_SESSION_KEY
      ? undefined
      : session.terminalId;
  if (runtime.transport.sendPayloadResult) {
    return runtime.transport.sendPayloadResult(payload, target);
  }
  return runtime.transport.sendPayload(payload)
    ? { kind: "sent", bytes: 0 }
    : { kind: "unavailable" };
}
```

`buildWorkspaceBridge` 里构造 relayProtocol 的 `measureFrameBytes` 也必须带同一个
target，否则预算字节数与实际发送的 JSON（含 `target_terminal_id`）不一致：

```ts
measureFrameBytes: (frame) =>
  runtime.transport.measurePayloadBytes?.(
    frame,
    session.terminalId === LEGACY_TERMINAL_SESSION_KEY
      ? undefined
      : session.terminalId,
  ) ?? measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
```

```ts
function sendAppPayload(
  runtime: WindowControlRuntime,
  payload: WebRemoteControlAppPayload,
  session?: TerminalSession,
): void {
  if (session) {
    sendAppPayloadToSession(runtime, payload, session);
    return;
  }
  if (runtime.terminalSessions.size === 0) {
    sendAppPayloadToSession(
      runtime,
      payload,
      getOrCreateTerminalSession(runtime),
    );
    return;
  }
  for (const target of runtime.terminalSessions.values()) {
    sendAppPayloadToSession(runtime, payload, target);
  }
}

function sendAppPayloadToSession(
  runtime: WindowControlRuntime,
  payload: WebRemoteControlAppPayload,
  session: TerminalSession,
): void {
  if (session.pendingOutboundPayloads.length > 0) {
    bufferOutboundPayload(runtime, session, payload);
    flushPendingOutboundPayloads(runtime, session);
    return;
  }
  const result = sendPayloadToTransport(runtime, payload, session);
  if (result.kind === "sent") return;
  if (result.kind === "oversize") {
    dependencies.logger.warn(
      "[web-remote-control] rejected oversize app payload",
      {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        terminalId: session.terminalId,
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      },
    );
    return;
  }
  bufferOutboundPayload(runtime, session, payload);
}

function bufferOutboundPayload(
  runtime: WindowControlRuntime,
  session: TerminalSession,
  payload: WebRemoteControlAppPayload,
): void {
  if (session.pendingOutboundPayloads.length >= 50) {
    const droppedCount = session.pendingOutboundPayloads.length + 1;
    session.pendingOutboundPayloads.length = 0;
    clearPendingOutboundPayloadTimer(session);
    dependencies.logger.warn(
      "[web-remote-control] dropped overflowing outbound payloads",
      {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        terminalId: session.terminalId,
        droppedCount,
      },
    );
    return;
  }
  session.pendingOutboundPayloads.push(payload);
  schedulePendingOutboundPayloadTimeout(runtime, session);
}

function flushPendingOutboundPayloads(
  runtime: WindowControlRuntime,
  session: TerminalSession,
): void {
  while (session.pendingOutboundPayloads.length > 0) {
    const payload = session.pendingOutboundPayloads[0]!;
    const result = sendPayloadToTransport(runtime, payload, session);
    if (result.kind === "unavailable") {
      schedulePendingOutboundPayloadTimeout(runtime, session);
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn(
        "[web-remote-control] dropped oversize app payload",
        {
          windowId: runtime.windowId,
          session: runtime.deviceSid,
          terminalId: session.terminalId,
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        },
      );
    }
    session.pendingOutboundPayloads.shift();
  }
  clearPendingOutboundPayloadTimer(session);
}

function clearPendingOutboundPayloadTimer(session: TerminalSession): void {
  if (!session.pendingOutboundPayloadTimer) return;
  clearTimeout(session.pendingOutboundPayloadTimer);
  session.pendingOutboundPayloadTimer = undefined;
}

function schedulePendingOutboundPayloadTimeout(
  runtime: WindowControlRuntime,
  session: TerminalSession,
): void {
  if (
    session.pendingOutboundPayloadTimer ||
    session.pendingOutboundPayloads.length === 0
  ) {
    return;
  }
  session.pendingOutboundPayloadTimer = setTimeout(() => {
    session.pendingOutboundPayloadTimer = undefined;
    const droppedCount = session.pendingOutboundPayloads.splice(0).length;
    dependencies.logger.warn(
      "[web-remote-control] dropped buffered outbound payloads",
      {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        terminalId: session.terminalId,
        droppedCount,
      },
    );
  }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
}
```

5. 接线：

```ts
onPayload: (payload, terminalId) =>
  routePayload(runtime, getOrCreateTerminalSession(runtime, terminalId), payload),
onRawTransportPayload: (payload, terminalId) =>
  routeRawTransportCandidate(runtime, getOrCreateTerminalSession(runtime, terminalId), payload),
onTerminalIdsChange: (terminalIds) => {
  if (runtimes.get(windowId) !== runtime) return;
  reconcileTerminalIds(runtime, terminalIds);
},
onRawTransportFault: (reasonCode) => {
  // 入站裸帧超限在解析前无法归属 terminal，按 transport 级故障处理：
  // 所有 session 的 bridge 都标记 degraded，各页面走自己的既有恢复链路。
  for (const session of runtime.terminalSessions.values()) {
    degradeBridgeAfterRawFault(runtime, session, reasonCode);
  }
},
```

6. `buildRuntimeStatus` 使用投影：

```ts
const projected = getStatusProjection(runtime);
return {
  // ...
  mobileViewState: runtime.mobileViewState,
  mobileTaskView: projected?.mobileTaskView ?? null,
  mobileDeviceInfo: projected?.mobileDeviceInfo,
  initialTaskId:
    projected?.currentBridge?.initialTaskId ?? runtime.initialTaskId,
};
```

7. `mapTransportState`、`onSendReady`、`preserveWindowRuntimeFailure`、`stopWindowRuntime` 改为遍历 `runtime.terminalSessions.values()`。

8. `disposeRuntimeBridgeResources`、`cancelBridgeOpen`、`clearMobileTaskView` 改为接收
   `(runtime, session)`；`isCurrentBridgeRuntime`、`degradeBridgeAfterRawFault` 同样
   带上 session。

9. `pushWorkspaceListUpdated` 改为：

```ts
function pushWorkspaceListUpdated(runtime: WindowControlRuntime): void {
  for (const session of runtime.terminalSessions.values()) {
    pushWorkspaceListUpdatedForSession(runtime, session);
  }
}
```

`pushWorkspaceListUpdatedForSession` 用 `session.workspaceListSignature` 做去重。

10. `reconcileTerminalIds` 先在 Task 8 实现；本任务写成空实现，保证 typecheck 通过且单
    terminal 行为不变：

```ts
function reconcileTerminalIds(
  runtime: WindowControlRuntime,
  terminalIds: string[],
): void {
  void runtime;
  void terminalIds;
}
```

Task 8 再补全集合对账与宽限期逻辑。

- [ ] **Step 4: 运行现有测试确认单 terminal 行为不变**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
Expected: PASS（所有既有用例与新增定向用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/webRemoteControlManager.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts
git commit -m "refactor(desktop): introduce terminal session indirection"
```

---

### Task 8: Session reconciliation and grace lifecycle

**Files:**

- Modify: `packages/desktop/src/main/webRemoteControlManager.ts`
- Create: `packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts`

**Interfaces:**

- Consumes: Task 7 的 `TerminalSession`、`terminalSessions`。
- Produces: `reconcileTerminalIds`、`markSessionDetached`、`disposeTerminalSession`、30s 宽限。

- [ ] **Step 1: 写失败测试**

新建 `packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts`，复用
`webRemoteControlManagerExternalRelay.test.ts` 的 harness（把 harness 导出或复制最小版本）。

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
// 复用 createManagerHarness（从同目录测试文件导出，或复制该文件的 harness 函数）。

describe("web remote control multi-terminal sessions", () => {
  afterEach(() => vi.useRealTimers());

  it("terminal 从集合消失后 30s 才释放，宽限内重连保留 bridge", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath: "/workspace/demo" });
    h.emitTransportState("paired");
    h.deliverPayload(
      {
        zcode_type: "workspace-bridge-open",
        requestId: "bridge-a",
        bridgeSessionId: "bridge-a",
        workspaceKey: "/workspace/demo",
      },
      "tA",
    );
    await vi.waitFor(() =>
      expect(h.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-a",
        }),
      ),
    );
    const attachmentA = (
      await h.defaultAttachWorkspaceHost.mock.results[0]!.value
    ).attachmentId;

    vi.useFakeTimers();
    h.emitTerminalIds([]);
    await vi.advanceTimersByTimeAsync(10_000);
    h.deliverPayload(
      { zcode_type: "bootstrap-request", requestId: "back" },
      "tA",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith(
      attachmentA,
    );

    h.emitTerminalIds([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(attachmentA);
    await h.manager.stop(1);
  });

  it("关闭一个 terminal 不影响另一个的 bridge", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath: "/workspace/demo" });
    h.emitTransportState("paired");
    for (const id of ["tA", "tB"]) {
      h.deliverPayload(
        {
          zcode_type: "workspace-bridge-open",
          requestId: `bridge-${id}`,
          bridgeSessionId: `bridge-${id}`,
          workspaceKey: "/workspace/demo",
        },
        id,
      );
    }
    await vi.waitFor(() =>
      expect(
        h.sentPayloads.filter((p) => p.zcode_type === "workspace-bridge-ready"),
      ).toHaveLength(2),
    );
    const [a, b] = (
      await Promise.all(
        h.defaultAttachWorkspaceHost.mock.results.map((result) => result.value),
      )
    ).map((result) => result.attachmentId);

    vi.useFakeTimers();
    h.emitTerminalIds(["tB"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(a);
    expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith(b);
    await h.manager.stop(1);
  });

  it("停止窗口立即释放全部 session", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath: "/workspace/demo" });
    h.emitTransportState("paired");
    for (const id of ["tA", "tB"]) {
      h.deliverPayload(
        {
          zcode_type: "workspace-bridge-open",
          requestId: `bridge-${id}`,
          bridgeSessionId: `bridge-${id}`,
          workspaceKey: "/workspace/demo",
        },
        id,
      );
    }
    await vi.waitFor(() =>
      expect(h.defaultAttachWorkspaceHost).toHaveBeenCalledTimes(2),
    );
    const [a, b] = (
      await Promise.all(
        h.defaultAttachWorkspaceHost.mock.results.map((result) => result.value),
      )
    ).map((result) => result.attachmentId);
    await h.manager.stop(1);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(a);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(b);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts`
Expected: FAIL，session 不会被回收。

- [ ] **Step 3: 实现宽限与释放**

```ts
const TERMINAL_SESSION_GRACE_MS = 30_000;

function cancelSessionDetach(session: TerminalSession): void {
  if (session.detachTimer) clearTimeout(session.detachTimer);
  session.detachTimer = undefined;
  session.detachedAt = undefined;
}

function disposeTerminalSession(
  runtime: WindowControlRuntime,
  session: TerminalSession,
): void {
  if (runtime.terminalSessions.get(session.terminalId) !== session) return;
  cancelSessionDetach(session);
  if (session.pendingOutboundPayloadTimer) {
    clearTimeout(session.pendingOutboundPayloadTimer);
    session.pendingOutboundPayloadTimer = undefined;
  }
  cancelBridgeOpen(runtime, session);
  disposeRuntimeBridgeResources(runtime, session);
  session.pendingOutboundPayloads.length = 0;
  runtime.terminalSessions.delete(session.terminalId);
  emitRuntimeStatus(runtime);
}

function markSessionDetached(
  runtime: WindowControlRuntime,
  session: TerminalSession,
): void {
  if (session.detachedAt !== undefined) return;
  session.detachedAt = Date.now();
  session.detachTimer = setTimeout(() => {
    session.detachTimer = undefined;
    if (runtime.terminalSessions.get(session.terminalId) !== session) return;
    disposeTerminalSession(runtime, session);
  }, TERMINAL_SESSION_GRACE_MS);
}

function reconcileTerminalIds(
  runtime: WindowControlRuntime,
  terminalIds: string[],
): void {
  const present = new Set(terminalIds);
  for (const session of [...runtime.terminalSessions.values()]) {
    if (session.terminalId === LEGACY_TERMINAL_SESSION_KEY) {
      if (present.size > 0) disposeTerminalSession(runtime, session);
      else markSessionDetached(runtime, session);
      continue;
    }
    if (present.has(session.terminalId)) {
      cancelSessionDetach(session);
    } else {
      markSessionDetached(runtime, session);
    }
  }
}
```

`getOrCreateTerminalSession` 在新 session 创建/复用开始时调用 `cancelSessionDetach(session)`。

`emitRuntimeStatus` 增加 guard，避免 `stopWindowRuntime` 删除 runtime 后，逐个 dispose
session 时又把 active 状态推回 UI：

```ts
function emitRuntimeStatus(runtime: WindowControlRuntime): void {
  if (runtimes.get(runtime.windowId) !== runtime) return;
  dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
}
```

在 `preserveWindowRuntimeFailure` 和 `stopWindowRuntime` 中：

```ts
for (const session of [...runtime.terminalSessions.values()]) {
  disposeTerminalSession(runtime, session);
}
```

在 `mapTransportState` 的 `state === "error" || state === "kicked"` 分支同样立即释放。

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/webRemoteControlManager.ts packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts
git commit -m "feat(desktop): reconcile terminal sessions with grace period"
```

---

### Task 9: Per-session view, task view and self-heal

**Files:**

- Modify: `packages/desktop/src/main/webRemoteControlManager.ts`
- Test: `packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts`

**Interfaces:**

- Consumes: Task 8 的 session 生命周期。
- Produces: 每 session 的 `mobileViewState` / `mobileTaskView` / epoch / workspace-list 签名；未知 bridge 的自愈。

- [ ] **Step 1: 写失败测试**

```ts
it("两个 session 的 bootstrap 和 workspace-list 推送互不串台", async () => {
  const h = createManagerHarness();
  await h.manager.start(1, { workspacePath: "/workspace/demo" });
  h.emitTransportState("paired");
  h.sentPayloads.length = 0;
  h.sentTargets.length = 0;

  h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "a" }, "tA");
  h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "b" }, "tB");
  await vi.waitFor(() =>
    expect(
      h.sentPayloads.filter((p) => p.zcode_type === "bootstrap-response"),
    ).toHaveLength(2),
  );
  const bootstrapTargets = h.sentPayloads
    .map((payload, index) => ({ payload, target: h.sentTargets[index] }))
    .filter((entry) => entry.payload.zcode_type === "bootstrap-response")
    .map((entry) => entry.target);
  expect(bootstrapTargets).toEqual(["tA", "tB"]);

  h.sentPayloads.length = 0;
  h.sentTargets.length = 0;
  h.manager.syncAvailableWorkspaces(1, [
    { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
  ]);
  await vi.waitFor(() =>
    expect(
      h.sentPayloads.filter((p) => p.zcode_type === "workspace-list-updated"),
    ).toHaveLength(2),
  );
  expect(h.sentTargets).toEqual(["tA", "tB"]);
  await h.manager.stop(1);
});

it("session 丢失 bridge 后收到旧 rpc-frame 会定向回 bridge-degraded", async () => {
  const h = createManagerHarness();
  await h.manager.start(1, { workspacePath: "/workspace/demo" });
  h.emitTransportState("paired");
  h.sentPayloads.length = 0;

  const [frame] = encodeWebRemoteControlRpcTransportMessage(
    new Uint8Array([1, 2, 3]),
    {
      bridgeSessionId: "bridge-lost",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    },
  );
  h.deliverPayload(frame, "tA");

  await vi.waitFor(() =>
    expect(h.sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "bridge-degraded",
        bridgeSessionId: "bridge-lost",
      }),
    ),
  );
  expect(h.sentTargets.at(-1)).toBe("tA");
  await h.manager.stop(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts`
Expected: FAIL，推送没有按 session 拆分，旧帧被静默丢弃。

- [ ] **Step 3: 实现**

1. `applyMobileViewStateUpdate`：

```ts
function applyMobileViewStateUpdate(
  runtime: WindowControlRuntime,
  session: TerminalSession,
  viewState: WebRemoteControlMobileViewState,
  deviceInfo?: WebRemoteControlMobileDeviceInfo,
): void {
  session.mobileViewState = viewState;
  runtime.mobileViewState = viewState;
  if (deviceInfo) session.mobileDeviceInfo = deviceInfo;
  session.lastActivityAt = Date.now();
}
```

2. `applyMobileTaskViewUpdate` 用 `session.currentBridge` / `session.mobileTaskViewEpoch` /
   `session.mobileTaskViewSeq`，写入 `session.mobileTaskView`。

3. `buildBootstrapResult(runtime, session)`：

```ts
mobileViewState: session.mobileViewState ?? runtime.mobileViewState,
mobileTaskViewEpoch: session.mobileTaskViewEpoch,
```

4. `buildWorkspaceListResult(runtime, session)` 使用 `session.mobileViewState ?? runtime.mobileViewState` 和
   `session.currentBridge`。

5. `pushWorkspaceListUpdatedForSession` 用 `session.workspaceListSignature` 去重并定向发送。

6. `routeRawTransportCandidate`：

在 manager 顶部的 `@zcode/shared` import 中加入
`parseWebRemoteControlRpcTransportPayload`。

```ts
function routeRawTransportCandidate(
  runtime: WindowControlRuntime,
  session: TerminalSession,
  payload: unknown,
): boolean {
  const bridge = session.currentBridge;
  if (
    bridge &&
    !bridge.degraded &&
    bridge.relayProtocol?.acceptPayload(payload)
  ) {
    return true;
  }
  if (session.terminalId === LEGACY_TERMINAL_SESSION_KEY) return false;
  const parsed = parseWebRemoteControlRpcTransportPayload(payload);
  if (!parsed) return false;
  sendAppPayload(
    runtime,
    {
      zcode_type: "bridge-degraded",
      bridgeSessionId: parsed.bridgeSessionId,
      reason: "source-session-replaced",
    },
    session,
  );
  return false;
}
```

`bridgeSessionId` 在两个 union 分支都存在，可直接读取；若类型收窄不通过，用
`"bridgeSessionId" in parsed ? parsed.bridgeSessionId : undefined`。

7. `mapTransportState` 的 paired 分支：

```ts
for (const session of runtime.terminalSessions.values()) {
  session.mobileTaskViewEpoch = randomUUID();
  session.mobileTaskViewSeq = -1;
  session.mobileTaskView = undefined;
  requestMobileTaskView(runtime, session);
}
```

非 paired 分支：

```ts
for (const session of runtime.terminalSessions.values()) {
  session.mobileTaskViewEpoch = undefined;
  session.mobileTaskViewSeq = undefined;
  session.mobileTaskView = undefined;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm exec vitest run packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/webRemoteControlManager.ts packages/desktop/test/webRemoteControlManagerMultiTerminal.test.ts
git commit -m "feat(desktop): isolate view state per terminal session"
```

---

### Task 10: Web stable terminal id

**Files:**

- Modify: `packages/web/src/web-remote-control/contracts/transport.ts`
- Modify: `packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts`
- Modify: `packages/web/src/main.tsx`
- Test: `packages/web/test/webRemoteControlTransportV2.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `auth_init.terminal_id`。
- Produces: 页面级稳定 `terminalId`，重连不变、刷新变化。

- [ ] **Step 1: 写失败测试**

在 `packages/web/test/webRemoteControlTransportV2.test.ts` 的 `fixture` 中增加
第四个参数 `terminalId?: string`，并在 `new WebRemoteControlTerminalTransport({ ... })`
里传入 `terminalId`。添加：

```ts
it("auth_init 携带页面级 terminal_id，重连复用同一个值", async () => {
  const h = await fixture(
    { users: { jwt: "user-1" } },
    "jwt",
    fetch,
    "t_page-1",
  );
  h.terminal.start();
  await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));

  const terminalAuths = () =>
    h.relay.messages.filter(
      (entry) =>
        entry.role === "terminal" &&
        (entry.message as { type?: string }).type === "auth_init",
    );
  expect(terminalAuths()).toHaveLength(1);
  expect(terminalAuths()[0]!.message).toMatchObject({
    terminal_id: "t_page-1",
  });

  h.relay.disconnect({ role: "terminal" });
  await vi.waitFor(
    () => {
      expect(terminalAuths().length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 5000 },
  );
  expect(terminalAuths().at(-1)!.message).toMatchObject({
    terminal_id: "t_page-1",
  });
});

it("未提供 terminalId 时 auth_init 不带该字段", async () => {
  const h = await fixture();
  h.terminal.start();
  await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));
  const auth = h.relay.messages.find(
    (entry) =>
      entry.role === "terminal" &&
      (entry.message as { type?: string }).type === "auth_init",
  )!;
  expect(auth.message).not.toHaveProperty("terminal_id");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm exec vitest run packages/web/test/webRemoteControlTransportV2.test.ts`
Expected: FAIL，`terminal_id` 未发送。

- [ ] **Step 3: 实现**

`contracts/transport.ts`：

```ts
terminalId?: string;
```

`adapters/webRemoteControlTransport.ts` 的 `connect()`：

```ts
this.send({
  type: "auth_init",
  device_sid: this.options.deviceSid,
  ...(this.options.terminalId ? { terminal_id: this.options.terminalId } : {}),
  meta: {
    /* 现有 */
  },
  client_ts: Math.floor(Date.now() / 1000),
});
```

`main.tsx`：把 `createUuid` 加入已有的 `@zcode/shared` import 列表（不要新增第三个重复
import）。

```ts
// 页面级稳定 terminal 身份：同一页面重连复用，刷新或新标签生成新值。
const webRemoteControlTerminalId = `t_${createUuid()}`;
```

创建 transport 时：

```ts
const transport = new WebRemoteControlTerminalTransport({
  // ...
  terminalId: webRemoteControlTerminalId,
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm exec vitest run packages/web/test/webRemoteControlTransportV2.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/web-remote-control/contracts/transport.ts packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts packages/web/src/main.tsx packages/web/test/webRemoteControlTransportV2.test.ts
git commit -m "feat(web): send stable terminal id on auth"
```

---

### Task 11: Build, deploy and manual acceptance

**Files:**

- No source changes; run builds and record results.

- [ ] **Step 1: 全量门禁**

```bash
mise exec -- pnpm typecheck
mise exec -- pnpm lint
mise exec -- pnpm architecture:check --changed
```

Expected: 全部通过；已有失败如实记录，不写成通过。

- [ ] **Step 2: 构建产物**

```bash
mise exec -- pnpm --filter @zcode/self-host-relay build
mise exec -- pnpm build:web-remote-control:selfhost
mise exec -- pnpm compress:web-remote-control
mise exec -- pnpm build:zcode
```

- [ ] **Step 3: 部署 relay + web**

按 `apps/self-host-relay/deploy/README.md` 上传：

```bash
export KCODE_RELAY_HOST="由执行者从既有部署环境读取，不写入仓库"
scp apps/self-host-relay/dist/main.js "$KCODE_RELAY_HOST:/opt/self-host-relay/main.js"
rsync -az --exclude='*.map' packages/web/dist/ "$KCODE_RELAY_HOST:/opt/self-host-relay/web/"
ssh "$KCODE_RELAY_HOST" 'systemctl restart self-host-relay && systemctl is-active self-host-relay'
```

注意：资产先就绪、`index.html` 最后替换；`.map` 不公开。发布顺序必须是 desktop 先、relay+web 后。

- [ ] **Step 4: 冒烟**

```bash
export KCODE_RELAY_ORIGIN="由执行者提供"
curl -fsS "$KCODE_RELAY_ORIGIN/remote/v4" >/dev/null
curl -s -o /dev/null -w '%{http_code}\n' "$KCODE_RELAY_ORIGIN/api/v1/remote/token" # 期望 401
```

- [ ] **Step 5: 真机验收 MT01–MT10**

按 spec 的验收矩阵逐项执行，记录：

- 两个标签页同时配对；
- 两页不同 workspace/task；
- 关闭 A 后 B 正常；
- A 断网重连不重建 bridge；
- relay 重启、桌面重启；
- 官方 relay 单页回归；
- 两页同 task 的流式输出；
- 重复 terminal_id 只踢旧连接；
- 32 上限（可用 `maxTerminals` 配置在测试环境验证）。

- [ ] **Step 6: 提交验收记录**

在 spec 末尾追加“实现与验收记录”，只写脱敏结果（版本、时间、场景、结果），不写
JWT、token、密钥、ECS 地址。

```bash
git add docs/superpowers/specs/2026-10-21-multi-terminal-web-remote-control-design.md
git commit -m "docs(relay): record multi-terminal acceptance"
```

---

## Plan Self-Review

- **Spec coverage:** wire 字段（Task 1）、store 集合（Task 2）、gateway 路由/断开/上限/ACK
  能力门控（Task 3）、文档（Task 4）、serializer target + 分片路由预留（Task 5）、desktop
  transport（Task 6）、manager session 拆分（Task 7）、宽限期/释放（Task 8）、视图/自愈
  （Task 9）、web terminal_id（Task 10）、构建/部署/验收（Task 11）均有对应任务。
- **Placeholder scan:** 无 TBD/TODO；“由执行者从既有部署环境读取”只用于禁止入库的地址，
  不是实现占位。
- **Type consistency:** `terminalId` / `terminal_id` / `from_terminal_id` /
  `target_terminal_id` / `terminal_ids` 在 shared、relay、desktop、web 任务中命名一致；
  `sendPayloadResult(payload, targetTerminalId?)` 与 `prepare(payload, ts, target?)` 对齐。
- **Review Focus coverage:** 重连宽限（Task 8）、官方 relay legacy 键（Task 7）、断开方向性
  （Task 3）、帧大小含路由预留（Task 5）、重复 terminal_id（Task 3）均有测试。
- **Codex review 修订（2026-10-21）：** ①分片预算未计入路由字段（P1）→ Task 5 增加
  `routingFieldReserveBytes` 与 protocol 调用点缩减；②relay 无条件回显 `auth_ack.terminal_id`
  击穿旧 web strict 解析（P2）→ Task 3 改为仅客户端声明能力时回显；③`terminal_id="default"`
  与 legacy 会话键冲突（P2）→ legacy 键改为空串（wire identifier 强制非空白）；④共存测试在
  未关闭 A 时等待关闭必败（P2）→ 改为先断言 OPEN 再主动关闭。
