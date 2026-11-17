import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  CuaProductHelperHost,
  HelperLaunchSpec,
  CuaProductMcpServerResolverContext,
} from "../../broker-server.js";
import { HELPER_NAME, HELPER_ID, executablePath } from "./helper-installer.js";
export {
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
} from "./helper-installer.js";
export { createProductCuaHelperHost } from "./helper-host.js";
export { CuaHelperLifecycleManager } from "../app/lifecycle.js";
export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";
export function buildHelperOpenArgs(spec: HelperLaunchSpec, launcherPid?: number) {
  const args = [
    "-g",
    "-n",
    "-a",
    String(spec.appPath),
    "--args",
    "--socket",
    String(spec.socketPath),
    "--runtime-dir",
    dirname(String(spec.socketPath)),
  ];
  if (launcherPid) args.push("--launcher-pid", String(launcherPid));
  if (spec.pipMode) args.push("--pip-mode");
  if (spec.ghostCursorOverlay) args.push("--ghost-cursor-overlay");
  if (spec.allowUnsignedLauncherLocalDev) args.push("--allow-unsigned-launcher-local-dev");
  return args;
}
export const isCuaLocalDevelopmentRuntime = (
  env: NodeJS.ProcessEnv = process.env,
  compiled = false,
) => compiled && env.ZCODE_RUNTIME_ENV !== "production";
export async function resolveHelperPermissionSubjectIdentity(appPath: string) {
  return {
    appPath,
    executablePath: executablePath(appPath),
    displayName: "KCode Computer Use",
    bundleId: HELPER_ID,
  };
}
export const cuaBrokerRefreshMarkerPath = (socket: string) => `${socket}.refresh`;
export async function publishCuaBrokerRefreshMarker(
  socket: string,
  options?: { deadlineMs?: number; now?: () => number },
) {
  const path = cuaBrokerRefreshMarkerPath(socket);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify({
      id: randomUUID(),
      requestedAt: options?.now?.() ?? Date.now(),
      deadlineMs: options?.deadlineMs ?? 10000,
    }),
    { mode: 0o600 },
  );
  return { path };
}
export const resolveHelperAppName = () => HELPER_NAME;
export const resolveCuaHelperInstallRoot = (env: NodeJS.ProcessEnv = process.env) =>
  env.ZCODE_CUA_HELPER_INSTALL_ROOT || join(homedir(), "Applications");
export const standaloneHelperCandidatePaths = (env: NodeJS.ProcessEnv = process.env) => [
  join(resolveCuaHelperInstallRoot(env), HELPER_NAME),
];
const identity = (context: CuaProductMcpServerResolverContext | undefined) =>
  context?.workspaceIdentity?.trim() || context?.workspacePath || "";
export class CuaProductHelperWorkspaceRegistry {
  private readonly enabled = new Map<string, boolean>();
  setEnabled(context: CuaProductMcpServerResolverContext | undefined, enabled: boolean) {
    this.enabled.set(identity(context), enabled);
  }
}
export const isOfficialCuaPluginEnabledForWorkspace = (options: { env?: NodeJS.ProcessEnv } = {}) =>
  !["0", "off", "false"].includes(options.env?.ZCODE_CUA_PRODUCT_HELPER?.toLowerCase() ?? "");
export function isPotentialZCodeCuaAgentMcpServer(server: unknown) {
  if (!server || typeof server !== "object") return false;
  const s = server as Record<string, unknown>;
  return (
    (typeof s.command === "string" && /zcode-cua/.test(s.command)) ||
    (Array.isArray(s.args) && s.args.some((a) => typeof a === "string" && /zcode-cua/.test(a)))
  );
}
export function createCuaProductMcpServerResolver(
  host: CuaProductHelperHost,
  options?: { hasActiveTurn?: () => boolean },
) {
  async function restart() {
    if (options?.hasActiveTurn?.())
      throw new Error("Computer use is busy; cancel and drain before restart");
    await host.restartAfterCurrentStart();
  }
  return {
    async resolveMcpServers<T>(servers: T[] | undefined) {
      if (!servers?.some(isPotentialZCodeCuaAgentMcpServer)) return servers;
      const handle = await host.start();
      return servers.map((s) =>
        isPotentialZCodeCuaAgentMcpServer(s)
          ? {
              ...s,
              env: {
                ...(s as any).env,
                ZCODE_CUA_PERMISSION_BROKER_SOCKET: handle.socketPath,
                ZCODE_CUA_PLUGIN_AUTHORITY: handle.pluginAuthority,
              },
            }
          : s,
      );
    },
    restart,
    async restartAfterPermissionGrant() {
      await restart();
    },
  };
}
export async function waitForCuaHelperStartup<T>(startup: Promise<T>, deadlineMs = 10000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      startup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CUA startup deadline exceeded")), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const unavailable = new WeakSet<object>();
export const markCuaProductHelperAgentEnvUnavailable = (host: object) => {
  unavailable.add(host);
};
export const hasCuaProductHelperAgentEnvUnavailable = (host: object) => unavailable.has(host);
export const clearCuaProductHelperAgentEnvUnavailable = (host: object) => {
  unavailable.delete(host);
};
export const isScreenCaptureProbeSuccess = (probe: { ok: boolean } | undefined) =>
  probe?.ok === true;
// 原生 Helper 是跨 Host 共享 owner；失去启动者不构成杀进程的依据。
export async function reapOrphanedHelpers(_options?: unknown) {}
export function injectPermissionBrokerAgentMcpServers<T>(
  servers: T[] | undefined,
  _options: unknown,
) {
  return servers;
}
