import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
await run(process.execPath, [
  fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
  "-p",
  "tsconfig.build.json",
]);
if (process.platform === "darwin" && !process.argv.includes("--typescript-only")) {
  await run(process.execPath, ["scripts/build-native.mjs", ...process.argv.slice(2)]);
}
