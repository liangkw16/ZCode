import { expect, it } from "vitest";
import {
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  buildHelperOpenArgs,
} from "../broker-server.js";
import { cuaRequestAccessStatusSchema } from "../request-access-contract.js";
import { shouldRunCuaScreenCaptureProbe } from "../broker-ports.js";
it("public host facade reaches the source lifecycle and retains a shared managed host", async () => {
  const expected = new Error("fixture install refused");
  const host = createProductCuaHelperHost({
    helperInstaller: {
      async ensureInstalled() {
        throw expected;
      },
      async verifyInstalled() {},
    },
  });
  await expect(host.start()).rejects.toBe(expected);
  let count = 0;
  const manager = new CuaHelperLifecycleManager<{ id: number }>();
  const create = () => ({ id: ++count });
  const a = await manager.acquire({ create });
  const b = await manager.acquire({ create, shouldRetainCurrent: () => true });
  expect(a).toBe(b);
  expect(count).toBe(1);
  await manager.dispose();
  expect(manager.disposed).toBe(true);
  expect(await manager.acquire({ create })).toBeUndefined();
});
it("launch args select the canonical app and read-only status never silently captures pixels", () => {
  expect(
    buildHelperOpenArgs(
      {
        appPath: "/fixture/KCode Computer Use.app",
        socketPath: "/tmp/test.sock",
        ghostCursorOverlay: true,
        pipMode: true,
      },
      123,
    ),
  ).toEqual(
    expect.arrayContaining(["--socket", "/tmp/test.sock", "--launcher-pid", "123", "--pip-mode"]),
  );
  expect(shouldRunCuaScreenCaptureProbe("granted", {})).toBe(false);
  expect(shouldRunCuaScreenCaptureProbe("granted", { probeScreenCapture: true })).toBe(true);
  expect(shouldRunCuaScreenCaptureProbe("denied", { probeScreenCapture: true })).toBe(false);
});
it("request-access metadata validates actual facts rather than rejecting every valid status", () => {
  expect(
    cuaRequestAccessStatusSchema.safeParse({
      schemaVersion: 1,
      platform: "darwin",
      grantOwner: "stableHelper",
      accessibility: "granted",
      screenRecording: "denied",
    }).success,
  ).toBe(true);
  expect(
    cuaRequestAccessStatusSchema.safeParse({
      schemaVersion: 1,
      platform: "darwin",
      grantOwner: "stableHelper",
      accessibility: "maybe",
      screenRecording: "granted",
    }).success,
  ).toBe(false);
});
it("keeps the existing explicit functional-probe option and rejects malformed permission facts", async () => {
  const { isCuaPermissionStatusAvailable } = await import("../broker-ports.js");
  expect(shouldRunCuaScreenCaptureProbe("granted", { includeFunctionalProbes: true })).toBe(true);
  expect(
    isCuaPermissionStatusAvailable({
      accessibility: "maybe",
      screenRecording: "granted",
      grantOwner: null,
    } as any),
  ).toBe(false);
});
it("uses one stable KCode socket while preserving explicit transport overrides", async () => {
  const { resolveBrokerSocketPath, mintBrokerSocketPath } = await import("../broker.js");
  expect(resolveBrokerSocketPath({ env: {} })).toBe(resolveBrokerSocketPath({ env: {} }));
  expect(resolveBrokerSocketPath({ env: { XDG_RUNTIME_DIR: "/private/fixture" } })).toBe(
    "/private/fixture/zcode-cua/kcode-broker.sock",
  );
  expect(
    resolveBrokerSocketPath({ env: { ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/explicit/socket" } }),
  ).toBe("/explicit/socket");
  expect(mintBrokerSocketPath()).not.toBe(mintBrokerSocketPath());
});
