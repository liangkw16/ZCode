import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  CuaHelperHandle,
  CuaHelperHost,
  CreateProductCuaHelperHostOptions,
} from "../../broker-server.js";
import { createBrokerClient, NativeBrokerError } from "./broker-client.js";
import {
  createCuaHelperInstaller,
  executablePath,
  HELPER_ID,
  helperManifest,
} from "./helper-installer.js";
const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function processExecutable(pid: number) {
  const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "comm="]);
  return stdout.trim();
}
export function createProductCuaHelperHost(
  options: CreateProductCuaHelperHostOptions = {},
): CuaHelperHost {
  const env = options.env ?? process.env;
  const runtimeDir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "zcode-cua")
    : `/tmp/zcode-cua-${process.getuid?.() ?? "nouid"}`;
  const path = env.ZCODE_CUA_PERMISSION_BROKER_SOCKET || join(runtimeDir, "broker.sock");
  const authority = randomUUID();
  const installer =
    options.helperInstaller ??
    createCuaHelperInstaller({ env, bundledAppPath: options.bundledHelperAppPath });
  let handle: CuaHelperHandle | undefined;
  let starting: Promise<CuaHelperHandle> | undefined;
  let stopping: Promise<void> | undefined;
  let ownedPid: number | undefined;
  let appPath: string | undefined;
  const client = () => createBrokerClient({ socketPath: path, timeoutMs: 2500 });
  async function query<T>(method: string, params?: Record<string, unknown>) {
    const connection = client();
    try {
      return await connection.call<T>(method, params);
    } finally {
      await connection.close();
    }
  }
  async function health() {
    const info = await query<{
      pid: number;
      bundle_id: string;
      generation: string;
      main_loop_responsive: boolean;
      version: string;
    }>("broker_info");
    if (
      info.bundle_id !== HELPER_ID ||
      !Number.isSafeInteger(info.pid) ||
      info.pid < 2 ||
      !info.main_loop_responsive
    )
      throw new NativeBrokerError(
        "helper_unresponsive",
        "Helper identity or AppKit health check failed",
      );
    if (appPath && (await processExecutable(info.pid)) !== executablePath(appPath))
      throw new NativeBrokerError("not_authorized", "Socket belongs to another executable");
    if (appPath && (await helperManifest(appPath)).buildId !== info.version)
      throw new NativeBrokerError(
        "version_mismatch",
        "Running Helper differs from installed source build",
      );
    return info;
  }
  async function start() {
    if (stopping) await stopping;
    appPath = await installer.ensureInstalled();
    await installer.verifyInstalled(appPath);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(runtimeDir);
    if (
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077
    )
      throw new NativeBrokerError(
        "not_authorized",
        "CUA runtime directory must be private and user owned",
      );
    try {
      const info = await health();
      handle = {
        socketPath: path,
        launchSocketPath: path,
        pluginAuthority: authority,
        helperAppPath: appPath,
        bundleId: HELPER_ID,
        pid: info.pid,
      };
      return handle;
    } catch (error) {
      // 签名或版本不匹配不能当作“未启动”另起进程，避免并行原生 owner。
      if (
        !(error instanceof NativeBrokerError) ||
        error.code !== "broker_unavailable" ||
        !["ENOENT", "ECONNREFUSED"].includes(String(error.details.connection_code))
      )
        throw error;
    }
    try {
      const stale = await lstat(path);
      if (!stale.isSocket() || stale.uid !== process.getuid?.())
        throw new NativeBrokerError("not_authorized", "Unsafe stale CUA socket");
      // A refused socket has no accepting owner; a live but slow owner was rejected above.
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const args = [
      "--socket",
      path,
      "--runtime-dir",
      runtimeDir,
      "--launcher-pid",
      String(process.pid),
    ];
    if (env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL === "1")
      args.push("--allow-unsigned-launcher-local-dev");
    await exec("/usr/bin/open", ["-g", "-n", "-a", appPath, "--args", ...args], { env });
    const deadline = Date.now() + (options.healthTimeoutMs ?? 10000);
    let last: unknown;
    do {
      try {
        const info = await health();
        ownedPid = info.pid;
        handle = {
          socketPath: path,
          launchSocketPath: path,
          pluginAuthority: authority,
          helperAppPath: appPath,
          bundleId: HELPER_ID,
          pid: info.pid,
        };
        return handle;
      } catch (error) {
        last = error;
        if (
          error instanceof NativeBrokerError &&
          ["not_authorized", "version_mismatch"].includes(error.code)
        )
          throw error;
      }
      await pause(50);
    } while (Date.now() < deadline);
    throw new NativeBrokerError(
      "health_timeout",
      `Source Helper did not become ready (${last instanceof NativeBrokerError ? last.code : "unknown"})`,
    );
  }
  const host: CuaHelperHost = {
    get running() {
      return Boolean(handle);
    },
    get socketPath() {
      return handle?.socketPath ?? null;
    },
    get pluginAuthority() {
      return handle?.pluginAuthority ?? null;
    },
    get reservedTransport() {
      return { socketPath: path, pluginAuthority: authority };
    },
    start() {
      if (!starting)
        starting = start()
          .catch((error) => {
            handle = undefined;
            throw error;
          })
          .finally(() => {
            starting = undefined;
          });
      return starting;
    },
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (starting) await starting.catch(() => {});
        // Shared service stays alive when another Host may own sessions. Logical session cleanup belongs to runtime.dispose.
        handle = undefined;
      })().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
    async restart() {
      if (starting) await starting;
      if (
        ownedPid &&
        appPath &&
        (await processExecutable(ownedPid).catch(() => "")) === executablePath(appPath)
      ) {
        process.kill(ownedPid, "SIGTERM");
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            process.kill(ownedPid, 0);
          } catch {
            ownedPid = undefined;
            break;
          }
          await pause(50);
        }
        if (ownedPid)
          throw new NativeBrokerError(
            "cleanup_incomplete",
            "Previous Helper has not exited; refusing a parallel restart",
          );
      }
      handle = undefined;
      return host.start();
    },
    restartAfterCurrentStart() {
      return host.restart();
    },
    async restartAfterCurrentStartPreservingTransport(restartOptions) {
      restartOptions?.beforeFreshStart?.();
      const next = await host.restart();
      return { handle: next, reused: false };
    },
    async waitForTransport() {
      const current = await host.start();
      return { socketPath: current.socketPath, pluginAuthority: current.pluginAuthority };
    },
    async checkHealth() {
      const info = await health();
      return { bundleId: info.bundle_id, pid: info.pid };
    },
    async queryScreenCaptureProbe() {
      return query("screen_capture_probe");
    },
    async queryScreenRecordingPreflight() {
      if (!appPath) await host.start();
      const { stdout } = await exec(
        executablePath(appPath!),
        ["--permission-preflight", "screen"],
        { env, timeout: 3000, maxBuffer: 8192 },
      );
      const result: { screen_recording?: string } = JSON.parse(stdout);
      return ["granted", "denied", "unknown"].includes(result.screen_recording ?? "")
        ? (result.screen_recording as "granted" | "denied" | "unknown")
        : "unknown";
    },
    async queryPermissionStatus() {
      return query("permission_status");
    },
  };
  return host;
}
