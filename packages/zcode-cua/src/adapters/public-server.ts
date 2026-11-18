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
  const s = stdioServer(server);
  if (!s) return false;
  return (
    isOfficialSharedHost(s) ||
    s.name === "computer-use" ||
    /(?:^|[/@])zcode-cua(?:$|[/@.])/.test(String(s.command)) ||
    (Array.isArray(s.args) &&
      s.args.some((a) => typeof a === "string" && /(?:^|[/@])zcode-cua(?:$|[/@.])/.test(a)))
  );
}
type StdioServer = Record<string, unknown> & { command: string };
type EnvPair = { name: string; value: string };
function stdioServer(server: unknown): StdioServer | undefined {
  return server &&
    typeof server === "object" &&
    "command" in server &&
    typeof server.command === "string"
    ? (server as StdioServer)
    : undefined;
}
function envPairs(server: StdioServer): EnvPair[] {
  return Array.isArray(server.env)
    ? server.env.filter(
        (e): e is EnvPair =>
          e !== null &&
          typeof e === "object" &&
          typeof e.name === "string" &&
          typeof e.value === "string",
      )
    : [];
}
function isOfficialSharedHost(server: StdioServer): boolean {
  return (
    server.name === "node_repl" &&
    envPairs(server).some(
      (e) => e.name === "ZCODE_PLUGIN_ID" && e.value === "computer-use@zcode-plugins-official",
    )
  );
}
function isAuthorizedSharedHost(
  server: unknown,
  authority: string | null | undefined,
): server is StdioServer {
  const s = stdioServer(server);
  return Boolean(
    s &&
    authority?.trim() &&
    isOfficialSharedHost(s) &&
    envPairs(s).some((e) => e.name === "ZCODE_CUA_PLUGIN_AUTHORITY" && e.value === authority),
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
      if (!servers) return servers;
      // 已退役的独立 MCP 不能因命令名含 zcode-cua 获得 transport；只接受当前 Host 签发的共享宿主。
      const kept = servers.filter(
        (s) => stdioServer(s)?.name === "node_repl" || !isPotentialZCodeCuaAgentMcpServer(s),
      );
      const candidates = kept.length === servers.length ? servers : kept;
      const authority = host.pluginAuthority ?? host.reservedTransport?.pluginAuthority;
      if (!candidates.some((s) => isAuthorizedSharedHost(s, authority))) return candidates;
      const handle = await host.start();
      return injectPermissionBrokerAgentMcpServers(candidates, handle);
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
  options: { socketPath: string; pluginAuthority?: string | null },
) {
  if (!servers || !options.pluginAuthority?.trim()) return servers;
  // 协议 env 是 name/value 数组；对象展开会丢失凭据。authority 匹配必须先于任何注入或启动。
  let changed = false;
  const result = servers.map((server) => {
    if (!isAuthorizedSharedHost(server, options.pluginAuthority)) return server;
    if (!options.socketPath.trim())
      throw new Error("CUA injection requires a non-empty socketPath");
    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : [];
    const delimiter = args.indexOf("--");
    const prefix = delimiter < 0 ? args : args.slice(0, delimiter);
    const kept: string[] = [];
    for (let i = 0; i < prefix.length; i++) {
      const arg = prefix[i];
      if (arg === "--permission-broker-socket") {
        if (prefix[i + 1] && !prefix[i + 1].startsWith("--")) i++;
      } else if (!arg.startsWith("--permission-broker-socket=")) kept.push(arg);
    }
    const env = envPairs(server)
      .filter(
        (e) =>
          ![
            "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
            "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
          ].includes(e.name),
      )
      .map((e) => ({ ...e }));
    env.push(
      { name: "ZCODE_CUA_PERMISSION_BROKER_SOCKET", value: options.socketPath },
      {
        name: "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
        value: cuaBrokerRefreshMarkerPath(options.socketPath),
      },
    );
    changed = true;
    return {
      ...server,
      args: [
        ...kept,
        "--permission-broker-socket",
        options.socketPath,
        ...(delimiter < 0 ? [] : args.slice(delimiter)),
      ],
      env,
    } as T;
  });
  return changed ? result : servers;
}
