import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { NativeBrokerError } from "./broker-client.js";
const exec = promisify(execFile);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export interface ProcessIdentity {
  pid: number;
  birth: string;
  executable: string;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
export async function readProcessIdentity(
  inspector: string,
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const { stdout } = await exec(inspector, ["--process-identity", String(pid)], {
      timeout: 1500,
      maxBuffer: 8192,
    });
    const value: ProcessIdentity = JSON.parse(stdout);
    if (value.pid !== pid || !value.birth || typeof value.executable !== "string")
      throw new NativeBrokerError("invalid_response", "Invalid process identity proof");
    return value;
  } catch (error) {
    if (!alive(pid)) return undefined;
    throw error;
  }
}
export async function socketOwner(
  inspector: string,
  path: string,
  expectedExecutable: string,
): Promise<ProcessIdentity> {
  // macOS proc_pidpath 返回 /private/var；调用方的 /var 是合法别名，比较前必须解析同一真实文件。
  const canonicalExecutable = await realpath(expectedExecutable);
  const { stdout } = await exec(inspector, ["--inspect-socket-owner", path, canonicalExecutable], {
    timeout: 1500,
    maxBuffer: 8192,
  });
  const value: ProcessIdentity = JSON.parse(stdout);
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !value.birth ||
    value.executable !== canonicalExecutable
  )
    throw new NativeBrokerError("not_authorized", "Invalid socket-owner proof");
  return value;
}
export async function retireProcess(inspector: string, expected: ProcessIdentity) {
  const unchanged = async () => {
    const actual = await readProcessIdentity(inspector, expected.pid);
    return !!actual && actual.birth === expected.birth && actual.executable === expected.executable;
  };
  if (!(await unchanged())) return;
  process.kill(expected.pid, "SIGTERM");
  let deadline = Date.now() + 5000;
  while (Date.now() < deadline && alive(expected.pid)) await pause(25);
  if (!alive(expected.pid) || !(await unchanged())) return;
  // 只终止已验证 PID/出生身份/路径均未变化的自有 Helper；确认死亡前不允许新 generation。
  process.kill(expected.pid, "SIGKILL");
  deadline = Date.now() + 3000;
  while (Date.now() < deadline && alive(expected.pid)) await pause(25);
  if (alive(expected.pid) && (await unchanged()))
    throw new NativeBrokerError(
      "cleanup_incomplete",
      "Owned Helper did not exit within its recovery budget",
    );
}
export async function findLiveHelper(inspector: string, expectedExecutable: string) {
  const canonicalExecutable = await realpath(expectedExecutable);
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="], {
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match && [expectedExecutable, canonicalExecutable].includes(match[2])) {
      const identity = await readProcessIdentity(inspector, Number(match[1]));
      if (identity?.executable === canonicalExecutable) return identity;
    }
  }
  return undefined;
}
