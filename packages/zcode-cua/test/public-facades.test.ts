import { expect, it } from "vitest";
import {
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  buildHelperOpenArgs,
  injectPermissionBrokerAgentMcpServers,
  createCuaProductMcpServerResolver,
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

const officialHost = (authority = "fixture-authority") => ({
  name: "node_repl",
  command: "/fixture/node",
  args: [
    "host.mjs",
    "--permission-broker-socket=old",
    "--permission-broker-socket",
    "older",
    "--",
    "--permission-broker-socket=user",
  ],
  env: [
    { name: "KEEP", value: "unchanged" },
    { name: "ZCODE_PLUGIN_ID", value: "computer-use@zcode-plugins-official" },
    { name: "ZCODE_CUA_PLUGIN_AUTHORITY", value: authority },
    { name: "ZCODE_CUA_PERMISSION_BROKER_SOCKET", value: "stale" },
  ],
});
it("injects the trusted shared Host without corrupting protocol env or user arguments", () => {
  const server = officialHost();
  const original = structuredClone(server);
  const generic = { ...server, name: "browser", env: [] };
  const forged = officialHost("other-authority");
  const result = injectPermissionBrokerAgentMcpServers([server, generic, forged], {
    socketPath: "/private/fixture.sock",
    pluginAuthority: "fixture-authority",
  })!;
  expect(result[0].args).toEqual([
    "host.mjs",
    "--permission-broker-socket",
    "/private/fixture.sock",
    "--",
    "--permission-broker-socket=user",
  ]);
  expect(result[0].env).toEqual(
    expect.arrayContaining([
      { name: "KEEP", value: "unchanged" },
      { name: "ZCODE_CUA_PERMISSION_BROKER_SOCKET", value: "/private/fixture.sock" },
      {
        name: "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
        value: "/private/fixture.sock.refresh",
      },
    ]),
  );
  expect(result[0].env.filter((e) => e.name === "ZCODE_CUA_PERMISSION_BROKER_SOCKET")).toHaveLength(
    1,
  );
  expect(result[1]).toBe(generic);
  expect(result[2]).toBe(forged);
  expect(server).toEqual(original);
  expect(() =>
    injectPermissionBrokerAgentMcpServers([server], {
      socketPath: " ",
      pluginAuthority: "fixture-authority",
    }),
  ).toThrow("socketPath");
  const unmatched = [forged, generic];
  expect(
    injectPermissionBrokerAgentMcpServers(unmatched, {
      socketPath: "/private/fixture.sock",
      pluginAuthority: "fixture-authority",
    }),
  ).toBe(unmatched);
});
it("resolves only authorized shared Hosts and never starts retired standalone CUA", async () => {
  let starts = 0;
  const resolver = createCuaProductMcpServerResolver({
    running: false,
    socketPath: null,
    pluginAuthority: null,
    reservedTransport: {
      socketPath: "/private/resolved.sock",
      pluginAuthority: "fixture-authority",
    },
    async start() {
      starts++;
      return { socketPath: "/private/resolved.sock", pluginAuthority: "fixture-authority" };
    },
  } as any);
  const generic = { name: "node_repl", command: "/fixture/node", args: [], env: [] };
  const legacy = { name: "computer-use", command: "zcode-cua", args: [] };
  expect(await resolver.resolveMcpServers([generic, legacy])).toEqual([generic]);
  expect(starts).toBe(0);
  const server = officialHost();
  const result = await resolver.resolveMcpServers([generic, server]);
  expect(starts).toBe(1);
  expect(result?.[0]).toBe(generic);
  expect(result?.[1].env).toContainEqual({
    name: "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
    value: "/private/resolved.sock",
  });
});
