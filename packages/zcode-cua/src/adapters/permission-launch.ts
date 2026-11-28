import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CuaPermissionStatusQueryReport } from "../../broker-server.js";
import { NativeBrokerError } from "./broker-client.js";
import { HELPER_ID, createCuaHelperInstaller } from "./helper-installer.js";
const exec = promisify(execFile);
export async function readFreshHelperPermissions(options: {
  appPath: string;
  env?: NodeJS.ProcessEnv;
  launch?: (command: string, args: string[]) => Promise<void>;
}): Promise<CuaPermissionStatusQueryReport> {
  const dir = await mkdtemp(join(tmpdir(), "kcode-cua-preflight-"));
  const path = join(dir, "result.json");
  const args = [
    "-g",
    "-n",
    "-a",
    options.appPath,
    "--args",
    "--permission-preflight",
    "all",
    "--permission-preflight-result-file",
    path,
  ];
  try {
    if (options.launch) await options.launch("/usr/bin/open", args);
    else await exec("/usr/bin/open", args, { env: options.env, timeout: 3000 });
    const deadline = Date.now() + 3000;
    let result: unknown;
    for (;;) {
      try {
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.size > 8192
        )
          throw new NativeBrokerError("invalid_response", "Unsafe permission reply");
        result = JSON.parse(await readFile(path, "utf8"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (Date.now() >= deadline)
          throw new NativeBrokerError("timeout", "Fresh Helper preflight did not reply");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const report = result as CuaPermissionStatusQueryReport;
    if (
      !report ||
      report.grant_owner !== HELPER_ID ||
      !["granted", "denied", "unknown"].includes(report.accessibility) ||
      !["granted", "denied", "unknown"].includes(report.screen_recording) ||
      !["unlocked", "locked", "unknown"].includes(String(report.desktop_availability))
    )
      throw new NativeBrokerError("invalid_response", "Fresh Helper permission facts are invalid");
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function requestPermission(kind: "accessibility" | "screen", options: unknown) {
  const input = (options ?? {}) as {
    env?: NodeJS.ProcessEnv;
    appPath?: string;
    bundledAppPath?: string;
  };
  try {
    const installer = createCuaHelperInstaller(input);
    const app = input.appPath ?? (await installer.ensureInstalled());
    await installer.verifyInstalled(app);
    await exec("/usr/bin/open", ["-g", "-n", "-a", app, "--args", "--request-permission", kind], {
      env: input.env,
      timeout: 5000,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Could not request native permission",
    };
  }
}
export const requestHelperAccessibilityPermissionViaLaunchServices = (options?: unknown) =>
  requestPermission("accessibility", options);
export const requestHelperScreenRecordingPermissionViaLaunchServices = (options?: unknown) =>
  requestPermission("screen", options);
