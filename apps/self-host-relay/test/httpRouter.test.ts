import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSelfHostRelayHttpRouter } from "../src/adapters/httpRouter.js";
import { RelayStore } from "../src/domain/relayStore.js";

const SECRET = "secret-1";
let server: Server;
let baseUrl: string;
let store: RelayStore;
let deviceSid: string;

beforeAll(async () => {
  store = new RelayStore({ newSid: () => `d_${Math.random().toString(36).slice(2)}` });
  deviceSid = store.registerDevice("mid-test", Date.now()).deviceSid;
  const router = createSelfHostRelayHttpRouter({ store, secret: SECRET });
  server = createServer((request, response) => {
    void router(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

describe("self-host relay HTTP 契约", () => {
  it("注册：任意非空 bearer 成功，返回新设备记录，信封 code 0", async () => {
    const response = await call("/api/v1/remote/device", {
      method: "POST",
      headers: { Authorization: "Bearer any-jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-a" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: number; data: { device_sid: string } };
    expect(body.code).toBe(0);
    expect(body.data.device_sid).toMatch(/^d_/);
  });

  it("鉴权矩阵：空 bearer 一律 401；list 与 terminal token 错密钥 401、对密钥 200；device token 任意 bearer 200", async () => {
    expect((await call("/api/v1/remote/device", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/api/v1/remote/device")).status).toBe(401);
    expect(
      (await call("/api/v1/remote/device", { headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    const tokenOf = async (role: string, bearer: string) =>
      call("/api/v1/remote/token", {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
    expect((await tokenOf("terminal", "wrong")).status).toBe(401);
    const terminal = await tokenOf("terminal", SECRET);
    expect(terminal.status).toBe(200);
    expect(terminal.headers.get("cache-control")).toBe("no-store");
    const terminalBody = (await terminal.json()) as { data: { token: string; expires_in: number } };
    expect(terminalBody.data.token).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(terminalBody.data.expires_in).toBe(60);
    expect((await tokenOf("device", "any-jwt")).status).toBe(200);
  });

  it("列表：密钥 bearer 返回设备数组，online 位反映 owner 状态", async () => {
    const response = await call("/api/v1/remote/device", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = (await response.json()) as {
      data: { device_sid: string; online: boolean; meta: Record<string, unknown> }[];
    };
    const record = body.data.find((item) => item.device_sid === deviceSid)!;
    expect(record.online).toBe(false);
    expect(record.meta).toEqual({});
  });

  it("参数非法 400 code 3001；删除在线设备 400 code 3005；删除缺失幂等 200", async () => {
    const bad = await call("/api/v1/remote/device", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ device_mid: " " }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: number }).code).toBe(3001);

    const owner = { id: "conn" };
    store.claimOwnership(deviceSid, "device", {}, owner);
    const online = await call("/api/v1/remote/device/delete", {
      method: "POST",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
      body: JSON.stringify({ device_sid: deviceSid }),
    });
    expect(online.status).toBe(400);
    expect(((await online.json()) as { code: number }).code).toBe(3005);
    store.releaseOwnership(deviceSid, "device", owner);

    const missing = await call("/api/v1/remote/device/delete", {
      method: "POST",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
      body: JSON.stringify({ device_sid: "d_missing" }),
    });
    expect(missing.status).toBe(200);
  });

});

describe("请求体与限流硬化", () => {
  it("超过 64KiB 的请求体返回 413，且服务存活", async () => {
    const big = JSON.stringify({ role: "device" }) + " ".repeat(65 * 1024);
    const response = await call("/api/v1/remote/token", {
      method: "POST",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
      body: big,
    });
    expect(response.status).toBe(413);
    const after = await call("/api/v1/remote/device", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(after.status).toBe(200);
  });

  it("限流为 20 req/s：同秒第 21 次 429，跨窗口恢复", async () => {
    let clock = 1_000_000;
    const store2 = new RelayStore({ newSid: () => "d_rl" });
    const router2 = createSelfHostRelayHttpRouter({
      store: store2,
      secret: SECRET,
      now: () => clock,
    });
    const server2 = createServer((request, response) => {
      void router2(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    server2.listen(0, "127.0.0.1");
    await once(server2, "listening");
    const base2 = `http://127.0.0.1:${(server2.address() as { port: number }).port}`;
    const hit = () =>
      fetch(`${base2}/api/v1/remote/token`, {
        method: "POST",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ role: "device" }),
      }).then((r) => r.status);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) statuses.push(await hit());
      expect(statuses.filter((s) => s === 200)).toHaveLength(20);
      expect(statuses[20]).toBe(429);
      clock += 1_001;
      expect(await hit()).toBe(200);
    } finally {
      server2.closeAllConnections();
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});
