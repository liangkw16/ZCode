import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createBrokerClient } from "../src/adapters/broker-client.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  respond: (request: any, socket: Socket) => void,
  options: { epoch?: () => number; generation?: () => string; pid?: () => number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "kcua-"));
  const path = join(dir, "broker.sock");
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (request.method === "authenticate")
          socket.write(
            JSON.stringify({
              id: 0,
              ok: true,
              result: {
                authenticated: true,
                serverApiVersion: 3,
                kcode: {
                  generation: options.generation?.() ?? "g1",
                  capability: "host-cap",
                  cleanupFence: true,
                  cancellationEpoch: options.epoch?.() ?? 0,
                  pid: options.pid?.(),
                },
              },
            }) + "\n",
          );
        else respond(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true });
  });
  const client = createBrokerClient({ socketPath: path, timeoutMs: 300 });
  cleanup.push(() => client.close());
  return client;
}
describe("zcode-cua compatible transport", () => {
  it("uses authenticate then existing numeric-id NDJSON and preserves error receipts", async () => {
    const client = await fixture((r, s) => {
      expect(r.id).toBe(1);
      expect(r.method).toBe("click");
      s.end(
        JSON.stringify({
          id: 1,
          ok: false,
          error: { code: "element_unavailable", message: "stale", details: { action_sent: false } },
        }) + "\n",
      );
    });
    await expect(client.call("click", {})).rejects.toMatchObject({
      code: "element_unavailable",
      details: { action_sent: false },
    });
  });
  it("waits for native cleanup-complete before cancellation settles", async () => {
    let nativeRequest: any;
    let nativeSocket: Socket;
    let acknowledge!: () => void;
    const ack = new Promise<void>((r) => {
      acknowledge = r;
    });
    const client = await fixture((r, s) => {
      if (r.method === "operation_cancel")
        void ack.then(() => {
          s.end(
            JSON.stringify({ id: 1, ok: true, result: { cleanup_complete: true, epoch: 1 } }) +
              "\n",
          );
          nativeSocket.end(
            JSON.stringify({
              id: 1,
              ok: false,
              error: {
                code: "cancelled",
                message: "cancelled",
                details: { action_sent: true, dispatch_status: "possibly_sent" },
              },
            }) + "\n",
          );
        });
      else {
        nativeRequest = r;
        nativeSocket = s;
      }
    });
    const controller = new AbortController();
    let settled = false;
    const result = client
      .call("drag", {}, { session: "s1", signal: controller.signal })
      .finally(() => {
        settled = true;
      });
    // Attach the rejection observer before cancellation can settle.
    const checked = expect(result).rejects.toMatchObject({
      code: "cancelled",
      details: { dispatch_status: "possibly_sent" },
    });
    await new Promise<void>((resolve) => {
      const check = () => (nativeRequest ? resolve() : setTimeout(check, 1));
      check();
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    acknowledge();
    await checked;
    expect(client.generation).toBe("g1");
  });
  it("does not replay disconnected input; only a future call reconnects", async () => {
    let dispatches = 0;
    const client = await fixture((r, s) => {
      if (r.method === "operation_cancel")
        s.end(JSON.stringify({ id: 1, ok: true, result: { cleanup_complete: true } }) + "\n");
      else if (r.method === "click") {
        dispatches++;
        s.destroy();
      } else s.end(JSON.stringify({ id: 1, ok: true, result: ["observed"] }) + "\n");
    });
    await expect(client.call("click", {}, { session: "s" })).rejects.toMatchObject({
      details: { dispatch_status: "possibly_sent" },
    });
    expect(dispatches).toBe(1);
    expect(await client.call("list_windows", {})).toEqual(["observed"]);
    expect(dispatches).toBe(1);
  });
  it("returns a broker refusal at capacity without trying to cancel a new operation", async () => {
    const requests: string[] = [];
    const client = await fixture((request, socket) => {
      requests.push(request.method);
      socket.end(JSON.stringify(request.method === "list_applications"
        ? { id: 1, ok: false, error: {
            code: "broker_unavailable", message: "ledger capacity reached",
            details: { action_sent: false, dispatch_status: "not_sent" },
          } }
        : { id: 1, ok: true, result: { cleanup_complete: true, dispatch_status: "not_sent" } }) + "\n");
    });
    const session = { session: "long-running" };
    await expect(client.call("list_applications", {}, session)).rejects.toMatchObject({
      code: "broker_unavailable", details: { dispatch_status: "not_sent" },
    });
    await client.call("session_release", {}, session);
    expect(requests).toEqual(["list_applications", "session_release"]);
  });
  it("requires a fresh observation after Helper death without claiming input was released", async () => {
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const exited = once(helper, "exit");
    cleanup.push(async () => {
      helper.kill();
      await exited;
    });
    let generation = "g1";
    let notifyDispatched!: (socket: Socket) => void;
    const dispatched = new Promise<Socket>((resolve) => { notifyDispatched = resolve; });
    let mutations = 0;
    const client = await fixture((request, socket) => {
      if (request.method === "drag") {
        mutations++;
        if (mutations === 1) {
          notifyDispatched(socket);
          return;
        }
      }
      socket.end(JSON.stringify({ id: 1, ok: true, result: { accepted: true } }) + "\n");
    }, { pid: () => helper.pid!, generation: () => generation });
    const action = client.call("drag", {}, { session: "fixture" });
    const checked = expect(action).rejects.toMatchObject({
      code: "cleanup_incomplete",
      details: { dispatch_status: "possibly_sent", cause_code: "helper_exited" },
    });
    const socket = await dispatched;
    helper.kill();
    await exited;
    socket.destroy();
    await checked;
    generation = "g2";
    await expect(client.call("drag", {}, { session: "fixture" })).rejects.toMatchObject({
      code: "stale_state",
    });
    await client.call("capture_app", {}, { session: "fixture" });
    await client.call("drag", {}, { session: "fixture" });
    expect(mutations).toBe(2);
  });
  it.each(["click", "list_windows", "capture_app"])(
    "keeps all known sessions fenced when %s discovers the generation change",
    async (detector) => {
      let generation = "g1";
      const mutations: string[] = [];
      const client = await fixture((r, s) => {
        if (r.method === "click") mutations.push(r.params.kcode_operation.session);
        s.end(JSON.stringify({ id: 1, ok: true, result: {} }) + "\n");
      }, { generation: () => generation });
      await client.call("capture_app", {}, { session: "s1" });
      await client.call("capture_app", {}, { session: "s2" });
      generation = "g2";
      if (detector === "click") {
        await expect(client.call(detector, {}, { session: "s1" })).rejects.toMatchObject({
          code: "stale_state", details: { dispatch_status: "not_sent" },
        });
      } else {
        await client.call(detector, {}, { session: "s2" });
      }
      for (const session of detector === "capture_app" ? ["s1"] : ["s1", "s2"]) {
        for (const _ of [1, 2]) {
          await expect(client.call("click", {}, { session })).rejects.toMatchObject({
            code: "stale_state", details: { dispatch_status: "not_sent" },
          });
        }
      }
      expect(mutations).toEqual([]);
      await client.call("capture_app", { tree_shown_to_model: false, include_screenshot: false }, { session: "s1" });
      await client.call("capture_app", { tree_shown_to_model: false, include_screenshot: true }, { session: "s1" });
      await expect(client.call("click", {}, { session: "s1" })).rejects.toMatchObject({ code: "stale_state" });
      await client.call("capture_app", {}, { session: "s1" });
      await client.call("click", {}, { session: "s1" });
      expect(mutations).toEqual(["s1"]);
    },
  );
  it("discards a late capture from before a same-generation recovery refusal", async () => {
    let holdCapture = true;
    let captureStarted!: (socket: Socket) => void;
    const started = new Promise<Socket>((resolve) => { captureStarted = resolve; });
    let mutations = 0;
    const ok = JSON.stringify({ id: 1, ok: true, result: {} }) + "\n";
    const client = await fixture((r, socket) => {
      if (r.method === "capture_app" && holdCapture) {
        captureStarted(socket);
      } else if (r.method === "click" && ++mutations === 1) {
        socket.end(JSON.stringify({ id: 1, ok: false, error: {
          code: "action_unavailable", message: "Focus the original window",
          details: { reason_code: "input_recovery_focus_required", dispatch_status: "not_sent" },
        } }) + "\n");
      } else {
        socket.end(ok);
      }
    });
    const session = { session: "s1" };
    const late = expect(client.call("capture_app", {}, session)).rejects.toMatchObject({ code: "stale_state" });
    const pending = await started;
    await expect(client.call("click", {}, session)).rejects.toMatchObject({ code: "action_unavailable" });
    pending.end(ok);
    await late;
    await expect(client.call("click", {}, session)).rejects.toMatchObject({ code: "stale_state" });
    holdCapture = false;
    await client.call("capture_app", {}, session);
    await client.call("click", {}, session);
    expect(mutations).toBe(2);
  });
});

describe("transport boundary validation", () => {
  it("rejects malformed responses rather than accepting an uncorrelated reply", async () => {
    const client = await fixture((_r, s) => s.end('{"id":42,"ok":true,"result":"wrong"}\n'));
    await expect(client.call("list_windows", {})).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  // 修复回归：JSON 合法但不是对象（如 "null"）时，原先直接取 .id 会在 data 回调里抛 TypeError，
  // 冒泡成进程级未捕获异常，而不是可捕获的 NativeBrokerError。
  it.each(["null", "[]", "1", '"text"'])(
    "rejects a valid-JSON non-object reply (%s)",
    async (frame) => {
      const client = await fixture((_r, s) => s.end(`${frame}\n`));
      await expect(client.call("list_windows", {})).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );
  it("rejects a non-object reply during authentication without throwing out of the data handler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-"));
    const path = join(dir, "broker.sock");
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.end("null\n");
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true });
    });
    const client = createBrokerClient({ socketPath: path, timeoutMs: 300 });
    cleanup.push(() => client.close());
    await expect(client.call("list_windows", {})).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("rejects an oversized request before dispatch", async () => {
    let called = false;
    const client = await fixture((_r, s) => {
      called = true;
      s.end('{"id":1,"ok":true,"result":null}\n');
    });
    await expect(
      client.call("list_windows", { text: "x".repeat(8 * 1024 * 1024) }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(called).toBe(false);
  });
});

it("settles after cleanup acknowledgement even when the original connection cannot deliver its reply", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const client = await fixture((r, socket) => {
    if (r.method === "operation_cancel")
      socket.end(
        JSON.stringify({
          id: 1,
          ok: true,
          result: { cleanup_complete: true, epoch: 1, dispatch_status: "possibly_sent" },
        }) + "\n",
      );
    else began();
  });
  const controller = new AbortController();
  const result = client.call("drag", {}, { signal: controller.signal, session: "s" }).then(
    () => "succeeded",
    (error: { code: string }) => error.code,
  );
  await started;
  controller.abort();
  expect(
    await Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]),
  ).toBe("cancelled");
});

