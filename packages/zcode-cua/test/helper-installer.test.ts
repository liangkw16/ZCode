import { it, expect } from "vitest";
import { mkdtemp, cp, readFile, readdir, writeFile, rm } from "node:fs/promises";
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
  "replaces an installed Helper that no longer verifies and keeps it as the rollback copy",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-replace-"));
    const installRoot = join(dir, "Applications");
    const destination = join(installRoot, "KCode Computer Use.app");
    const rollback = join(installRoot, ".kcode-cua-rollback", "KCode Computer Use.app");
    // 构建产物是 ad-hoc 签名的开发版，沿用上一条用例的显式放行。
    const env = {
      ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
      ZCODE_CUA_HELPER_INSTALL_ROOT: installRoot,
    };
    try {
      const installed = await createCuaHelperInstaller({ env, bundledAppPath: app }).ensureInstalled();
      expect(installed).toBe(destination);
      // 模拟被别处覆盖过的安装：清单被改写，校验必然失败。
      const manifest = join(destination, "Contents/Resources/source-manifest.json");
      await writeFile(manifest, JSON.stringify({ producer: "something-else", protocol: 3 }));
      const replaced = await createCuaHelperInstaller({ env, bundledAppPath: app }).ensureInstalled();
      expect(replaced).toBe(destination);
      expect(
        JSON.parse(await readFile(manifest, "utf8")),
      ).toMatchObject({ producer: "kcode-cua-source", protocol: 3 });
      // 被替换的那份保留为可回滚副本，暂存目录不残留。
      expect(
        JSON.parse(
          await readFile(join(rollback, "Contents/Resources/source-manifest.json"), "utf8"),
        ),
      ).toMatchObject({ producer: "something-else" });
      expect((await readdir(installRoot)).sort()).toEqual([
        ".kcode-cua-rollback",
        "KCode Computer Use.app",
      ]);
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
