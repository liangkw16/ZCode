import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const app = resolve(root, "dist/fixtures/KCode CUA Fixture.app");
await mkdir(resolve(app, "Contents/MacOS"), { recursive: true });
await exec("xcrun", [
  "clang++",
  "-fobjc-arc",
  "-std=c++17",
  "-fblocks",
  resolve(root, "test/native-fixture.mm"),
  "-framework",
  "Cocoa",
  "-o",
  resolve(app, "Contents/MacOS/KCode CUA Fixture"),
]);
await writeFile(
  resolve(app, "Contents/Info.plist"),
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.kcode.cua.fixture</string><key>CFBundleName</key><string>KCode CUA Fixture</string><key>CFBundleExecutable</key><string>KCode CUA Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>`,
);
await exec("codesign", ["--force", "--sign", "-", app]);
console.log(JSON.stringify({ app, oracle: "http://127.0.0.1:19437/" }));
