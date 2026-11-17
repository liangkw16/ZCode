import assert from "node:assert/strict";
import test from "node:test";
import {
  installMacosCuaSessionGate,
  patchMacosCuaSessionGate,
  macosCuaScrollDistance,
  patchMacosCuaScrollPages,
  dispatchMacosCuaScrollPixels,
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
  const adapter = `scrollToWindow: hasMacBackgroundInput ? (...args) => withMacBackgroundSequence("scroll_to_window", () => {
      const dispatch = scrollToWindow ?? scrollToWindowLegacy;
      return dispatch(...args);
    }) : void 0,`;
  const source = call + ";\nconst adapterFixture = {" + adapter + "};";
  const patched = patchMacosCuaScrollPages(source);
  assert.match(patched, /macosCuaScrollDistance/);
  assert.match(patched, /withMacBackgroundSequence\("scroll_to_window", \(\) =>/);
  assert.match(patched, /dispatchMacosCuaScrollPixels/);
  assert.doesNotThrow(() => new Function(patched));
  assert.throws(() => patchMacosCuaScrollPages("unknown"), /exactly one/);
  assert.throws(() => patchMacosCuaScrollPages(source + source), /exactly one/);
  assert.throws(() => patchMacosCuaScrollPages(patched), /exactly one/);
});

test("native scroll dispatch keeps every event within the 100px ABI and preserves target proof", async () => {
  const calls = [];
  const bounds = [853, -1920, 2160, 1920];
  const args = [3629, "com.google.Chrome", 49193, bounds, 1933, -960, 1536, "down", true];
  const sent = await dispatchMacosCuaScrollPixels(async (...input) => {
    calls.push(input);
    return true;
  }, args);
  assert.equal(sent, true);
  assert.equal(calls.length, 16);
  assert.equal(
    calls.reduce((sum, input) => sum + input[6], 0),
    1536,
  );
  for (const input of calls) {
    assert(input[6] > 0 && input[6] <= 100);
    assert.deepEqual(input.slice(0, 6), args.slice(0, 6));
    assert.deepEqual(input.slice(7), args.slice(7));
  }
});

test("native scroll stops after refusal, unavailable receipt or error without replay", async () => {
  for (const outcome of [false, undefined, new Error("native rejection")]) {
    let calls = 0;
    const args = [3629, "com.google.Chrome", 49193, [0, 0, 2160, 1920], 50, 100, 1536, "down"];
    const result = dispatchMacosCuaScrollPixels(async () => {
      calls++;
      if (calls === 1) return true;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }, args);
    if (outcome instanceof Error) await assert.rejects(result, /native rejection/);
    else assert.equal(await result, false);
    assert.equal(calls, 2);
  }
});
