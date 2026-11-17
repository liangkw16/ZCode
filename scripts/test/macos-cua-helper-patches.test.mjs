import assert from "node:assert/strict";
import test from "node:test";
import {
  installMacosCuaSessionGate,
  patchMacosCuaSessionGate,
  macosCuaScrollDistance,
  patchMacosCuaScrollPages,
} from "../../packages/desktop/scripts/macos-cua-helper-patches.mjs";

function fixture(states) {
  const calls = [];
  const backend = Object.fromEntries(
    [
      "click",
      "paste",
      "hold_key",
      "element_set_value",
      "capture_app",
      "cancel_input_holds",
      "broker_info",
    ].map((name) => [
      name,
      async (value) => {
        calls.push(name);
        return value;
      },
    ]),
  );
  const denied = (message, details) =>
    Object.assign(new Error(message), { code: "permission_denied", details });
  installMacosCuaSessionGate(backend, { readConsoleState: async () => states.shift(), denied });
  return { backend, calls };
}

test("locked observation and input are rejected without dispatch; unlock recovers the same backend", async () => {
  const { backend, calls } = fixture([
    '"IOConsoleLocked" = Yes',
    '"IOConsoleLocked" = Yes',
    '"IOConsoleLocked" = No',
  ]);
  for (const name of ["hold_key", "capture_app"]) {
    await assert.rejects(
      backend[name]({}),
      (error) => error.details.reason === "screen_locked" && error.details.action_sent === false,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(await backend.paste("after unlock"), "after unlock");
  assert.deepEqual(calls, ["paste"]);
});

test("unreadable, absent and ambiguous session states fail closed", async () => {
  for (const state of [
    null,
    "",
    '"OtherKey" = No',
    '"IOConsoleLocked" = No\n"IOConsoleLocked" = Yes',
  ]) {
    const { backend, calls } = fixture([state]);
    await assert.rejects(
      backend.click({}),
      (error) =>
        error.details.reason === "session_state_unavailable" && error.details.action_sent === false,
    );
    assert.deepEqual(calls, []);
  }
});

test("probe failures do not dispatch input", async () => {
  let dispatched = false;
  const backend = {
    click: async () => {
      dispatched = true;
    },
  };
  installMacosCuaSessionGate(backend, {
    readConsoleState: async () => {
      throw new Error("probe failed");
    },
    denied: (message, details) => Object.assign(new Error(message), { details }),
  });
  await assert.rejects(
    backend.click(),
    (error) => error.details.reason === "session_state_unavailable",
  );
  assert.equal(dispatched, false);
});

test("cancellation and health reads remain available while locked", async () => {
  const { backend, calls } = fixture([]);
  await backend.cancel_input_holds("released");
  await backend.broker_info("healthy");
  assert.deepEqual(calls, ["cancel_input_holds", "broker_info"]);
});

test("patch applies at the unique Helper backend entry and refuses an unexpected producer", () => {
  const source =
    "function runHelper() {\n    adapter = nextAdapter;\n    activeBackend = nextBackend;\n}";
  const patched = patchMacosCuaSessionGate(source);
  assert.match(patched, /\}\)\(nextBackend,/);
  assert.doesNotThrow(() => new Function(patched));
  assert.match(patched, /\/usr\/sbin\/ioreg/);
  assert.throws(() => patchMacosCuaSessionGate("unknown"), /exactly one/);
  assert.throws(() => patchMacosCuaSessionGate(source + source), /exactly one/);
  assert.throws(() => patchMacosCuaSessionGate(patched), /already/);
});

// 真机 scroll(1) 只移动 1px；公开页数必须在原生像素边界换算。
test("macOS scroll pages use the validated window axis with a visible page distance", () => {
  const bounds = [853, -1920, 2160, 1920];
  assert.equal(macosCuaScrollDistance(1, "down", bounds), 1536);
  assert.equal(macosCuaScrollDistance(2, "up", bounds), 3072);
  assert.equal(macosCuaScrollDistance(1, "left", bounds), 1728);
  assert.equal(macosCuaScrollDistance(1, "right", bounds), 1728);
  assert.equal(macosCuaScrollDistance(0, "down", bounds), 0);
});

test("scroll patch converts only the unique macOS window dispatch and refuses drift", () => {
  const call =
    "adapter.scrollToWindow(target.pid, target.bundleId, target.windowId, target.bounds, point2.x, point2.y, amount2, direction2, ...provenAttachedSurfaceArgs(target))";
  const patched = patchMacosCuaScrollPages(call);
  assert.match(patched, /macosCuaScrollDistance/);
  assert.doesNotThrow(() => new Function(patched));
  assert.throws(() => patchMacosCuaScrollPages("unknown"), /exactly one/);
  assert.throws(() => patchMacosCuaScrollPages(call + call), /exactly one/);
  assert.throws(() => patchMacosCuaScrollPages(patched), /exactly one/);
});
