import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const arch = option("--arch", process.arch);
if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
if (process.platform !== "darwin") throw new Error("Native macOS build requires macOS and xcrun");
const run = (cmd, args) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveResult(output.trim())
        : reject(new Error(`${cmd} exited ${code}\n${output}`)),
    );
  });
const sourceDir = resolve(root, "native/macos");
const sources = (await readdir(sourceDir)).filter((n) => n.endsWith(".mm")).sort();
if (!sources.length) throw new Error("No native source files");
const { BROKER_METHODS } = await import("../src/contract/manifest.ts");
const sourceHashes = {
  "src/contract/manifest.ts": createHash("sha256")
    .update(await readFile(resolve(root, "src/contract/manifest.ts")))
    .digest("hex"),
};
for (const name of (await readdir(sourceDir)).sort()) {
  if (!/\.(mm|h|cc)$/.test(name)) continue;
  sourceHashes[`native/macos/${name}`] = createHash("sha256")
    .update(await readFile(resolve(sourceDir, name)))
    .digest("hex");
}
const buildId = createHash("sha256")
  .update(JSON.stringify(sourceHashes))
  .digest("hex")
  .slice(0, 20);
const outputRoot = resolve(root, option("--out", `dist/native/darwin-${arch}`));
const app = resolve(outputRoot, "KCode Computer Use.app");
const executable = resolve(app, "Contents/MacOS/KCode Computer Use");
await mkdir(resolve(app, "Contents/MacOS"), { recursive: true });
await mkdir(resolve(app, "Contents/Resources"), { recursive: true });
const frameworks = [
  "Cocoa",
  "ApplicationServices",
  "ScreenCaptureKit",
  "CoreMedia",
  "CoreVideo",
  "Security",
  "Carbon",
  "IOKit",
];
const compilerOutput = await run("xcrun", [
  "clang++",
  "-std=c++17",
  "-fobjc-arc",
  "-fblocks",
  "-O2",
  "-g",
  "-arch",
  arch === "x64" ? "x86_64" : "arm64",
  "-mmacosx-version-min=13.0",
  "-Wall",
  "-Wextra",
  "-Werror=return-type",
  `-DKCODE_BUILD_ID="${buildId}"`,
  `-DKCODE_BROKER_METHODS=${BROKER_METHODS.map((method) => `@"${method}"`).join(",")}`,
  ...sources.map((n) => resolve(sourceDir, n)),
  ...frameworks.flatMap((f) => ["-framework", f]),
  "-o",
  executable,
]);
if (compilerOutput) process.stderr.write(compilerOutput + "\n");
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.zcode.cua-helper.kcode</string>
<key>CFBundleName</key><string>KCode Computer Use</string>
<key>CFBundleDisplayName</key><string>KCode Computer Use</string>
<key>CFBundleExecutable</key><string>KCode Computer Use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>${buildId}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>KCode 需要录制目标应用窗口以完成你授权的电脑操作。</string>
</dict></plist>`;
await writeFile(resolve(app, "Contents/Info.plist"), plist);
const identity = option("--identity", process.env.KCODE_CUA_SIGN_IDENTITY || "-");
const manifest = {
  schema: 1,
  protocol: 3,
  producer: "kcode-cua-source",
  buildId,
  arch,
  minimumOS: "13.0",
  bundleId: "dev.zcode.cua-helper.kcode",
  sourceHashes,
  compiler: await run("xcrun", ["clang++", "--version"]),
  sdk: await run("xcrun", ["--show-sdk-version"]),
  unsignedExecutableSha256: createHash("sha256")
    .update(await readFile(executable))
    .digest("hex"),
  signing: identity === "-" ? "development-adhoc" : "local-identity",
};
await writeFile(
  resolve(app, "Contents/Resources/source-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await run("codesign", ["--force", "--options", "runtime", "--sign", identity, app]);
await run("codesign", ["--verify", "--strict", app]);
await writeFile(
  resolve(outputRoot, "build-manifest.json"),
  JSON.stringify(
    {
      ...manifest,
      artifact: relative(root, app),
      executableSha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    },
    null,
    2,
  ),
);
process.stdout.write(`${JSON.stringify({ app, buildId, arch, protocol: 3 })}\n`);