it("preserves Unicode when a native UTF-8 response splits inside an emoji", async () => {
  const client = await fixture((_r, socket) => {
    const bytes = Buffer.from(JSON.stringify({ id: 1, ok: true, result: "中文🌟" }) + "\n");
    const split = bytes.indexOf(Buffer.from("🌟")) + 1;
    socket.write(bytes.subarray(0, split));
    setTimeout(() => socket.end(bytes.subarray(split)), 5);
  });
  expect(await client.call("list_windows", {})).toBe("中文🌟");
});

it("does not treat cancel-received as cleanup-complete and advances the native epoch", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let allowDrain = false;
  const client = await fixture((request, socket) => {
    if (request.method === "operation_cancel")
      socket.end(
        JSON.stringify({ id: 1, ok: true, result: { cleanup_complete: false, epoch: 1 } }) + "\n",
      );
    else if (request.method === "operation_status")
      socket.end(
        JSON.stringify({
          id: 1,
          ok: true,
          result: { cleanup_complete: allowDrain, epoch: 1, dispatch_status: "possibly_sent" },
        }) + "\n",
      );
    else if (request.method === "list_windows") {
      socket.end(
        JSON.stringify({ id: 1, ok: true, result: request.params.kcode_operation.epoch }) + "\n",
      );
    } else began();
  });
  const controller = new AbortController();
  let settled = false;
  const result = client
    .call("drag", {}, { signal: controller.signal, session: "s" })
    .then(
      () => "success",
      (error: { code: string }) => error.code,
    )
    .finally(() => {
      settled = true;
    });
  await started;
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settled).toBe(false);
  allowDrain = true;
  expect(await result).toBe("cancelled");
  expect(await client.call("list_windows", {}, { session: "s" })).toBe(1);
});

