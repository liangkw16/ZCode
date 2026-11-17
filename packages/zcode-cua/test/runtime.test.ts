import { afterEach, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseRuntime } from "../index.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const context = {
  sessionId: "s1",
  runtimeScope: "main" as const,
  workspaceKey: "/work",
  workspacePath: "/work",
  workspaceIdentity: "one",
};
async function fixture(options: { screenshot?: boolean; hold?: string; pressable?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kcua-rt-"));
  const socketPath = join(dir, "broker.sock");
  const calls: any[] = [];
  const sockets = new Set<Socket>();
  let generation = "g1",
    epoch = 0,
    failObservation = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let n = buffer.indexOf("\n"); n >= 0; n = buffer.indexOf("\n")) {
        const r = JSON.parse(buffer.slice(0, n));
        buffer = buffer.slice(n + 1);
        if (r.method === "authenticate") {
          socket.write(
            JSON.stringify({
              id: r.id,
              ok: true,
              result: {
                authenticated: true,
                serverApiVersion: 3,
                kcode: {
                  generation,
                  capability: "private",
                  cleanupFence: true,
                  cancellationEpoch: epoch,
                },
              },
            }) + "\n",
          );
          continue;
        }
        calls.push(r);
        if (r.method === options.hold) continue;
        if (r.method === "operation_cancel") {
          epoch++;
          socket.end(
            JSON.stringify({
              id: r.id,
              ok: true,
              result: { cleanup_complete: true, epoch, dispatch_status: "possibly_sent" },
            }) + "\n",
          );
          continue;
        }
        if (r.method === "capture_app" && failObservation) {
          socket.end(
            JSON.stringify({
              id: r.id,
              ok: false,
              error: { code: "desktop_locked", message: "locked" },
            }) + "\n",
          );
          continue;
        }
        const result =
          r.method === "capture_app"
            ? {
                app: { pid: 700, bundle_id: "dev.fixture", name: "Fixture" },
                window: { window_id: 10, bounds: { x: -100, y: 20, width: 200, height: 100 } },
                elements: [
                  {
                    native: "token1",
                    actions: options.pressable === false ? [] : ["AXPress"],
                    role: "AXTextField",
                    kind: "text_field",
                    title: "Text",
                    value: "中文🌟",
                    editable: true,
                    bounds: { x: -90, y: 30, width: 80, height: 20 },
                  },
                ],
                desktop_epoch: 0,
                cancellation_epoch: epoch,
                snapshot_mode: "full",
              }
            : r.method === "list_applications"
              ? [{ pid: 700, bundle_id: "dev.fixture", name: "Fixture" }]
              : r.method === "list_windows"
                ? [{ window_id: 10 }]
                : r.method === "session_release"
                  ? { cleanup_complete: true }
                  : { action_sent: true, dispatch_status: "accepted" };
        if (r.method === "capture_app" && options.screenshot && r.params.include_screenshot) {
          Object.assign(result, {
            screenshot: {
              format: "png",
              width: 1,
              height: 1,
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/J0AAAAASUVORK5CYII=",
            },
            pointer: { x: -100, y: 20, width: 200, height: 100 },
            surface_identity: { pid: 700, window_id: 10, process_birth: "b1" },
          });
        }
        socket.end(JSON.stringify({ id: r.id, ok: true, result }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
  cleanups.push(async () => {
    await runtime.dispose();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true });
  });
  const run = (toolName: string, args: unknown = {}, ctx = context) =>
    runtime.execute({ toolName, arguments: args, context: ctx });
  return {
    runtime,
    run,
    calls,
    setGeneration: (g: string) => (generation = g),
    setEpoch: (e: number) => (epoch = e),
    failObservation: () => (failObservation = true),
  };
}
it("returns full state and preserves observed indices across fresh hidden SDK bindings", async () => {
  const f = await fixture();
  const state = await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  expect(state.isError).not.toBe(true);
  expect(state.structuredContent).toMatchObject({
    snapshot_mode: "full",
    elements: [{ index: 0, value: "中文🌟" }],
  });
  const hidden = await f.run("get_app_state", {
    app_ref: { pid: 700 },
    include_screenshot: false,
    tree_shown_to_model: false,
  });
  expect(hidden.isError).not.toBe(true);
  expect(f.calls.filter((c) => c.method === "capture_app")).toHaveLength(1);
  const action = await f.run("set_value", {
    app_ref: { pid: 700 },
    target: { type: "element", index: 0 },
    value: "好\ud83c",
  });
  expect(action.isError).not.toBe(true);
  expect(f.calls.at(-1)).toMatchObject({
    method: "element_set_value",
    params: { native: "token1", value: "好�" },
  });
  expect(action.structuredContent).toMatchObject({
    action_receipt: { dispatch_status: "accepted", retry_action: false },
  });
  expect(f.calls.filter((c) => c.method === "capture_app")).toHaveLength(1);
});
it("rejects unknown keys, selectors, nonfinite numbers and subagents before broker preparation", async () => {
  let calls = 0;
  const runtime = createComputerUseRuntime({
    ensureBrokerAvailable: async () => {
      calls++;
    },
  });
  cleanups.push(() => runtime.dispose());
  for (const args of [
    { app_ref: { pid: 700 }, extra: true },
    { app_ref: { pid: NaN } },
    { app_ref: { pid: 1.2 } },
    { app_ref: { pid: 4294967297 } },
    { app_ref: { pid: 700, window_id: 4294967306 } },
    { app_ref: { name: " " } },
  ]) {
    expect(
      (await runtime.execute({ toolName: "get_app_state", arguments: args, context })).isError,
    ).toBe(true);
  }
  expect(
    (
      await runtime.execute({
        toolName: "list_apps",
        arguments: {},
        context: { ...context, runtimeScope: "subagent" },
      })
    ).isError,
  ).toBe(true);
  expect(calls).toBe(0);
});
it("keeps indices scoped by workspace identity and refuses arbitrary coordinates without a delivered frame", async () => {
  const f = await fixture();
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  const result = await f.run(
    "set_value",
    { app_ref: { pid: 700 }, target: { type: "element", index: 0 }, value: "wrong" },
    { ...context, workspaceIdentity: "two" },
  );
  expect(result.isError).toBe(true);
  expect(
    (
      await f.run("left_click", {
        app_ref: { pid: 700 },
        target: { type: "coordinate", x: 1, y: 1, frame_id: "forged" },
      })
    ).isError,
  ).toBe(true);
  expect(f.calls.some((c) => c.method === "click" || c.method === "element_set_value")).toBe(false);
});
it("requires a fresh shown observation after a generation or cancellation epoch change", async () => {
  const f = await fixture();
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  f.setEpoch(1);
  expect(
    (
      await f.run("set_value", {
        app_ref: { pid: 700 },
        target: { type: "element", index: 0 },
        value: "stale",
      })
    ).isError,
  ).toBe(true);
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  expect(
    (
      await f.run("set_value", {
        app_ref: { pid: 700 },
        target: { type: "element", index: 0 },
        value: "fresh",
      })
    ).isError,
  ).not.toBe(true);
  f.setGeneration("g2");
  expect((await f.run("key", { app_ref: { pid: 700 }, text: "ENTER" })).isError).toBe(true);
});
it("preserves accepted receipt if explicitly requested post-action observation fails", async () => {
  const f = await fixture();
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  f.failObservation();
  const result = await f.run("set_value", {
    app_ref: { pid: 700 },
    target: { type: "element", index: 0 },
    value: "done",
    return_state: "full",
  });
  expect(result.structuredContent).toMatchObject({
    action_receipt: { dispatch_status: "accepted", retry_action: false },
    state_unavailable: true,
  });
  expect(f.calls.filter((c) => c.method === "element_set_value")).toHaveLength(1);
  expect(f.calls.filter((c) => c.method === "capture_app")).toHaveLength(2);
});
it("latches stop for one logical session without disabling a different workspace identity", async () => {
  const f = await fixture();
  expect((await f.run("stop_computer_control")).isError).not.toBe(true);
  expect((await f.run("list_apps")).isError).toBe(true);
  expect((await f.run("list_apps", {}, { ...context, workspaceIdentity: "two" })).isError).not.toBe(
    true,
  );
  expect(f.calls.filter((c) => c.method === "session_release")).toHaveLength(1);
});
it("maps all public observation and action tools to the compatible broker without implicit captures", async () => {
  const f = await fixture();
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  const base = { app_ref: { pid: 700 } },
    target = { type: "element", index: 0 };
  for (const [name, args, method] of [
    ["list_apps", {}, "list_applications"],
    ["list_windows", base, "list_windows"],
    ["left_click", { ...base, target }, "element_press"],
    [
      "left_click",
      { ...base, target, strategy: "event", modifiers: ["shift"], click_count: 2 },
      "click",
    ],
    ["scroll", { ...base, target, scroll_direction: "down", scroll_amount: 2 }, "scroll"],
    ["left_click_drag", { ...base, from_target: target, to: target }, "drag"],
    ["type", { ...base, text: "中文🌟\nline" }, "type_text_to_app"],
    ["set_value", { ...base, target, value: "text" }, "element_set_value"],
    ["select_text", { ...base, target, text_range: [0, 2] }, "element_select_text"],
    ["key", { ...base, text: "CMD+A" }, "press_key_to_app"],
    ["key", { ...base, text: "SHIFT", hold_seconds: 1 }, "hold_key_to_app"],
    ["perform_action", { ...base, target, action: "AXPress" }, "element_perform_action"],
    ["paste", { ...base, text: "<b>中文</b>", format: "html" }, "paste"],
    ["request_access", {}, "request_access"],
  ] as const) {
    const result = await f.run(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(f.calls.at(-1).method).toBe(method);
  }
  expect(f.calls.filter((c) => c.method === "capture_app")).toHaveLength(1);
});
it("does not reuse hidden cached bindings after native epoch changes", async () => {
  const f = await fixture();
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  f.setEpoch(2);
  const hidden = await f.run("get_app_state", {
    app_ref: { pid: 700 },
    include_screenshot: false,
    tree_shown_to_model: false,
  });
  expect(hidden.isError).not.toBe(true);
  expect(f.calls.filter((c) => c.method === "capture_app")).toHaveLength(2);
  expect(
    (
      await f.run("set_value", {
        app_ref: { pid: 700 },
        target: { type: "element", index: 0 },
        value: "stale",
      })
    ).isError,
  ).toBe(true);
});
it("cancels and drains before settling, invalidates old indices and allows the same logical session to continue", async () => {
  const f = await fixture({ hold: "hold_key_to_app" });
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  const controller = new AbortController();
  const work = f.runtime.execute({
    toolName: "key",
    arguments: { app_ref: { pid: 700 }, text: "SHIFT", hold_seconds: 20 },
    context,
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => {
    const check = () =>
      f.calls.some((c) => c.method === "hold_key_to_app") ? resolve() : setTimeout(check, 1);
    check();
  });
  controller.abort();
  const result = await work;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    action_receipt: { dispatch_status: "possibly_sent", retry_action: false },
  });
  expect(
    (
      await f.run("set_value", {
        app_ref: { pid: 700 },
        target: { type: "element", index: 0 },
        value: "stale",
      })
    ).isError,
  ).toBe(true);
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  expect((await f.run("key", { app_ref: { pid: 700 }, text: "ENTER" })).isError).not.toBe(true);
  expect(f.calls.filter((c) => c.method === "hold_key_to_app")).toHaveLength(1);
});
it("projects only the latest delivered raster to native points and keeps it across hidden or AX-only observations", async () => {
  const f = await fixture({ screenshot: true });
  const observed = await f.run("get_app_state", { app_ref: { pid: 700 } });
  const frame = JSON.parse((observed.content.at(-1) as any).text).image_ref.frame_id;
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  expect(
    (
      await f.run("left_click", {
        app_ref: { pid: 700 },
        target: { type: "coordinate", x: 0, y: 0, frame_id: frame },
      })
    ).isError,
  ).not.toBe(true);
  expect(f.calls.at(-1)).toMatchObject({
    method: "click",
    params: {
      point: { x: -100, y: 20 },
      expected_pid: 700,
      expected_window_id: 10,
      expected_desktop_epoch: 0,
    },
  });
  await f.run("get_app_state", { app_ref: { pid: 700 } });
  const before = f.calls.filter((c) => c.method === "click").length;
  expect(
    (
      await f.run("left_click", {
        app_ref: { pid: 700 },
        target: { type: "coordinate", x: 0, y: 0, frame_id: frame },
      })
    ).isError,
  ).toBe(true);
  expect(f.calls.filter((c) => c.method === "click")).toHaveLength(before);
});
it("allows an implicit latest-frame coordinate across fresh SDK cells", async () => {
  const f = await fixture({ screenshot: true });
  await f.run("get_app_state", { app_ref: { pid: 700 } });
  expect(
    (
      await f.run("left_click", {
        app_ref: { pid: 700 },
        target: { type: "coordinate", x: 0, y: 0 },
      })
    ).isError,
  ).not.toBe(true);
});
it("supports the existing SDK in two fresh workers using the same Host observations", async () => {
  const f = await fixture();
  const { setupComputerUseRuntime } =
    await import("../../../apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs");
  const make = async () => {
    const globals: any = {
      process: { platform: "darwin" },
      [Symbol.for("zcode.node-repl.computer-use-bridge")]: {
        assertAvailable() {},
        call: f.run,
        documentationRoot: "/fixture",
      },
      nodeRepl: { write() {}, emitImage() {} },
    };
    await setupComputerUseRuntime({ globals });
    return globals.agent.computerUse;
  };
  const first = await make();
  const app = await first.getApp({ pid: 700 });
  expect(await app.getAXState({ emit: false })).toContain("中文🌟");
  const fresh = await make();
  const bound = await fresh.getApp({ pid: 700 });
  await bound.setValue(0, "SDK 中文🌟");
  expect(f.calls.at(-1)).toMatchObject({
    method: "element_set_value",
    params: { value: "SDK 中文🌟", native: "token1" },
  });
});

it("keeps stop idempotent without releasing a session twice", async () => {
  const f = await fixture();
  await f.run("stop_computer_control");
  expect((await f.run("stop_computer_control")).isError).not.toBe(true);
  expect(f.calls.filter((c) => c.method === "session_release")).toHaveLength(1);
});
it("SDK exposes stale-state and lock refusals with recovery codes instead of INTERNAL retries", async () => {
  const f = await fixture();
  const { setupComputerUseRuntime } =
    await import("../../../apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs");
  const globals: any = {
    process: { platform: "darwin" },
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: {
      assertAvailable() {},
      call: f.run,
      documentationRoot: "/fixture",
    },
    nodeRepl: { write() {} },
  };
  await setupComputerUseRuntime({ globals });
  const app = await globals.agent.computerUse.getApp({ pid: 700 });
  await app.getAXState({ emit: false });
  f.setEpoch(1);
  await expect(app.setValue(0, "stale")).rejects.toMatchObject({
    code: "STALE_STATE",
    retry: "reobserve",
    actionSent: false,
  });
  f.failObservation();
  await expect(app.getAXState()).rejects.toMatchObject({
    code: "DESKTOP_LOCKED",
    retry: "never",
    actionSent: false,
  });
});

it("chooses raw click for a non-pressable AX element and preserves native refetch authority", async () => {
  const f = await fixture({ pressable: false });
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false });
  expect(
    (await f.run("left_click", { app_ref: { pid: 700 }, target: { type: "element", index: 0 } }))
      .isError,
  ).not.toBe(true);
  expect(f.calls.at(-1)).toMatchObject({
    method: "click",
    params: { native_target: "token1", app_ref: { pid: 700, window_id: 10 } },
  });
});
it("forwards trusted turn context to presentation without accepting it as a model argument", async () => {
  const f = await fixture();
  await f.run("get_app_state", { app_ref: { pid: 700 }, include_screenshot: false }, {
    ...context,
    turnId: "trusted-turn",
  } as any);
  expect(f.calls.find((c) => c.method === "capture_app").params.pip_session_context).toEqual({
    session_id: "s1",
    turn_id: "trusted-turn",
  });
});
