import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, unlink } from "node:fs/promises";
import { withLifecycleGuard } from "./lifecycle-guard.js";
import { runtimeDirectory, resolveBrokerSocketPath } from "./socket-path.js";
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
import { readFreshHelperPermissions } from "./permission-launch.js";
import { socketOwner, retireProcess, type ProcessIdentity } from "./process-identity.js";
const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function createProductCuaHelperHost(
  options: CreateProductCuaHelperHostOptions = {},
): CuaHelperHost {
  const env = options.env ?? process.env;
  const runtimeDir = runtimeDirectory(env);
  const path = resolveBrokerSocketPath({ env });
  const authority = randomUUID();
  const installer =
    options.helperInstaller ??
    createCuaHelperInstaller({ env, bundledAppPath: options.bundledHelperAppPath });
  let handle: CuaHelperHandle | undefined;
  let starting: Promise<CuaHelperHandle> | undefined;
  let stopping: Promise<void> | undefined;
  let lastIdentity: ProcessIdentity | undefined;
  let restarting: Promise<{ handle: CuaHelperHandle; reused: boolean }> | undefined;
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
      desktop_epoch: number;
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
    if (appPath) {
      const owner = await socketOwner(executablePath(appPath), path, executablePath(appPath));
      if (owner.pid !== info.pid)
        throw new NativeBrokerError(
          "not_authorized",
          "Reported PID does not own the Helper socket",
        );
      lastIdentity = owner;
    }
    if (appPath && (await helperManifest(appPath)).buildId !== info.version)
      throw new NativeBrokerError(
        "version_mismatch",
        "Running Helper differs from installed source build",
      );
    return info;
  }
  async function startLocked(guardHeld = false): Promise<CuaHelperHandle> {
    try {
      appPath = await installer.ensureInstalled();
    } catch (error) {
      if (
        !(error instanceof NativeBrokerError) ||
        error.code !== "upgrade_required" ||
        !guardHeld ||
        !options.bundledHelperAppPath
      )
        throw error;
      const identity = error.details as unknown as ProcessIdentity;
      await retireProcess(executablePath(options.bundledHelperAppPath), identity);
      appPath = await installer.ensureInstalled();
    }
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
      if (!(error instanceof NativeBrokerError)) throw error;
      const absent =
        error.code === "broker_unavailable" &&
        ["ENOENT", "ECONNREFUSED"].includes(String(error.details.connection_code));
      const stalled = ["timeout", "helper_unresponsive"].includes(error.code);
      if (!absent && !stalled) throw error;
      if (stalled && !guardHeld)
        await socketOwner(executablePath(appPath), path, executablePath(appPath)).catch(() => {
          throw error;
        });
      if (!guardHeld) return withLifecycleGuard(appPath, runtimeDir, () => startLocked(true));
      if (stalled) {
        // 超时不能证明进程死亡；先由内核 socket owner 和签名确认归属，再收敛旧进程。
        const identity = await socketOwner(
          executablePath(appPath),
          path,
          executablePath(appPath),
        ).catch(() => {
          throw error;
        });
        await retireProcess(executablePath(appPath), identity);
        handle = undefined;
        lastIdentity = undefined;
      }
    }
    if (!guardHeld) return withLifecycleGuard(appPath, runtimeDir, () => startLocked(true));
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
      "--pip-mode",
      "--ghost-cursor-overlay",
    ];
    if (env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL === "1")
      args.push("--allow-unsigned-launcher-local-dev");
    await exec("/usr/bin/open", ["-g", "-n", "-a", appPath, "--args", ...args], { env });
    const deadline = Date.now() + (options.healthTimeoutMs ?? 10000);
    let last: unknown;
    do {
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
  async function start() {
    if (options.bundledHelperAppPath) {
      await installer.verifyInstalled(options.bundledHelperAppPath);
      return withLifecycleGuard(options.bundledHelperAppPath, runtimeDir, () => startLocked(true));
    }
    return startLocked();
  }
  function restartFresh(
    beforeFreshStart?: () => void,
  ): Promise<{ handle: CuaHelperHandle; reused: boolean }> {
    if (stopping) return stopping.then(() => restartFresh(beforeFreshStart));
    if (restarting) return restarting;
    const expectedPid = handle?.pid;
    const pendingStart = starting;
    restarting = (async () => {
      if (pendingStart) await pendingStart;
      const guardApp =
        options.bundledHelperAppPath ?? appPath ?? (await installer.ensureInstalled());
      await installer.verifyInstalled(guardApp);
      return withLifecycleGuard(guardApp, runtimeDir, async () => {
        appPath ??= await installer.ensureInstalled();
        const identity = await socketOwner(
          executablePath(guardApp),
          path,
          executablePath(appPath!),
        ).catch(async (error) => {
          if (lastIdentity) return lastIdentity;
          throw error;
        });
        if (expectedPid && identity.pid !== expectedPid)
          return { handle: await startLocked(true), reused: true };
        // 正常重启不能打断其他 Host 的原生工作；失去响应时按精确身份执行受控恢复。
        const status = await query<{ active_operations?: number }>("controller_status").catch(
          () => undefined,
        );
        if (status && typeof status.active_operations === "number" && status.active_operations > 0)
          throw new NativeBrokerError(
            "controller_busy",
            "Native work must drain before restarting the shared Helper",
          );
        await retireProcess(executablePath(guardApp), identity);
        lastIdentity = undefined;
        handle = undefined;
        beforeFreshStart?.();
        return { handle: await startLocked(true), reused: false };
      });
    })().finally(() => {
      restarting = undefined;
    });
    return restarting;
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
      if (stopping) return stopping.then(() => host.start());
      if (restarting) return restarting.then((result) => result.handle);
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
      const pendingStart = starting,
        pendingRestart = restarting;
      stopping = (async () => {
        await Promise.allSettled([pendingStart, pendingRestart]);
        // 先等已接受的重启收敛，避免 stop 完成后又写回 running；共享 Helper 仍由其他 Host 复用。
        handle = undefined;
      })().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
    async restart() {
      return (await restartFresh()).handle;
    },
    restartAfterCurrentStart() {
      return host.restart();
    },
    restartAfterCurrentStartPreservingTransport(restartOptions) {
      return restartFresh(restartOptions?.beforeFreshStart);
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
      return (await readFreshHelperPermissions({ appPath: appPath!, env })).screen_recording;
    },
    async queryPermissionStatus(queryOptions) {
      if (!appPath) await host.start();
      const healthInfo = await health();
      const fresh = await readFreshHelperPermissions({ appPath: appPath!, env });
      const resident = await query<import("../../broker-server.js").CuaPermissionStatusQueryReport>(
        "permission_status",
        { include_functional_probes: queryOptions?.includeFunctionalProbes === true },
      );
      return {
        ...resident,
        ...fresh,
        accessibility_probe: resident.accessibility_probe,
        helper_generation: healthInfo.generation,
        desktop_epoch: healthInfo.desktop_epoch,
        fresh_preflight: true,
      };
    },
  };
  return host;
}
