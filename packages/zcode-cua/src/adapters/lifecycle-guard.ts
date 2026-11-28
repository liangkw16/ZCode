import { spawn } from "node:child_process";
import { executablePath } from "./helper-paths.js";
import { NativeBrokerError } from "./broker-client.js";
export async function withLifecycleGuard<T>(
  app: string,
  runtimeDir: string,
  work: () => Promise<T>,
): Promise<T> {
  const child = spawn(executablePath(app), ["--lifecycle-guard", runtimeDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("exit", () =>
        reject(
          new NativeBrokerError(
            "lifecycle_unavailable",
            "Native lifecycle guard exited before acquisition",
          ),
        ),
      );
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output === "locked\n") {
          clearTimeout(timer);
          resolve();
        } else if (output.length > 64)
          reject(new NativeBrokerError("invalid_response", "Invalid lifecycle guard response"));
      });
      timer = setTimeout(
        () =>
          reject(
            new NativeBrokerError(
              "lifecycle_busy",
              "Another Host is changing the Helper lifecycle",
            ),
          ),
        10000,
      );
    });
    return await work();
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
  }
}