it("requires a fresh observation when a lock transition advanced the native epoch while idle", async () => {
  let epoch = 0;
  let inputs = 0;
  const client = await fixture(
    (request, socket) => {
      if (request.method === "click") inputs++;
      socket.end(
        JSON.stringify({
          id: 1,
          ok: true,
          result: request.method === "capture_app" ? { observed: true } : null,
        }) + "\n",
      );
    },
    { epoch: () => epoch },
  );
  await client.call("capture_app", {}, { session: "s" });
  epoch = 1;
  await expect(client.call("click", {}, { session: "s" })).rejects.toMatchObject({
    code: "stale_state",
    details: { action_sent: false },
  });
  expect(inputs).toBe(0);
  await client.call("capture_app", {}, { session: "s" });
  await client.call("click", {}, { session: "s" });
  expect(inputs).toBe(1);
});
it("does not report a session release complete until all native work is drained", async () => {
  let polls = 0;
  const client = await fixture((r, s) => {
    if (r.method === "session_release") {
      polls++;
      s.end(
        JSON.stringify({ id: 1, ok: true, result: { cleanup_complete: polls > 1, epoch: 1 } }) +
          "\n",
      );
    }
  });
  expect(await client.call("session_release", {}, { session: "s" })).toMatchObject({
    cleanup_complete: true,
  });
  expect(polls).toBe(2);
});
