// Runs against the source Helper and the native GUI fixture; never substitutes this for model acceptance.
import assert from "node:assert/strict";
import { createBrokerClient } from "../dist/adapters/broker-client.js";
const socketPath = process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET;
assert.ok(socketPath, "Provide the verified source Helper socket");
const oracle = () => fetch("http://127.0.0.1:19437/").then((r) => r.json());
const initial = await oracle();
const client = createBrokerClient({ socketPath, timeoutMs: 12000 });
const context = { session: "native-acceptance" };
try {
  const state = await client.call(
    "capture_app",
    { app_ref: { pid: initial.pid }, include_screenshot: false },
    context,
  );
  const text = state.elements.find((e) => e.editable && e.title === "Fixture text");
  const check = state.elements.find((e) => e.title === "Confirm fixture");
  assert.ok(text, "Fixture AX text element missing");
  assert.ok(check, "Fixture checkbox missing");
  await client.call("element_set_value", { native: text.native, value: "中文🌟 native" }, context);
  await client.call("element_press", { native: check.native }, context);
  const after = await oracle();
  assert.equal(after.text, "中文🌟 native");
  assert.equal(after.checked, !initial.checked);
  const screenshot = await client.call(
    "capture_app",
    { app_ref: { pid: initial.pid }, include_screenshot: true },
    context,
  );
  assert.ok(screenshot.screenshot?.data, "Real ScreenCaptureKit raster missing");
  assert.ok(screenshot.screenshot.width > 100);
  assert.ok(screenshot.screenshot.height > 100);
  console.log(
    JSON.stringify({
      passed: true,
      pid: initial.pid,
      elements: state.elements.length,
      raster: { width: screenshot.screenshot.width, height: screenshot.screenshot.height },
    }),
  );
} finally {
  await client.close();
}
