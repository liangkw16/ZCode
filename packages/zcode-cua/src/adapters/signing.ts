import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
export async function certificateFingerprint(path: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "kcua-public-cert-"));
  const prefix = join(dir, "certificate");
  try {
    await exec("/usr/bin/codesign", ["-d", `--extract-certificates=${prefix}`, path], {
      timeout: 5000,
      maxBuffer: 8192,
    });
    try {
      return createHash("sha256")
        .update(await readFile(`${prefix}0`))
        .digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function productMainCertificate(): Promise<string | undefined> {
  for (let dir = dirname(process.execPath); dirname(dir) !== dir; dir = dirname(dir)) {
    if (!dir.endsWith(".app")) continue;
    const { stdout } = await exec(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", join(dir, "Contents/Info.plist")],
      { timeout: 3000 },
    );
    if (stdout.trim() !== "dev.zcode.app.kcode") continue;
    await exec("/usr/bin/codesign", ["--verify", "--strict", dir], { timeout: 10000 });
    return certificateFingerprint(dir);
  }
  return undefined;
}
