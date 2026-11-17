import { it, expect } from "vitest";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCuaHelperInstaller } from "../src/adapters/helper-installer.js";
const exec = promisify(execFile);
const app = resolve(import.meta.dirname, "../dist/native/darwin-arm64/KCode Computer Use.app");
it.skipIf(process.platform !== "darwin")(
  "requires actual signing identity even when a re-signed ad-hoc manifest claims production",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-signature-"));
    const copy = join(dir, "KCode Computer Use.app");
    try {
      await cp(app, copy, { recursive: true });
      const path = join(copy, "Contents/Resources/source-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.signing = "local-identity";
      await writeFile(path, JSON.stringify(manifest));
      await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", copy]);
      await expect(
        createCuaHelperInstaller({ env: {} }).verifyInstalled(copy),
      ).rejects.toMatchObject({ code: "not_authorized" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform !== "darwin")(
  "allows an explicitly opted-in local development source artifact",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-development-"));
    const copy = join(dir, "KCode Computer Use.app");
    try {
      await cp(app, copy, { recursive: true });
      const path = join(copy, "Contents/Resources/source-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.signing = "development-adhoc";
      await writeFile(path, JSON.stringify(manifest));
      // 发布构建可能已经正式签名；开发用例仅重签自己的副本，不能放宽生产验签或改发布产物。
      await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", copy]);
      await expect(
        createCuaHelperInstaller({
          env: { ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1" },
        }).verifyInstalled(copy),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
