import { connect as tcpConnect, type Socket } from "node:net";
import { createServer, type Server } from "node:http";
import { get as httpGet, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSelfHostRelayHttpRouter } from "../src/adapters/httpRouter.js";
import { attachSelfHostRelayWsGateway } from "../src/adapters/wsGateway.js";
import { RelayStore } from "../src/domain/relayStore.js";

const SECRET = "secret-1";
let server: Server;
let baseUrl: string;
let wsUrl: string;
let store: RelayStore;
let deviceSid: string;
let gateway: { close(): Promise<void> };

beforeAll(async () => {
  store = new RelayStore({ newSid: () => `d_${Math.random().toString(36).slice(2)}` });
  deviceSid = store.registerDevice("mid-gw", Date.now()).deviceSid;
  // 挂真实 HTTP 路由：mintToken 走真实 token 端点（服务端 404 会让所有建连用例假失败）。
  const router = createSelfHostRelayHttpRouter({ store, secret: SECRET });
  server = createServer((request, response) => {
    void router(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  gateway = attachSelfHostRelayWsGateway(server, { store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/v1/remote/ws2`;
});

afterAll(async () => {
  // Bugfix：server.closeAllConnections() 不关闭已升级的 WS 连接；先经网关终止全部 WS，
  // 否则残留在线连接会让 server.close() 挂起、afterAll 超时。
  await gateway.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function mintToken(role: "device" | "terminal"): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/remote/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  }).then((r) => r.json() as Promise<{ data: { token: string } }>);
  return response.data.token;
}

/**
 * Bugfix：服务端在 terminal 认证时先给 device 推 pair_status_ack 再回 terminal auth_ack，
 * 认证间隙没有监听者的消息会被 EventEmitter 直接丢弃。建连即挂收集器，next() 从队列取。
 */
function tap(socket: WebSocket): { next(): Promise<any> } {
  const queue: any[] = [];
  const waiters: ((value: any) => void)[] = [];
  socket.on("message", (data: RawData) => {
    const message = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
}

async function openSocket(token: string): Promise<{ socket: WebSocket; messages: ReturnType<typeof tap> }> {
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
  return { socket, messages: tap(socket) };
}

/** 发起升级请求并断言服务端在升级前返回的 HTTP 状态（undici fetch 不走 upgrade 路径，用原生 http 客户端）。 */
function upgradeStatus(pathAndQuery: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      `${wsUrl.replace("ws", "http")}${pathAndQuery}`,
      { headers: { Connection: "Upgrade", Upgrade: "websocket" } } as never,
      (response: IncomingMessage) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      },
    );
    request.on("upgrade", () => resolve(101));
    request.on("error", reject);
  });
}

async function authenticated(
  role: "device" | "terminal",
  sid: string,
): Promise<{ socket: WebSocket; messages: ReturnType<typeof tap> }> {
  const connection = await openSocket(await mintToken(role));
  connection.socket.send(JSON.stringify({ type: "auth_init", device_sid: sid, meta: { name: "gw-test" } }));
  const ack = await connection.messages.next();
  expect(ack.type).toBe("auth_ack");
  return connection;
}

describe("ws2 网关", () => {
  it("无 token/伪造 token 升级前 401", async () => {
    expect(await upgradeStatus("?token=fake")).toBe(401);
    expect(await upgradeStatus("")).toBe(401);
  });

  it("一次性 token 不可复用", async () => {
    const token = await mintToken("device");
    const first = await openSocket(token);
    first.socket.close();
    expect(await upgradeStatus(`?token=${token}`)).toBe(401);
  });

  it("未知 SID auth_init 返回 AUTH_FAILED 并关闭", async () => {
    const { socket, messages } = await openSocket(await mintToken("device"));
    socket.send(JSON.stringify({ type: "auth_init", device_sid: "d_unknown" }));
    const error = await messages.next();
    expect(error).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    await once(socket, "close");
  });

  it("device 等待 → terminal 配对 matched → 双向 data 透传 → 断开通知", async () => {
    const device = await authenticated("device", deviceSid);
    const terminal = await authenticated("terminal", deviceSid);
    const deviceAck = await device.messages.next();
    expect(deviceAck).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });

    terminal.socket.send(JSON.stringify({ type: "data", payload: { hello: "desktop" } }));
    const forwarded = await device.messages.next();
    expect(forwarded).toMatchObject({ type: "data", payload: { hello: "desktop" } });
    device.socket.send(JSON.stringify({ type: "data", payload: { hello: "phone" } }));
    const toPhone = await terminal.messages.next();
    expect(toPhone).toMatchObject({ type: "data", payload: { hello: "phone" } });

    device.socket.close();
    const waiting = await terminal.messages.next();
    expect(waiting).toMatchObject({ type: "pair_status_ack", pair_status: "waiting" });
    const offline = await terminal.messages.next();
    expect(offline).toMatchObject({ type: "error", code: "DEVICE_OFFLINE" });
    await once(terminal.socket, "close");
  });

  it("同角色新连接替换旧 owner：旧连接收 KICKED 关闭，新连接不受影响", async () => {
    const first = await authenticated("device", deviceSid);
    const second = await authenticated("device", deviceSid);
    const kicked = await first.messages.next();
    expect(kicked).toMatchObject({ type: "error", code: "KICKED" });
    await once(first.socket, "close");
    // 旧连接的迟到 close 不得释放新 owner：查询仍是认证态。
    second.socket.send(JSON.stringify({ type: "pair_status_query" }));
    const ack = await second.messages.next();
    expect(ack).toMatchObject({ type: "pair_status_ack", pair_status: "waiting" });
    second.socket.close();
  });

  it("未认证发 data 返回 AUTH_FAILED 并关闭；非法消息 WRONG_PARAM 关闭", async () => {
    const unauthed = await openSocket(await mintToken("terminal"));
    unauthed.socket.send(JSON.stringify({ type: "data", payload: {} }));
    const error = await unauthed.messages.next();
    expect(error).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    await once(unauthed.socket, "close");

    const invalid = await openSocket(await mintToken("device"));
    invalid.socket.send("not-json");
    const wrong = await invalid.messages.next();
    expect(wrong).toMatchObject({ type: "error", code: "WRONG_PARAM" });
    await once(invalid.socket, "close");
  });
});

describe("畸形输入硬化", () => {
  it("畸形升级 URL 不崩进程：连接被关闭且后续可用", async () => {
    const closed = new Promise<void>((resolve) => {
      const socket: Socket = tcpConnect((server.address() as { port: number }).port, "127.0.0.1");
      socket.on("connect", () => {
        socket.write("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    await closed;
    // 进程仍存活：正常 HTTP 仍可用。
    const probe = await fetch(`${baseUrl}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "device" }),
    });
    expect(probe.status).toBe(200);
  });

  it("深层嵌套 JSON 只断当前连接，不崩进程", async () => {
    const evil = await openSocket(await mintToken("device"));
    const deep = "[".repeat(5000) + "]".repeat(5000);
    evil.socket.send(JSON.stringify({ type: "data", payload: JSON.parse(deep) }));
    // 序列化后的深嵌套 payload：服务端 zod 校验递归爆栈应被捕获为 WRONG_PARAM 关闭。
    const error = await evil.messages.next();
    expect(error).toMatchObject({ type: "error", code: "WRONG_PARAM" });
    await once(evil.socket, "close");
    const probe = await fetch(`${baseUrl}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "device" }),
    });
    expect(probe.status).toBe(200);
  });
});

/** terminal 接管语义（官方"新替旧"）与设备契约：独立实例避免污染共享套件。 */
describe("ws2 网关：terminal 接管与设备契约", () => {
  let server2: Server;
  let base2: string;
  let ws2: string;
  let store2: RelayStore;
  let gateway2: { close(): Promise<void> };

  // 可控时钟：本 describe 的用例总数会在 1 秒内打出 20+ 次 token 请求，恰好撞上
  // 每 IP 20 req/s 限流的边界。每次 mint 前推进 60ms，让限流窗口自然滚动。
  let routerNow = 0;
  const tick = () => {
    routerNow += 60;
    return routerNow;
  };

  beforeAll(async () => {
    store2 = new RelayStore({ newSid: () => `d_${Math.random().toString(36).slice(2)}` });
    const router = createSelfHostRelayHttpRouter({ store: store2, secret: SECRET, now: tick });
    server2 = createServer((request, response) => {
      void router(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    gateway2 = attachSelfHostRelayWsGateway(server2, { store: store2, now: () => routerNow });
    server2.listen(0, "127.0.0.1");
    await once(server2, "listening");
    const port = (server2.address() as { port: number }).port;
    base2 = `http://127.0.0.1:${port}`;
    ws2 = `ws://127.0.0.1:${port}/api/v1/remote/ws2`;
  });

  afterAll(async () => {
    await gateway2.close();
    server2.closeAllConnections();
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });

  function freshSid(): string {
    return store2.registerDevice(`mid-${Math.random().toString(36).slice(2, 8)}`, Date.now())
      .deviceSid;
  }

  async function mint2(role: "device" | "terminal"): Promise<string> {
    tick();
    const response = await fetch(`${base2}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }).then((r) => r.json() as Promise<{ data: { token: string } }>);
    return response.data.token;
  }

  function open2(token: string): Promise<{ socket: WebSocket; messages: ReturnType<typeof tap> }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${ws2}?token=${token}`);
      socket.once("open", () => resolve({ socket, messages: tap(socket) }));
      socket.once("error", reject);
    });
  }

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

  // KICKED 与 close 帧可能同批到达：close 事件会在消息微任务前发出，
  // 事后 once("close") 永远挂起；用 readyState 轮询判定关闭。
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitClosed = async (socket: WebSocket) => {
    const deadline = Date.now() + 2_000;
    while (socket.readyState !== WebSocket.CLOSED && Date.now() < deadline) await sleep(20);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  };

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
      JSON.stringify({ type: "data", payload: { to: "b" }, target_terminal_id: "tB" }),
    );
    expect(await b.messages.next()).toMatchObject({ type: "data", payload: { to: "b" } });

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
    expect(await first.messages.next()).toMatchObject({ type: "error", code: "KICKED" });
    await waitClosed(first.socket);
    device.socket.close();
    second.socket.close();
  });

  it("terminal 发送 target_terminal_id 属于非法方向，回 WRONG_PARAM 并关闭", async () => {
    const sid = freshSid();
    const device = await auth2("device", sid);
    await device.messages.next();
    const a = await auth2("terminal", sid, "tA");
    await a.messages.next();
    await device.messages.next();

    a.socket.send(
      JSON.stringify({ type: "data", payload: { hi: 1 }, target_terminal_id: "tB" }),
    );
    expect(await a.messages.next()).toMatchObject({ type: "error", code: "WRONG_PARAM" });
    await waitClosed(a.socket);
    // device 只收到集合更新，不收到该 payload。
    expect(await device.messages.next()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
      terminal_ids: [],
    });
    device.socket.close();
  });

  it("terminal 集合达上限时新 terminal 收 KICKED，已有连接不受影响", async () => {
    const sid = freshSid();
    const device = await auth2("device", sid);
    await device.messages.next();
    const first = await auth2("terminal", sid, "tCap1");
    await first.messages.next();
    await device.messages.next();
    const second = await auth2("terminal", sid, "tCap2");
    await second.messages.next();
    await device.messages.next();

    // 本 describe 的 gateway 未注入自定义 maxTerminals（默认 32）：
    // 再连 30 个达到上限后，第 33 个被拒绝。
    for (let i = 3; i <= 32; i++) {
      const conn = await auth2("terminal", sid, `tCap${i}`);
      await conn.messages.next();
      await device.messages.next();
    }
    const overflow = await auth2("terminal", sid, "tCap33");
    expect(await overflow.messages.next()).toMatchObject({
      type: "error",
      code: "KICKED",
    });
    await waitClosed(overflow.socket);

    // 上限拒绝不伤害存量连接：first 仍可收定向数据。
    device.socket.send(
      JSON.stringify({ type: "data", payload: { cap: 1 }, target_terminal_id: "tCap1" }),
    );
    expect(await first.messages.next()).toMatchObject({
      type: "data",
      payload: { cap: 1 },
    });
    device.socket.close();
    for (let i = 1; i <= 2; i++) {
      const c = i === 1 ? first : second;
      c.socket.close();
    }
  });

  it("未提供 terminal_id 的旧客户端不收到新字段，且以连接级 sid 作为生效 id", async () => {
    const sid = freshSid();
    const device = await auth2("device", sid);
    await device.messages.next();
    const a = await auth2("terminal", sid);
    const ackA = await a.messages.next();
    expect(ackA.type).toBe("auth_ack");
    // 旧 web 的 strict 解析不认识 terminal_id：未声明能力的客户端不能看到该字段。
    expect(ackA).not.toHaveProperty("terminal_id");
    const deviceListA = await device.messages.next();
    expect(deviceListA).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });
    expect(deviceListA.terminal_ids).toEqual([ackA.terminal_sid]);
    const b = await auth2("terminal", sid);
    const ackB = await b.messages.next();
    expect(ackB).not.toHaveProperty("terminal_id");
    expect(ackB.terminal_sid).not.toBe(ackA.terminal_sid);
    const deviceListB = await device.messages.next();
    expect(deviceListB.terminal_ids).toEqual([ackA.terminal_sid, ackB.terminal_sid]);
    device.socket.close();
    a.socket.close();
    b.socket.close();
  });

  it("已删除 SID 返回 AUTH_FAILED（契约 §1.2）", async () => {
    const sid = freshSid();
    const holder = await auth2("terminal", sid);
    await holder.messages.next(); // waiting auth_ack
    expect(store2.deleteDevice(sid)).toBe("deleted");
    const later = await auth2("terminal", sid);
    expect(await later.messages.next()).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    await waitClosed(later.socket);
    holder.socket.close();
  });

  it("device 角色保持官方替换语义（桌面重启必须能收回 device 位）", async () => {
    const sid = freshSid();
    const first = await auth2("device", sid);
    await first.messages.next();
    const second = await auth2("device", sid);
    expect(await second.messages.next()).toMatchObject({ type: "auth_ack" });
    expect(await first.messages.next()).toMatchObject({ type: "error", code: "KICKED" });
    await waitClosed(first.socket);
    second.socket.close();
  });
});
