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
