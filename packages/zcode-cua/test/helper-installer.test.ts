import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  readdir,
  realpath,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createCuaHelperInstaller, executablePath } from "../src/adapters/helper-installer.js";
const exec = promisify(execFile);
const app = resolve(import.meta.dirname, "../dist/native/darwin-arm64/KCode Computer Use.app");
const manifestPath = (bundle: string) =>
  join(bundle, "Contents/Resources/source-manifest.json");
const installerTest = it.skipIf(process.platform !== "darwin");
// 构建产物是 ad-hoc 签名的开发版，用例一律显式放行本地未签名来源。
const localEnv = (installRoot: string) => ({
  ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
  ZCODE_CUA_HELPER_INSTALL_ROOT: installRoot,
});
const installerFor = (installRoot: string, dependencies?: object) =>
  createCuaHelperInstaller({ env: localEnv(installRoot), bundledAppPath: app, dependencies });
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
installerTest(
  "replaces an installation whose sealed resources no longer match its signature",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-broken-"));
    const installRoot = join(dir, "Applications");
    const destination = join(installRoot, "KCode Computer Use.app");
    const rollback = join(installRoot, ".kcode-cua-rollback", "KCode Computer Use.app");
    const plist = (bundle: string) => join(bundle, "Contents/Info.plist");
    try {
      await installerFor(installRoot).ensureInstalled();
      // 清单原样保留，只改坏一个被封印的资源：这次校验失败来自 codesign 的退出码，不是清单结论。
      await writeFile(plist(destination), `${await readFile(plist(destination), "utf8")}\n`);
      await expect(installerFor(installRoot).ensureInstalled()).resolves.toBe(destination);
      expect(await readFile(plist(rollback), "utf8")).not.toBe(
        await readFile(plist(app), "utf8"),
      );
      expect(await readFile(plist(destination), "utf8")).toBe(await readFile(plist(app), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
installerTest(
  "replaces an earlier installation that has no source manifest and keeps it as the rollback copy",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-legacy-"));
    const installRoot = join(dir, "Applications");
    const destination = join(installRoot, "KCode Computer Use.app");
    const rollback = join(installRoot, ".kcode-cua-rollback", "KCode Computer Use.app");
    try {
      await installerFor(installRoot).ensureInstalled();
      // 清单是随新版安装器一起引入的：更早的已安装 Helper 没有这个文件。
      await rm(manifestPath(destination));
      await expect(installerFor(installRoot).ensureInstalled()).resolves.toBe(destination);
      expect(JSON.parse(await readFile(manifestPath(destination), "utf8"))).toMatchObject({
        producer: "kcode-cua-source",
        protocol: 3,
      });
      await expect(readFile(manifestPath(rollback))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
installerTest(
  "serializes concurrent installers on one target and keeps the replaced bundle for rollback",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-concurrent-"));
    const installRoot = join(dir, "Applications");
    const destination = join(installRoot, "KCode Computer Use.app");
    const rollback = join(installRoot, ".kcode-cua-rollback", "KCode Computer Use.app");
    // 放慢校验，让多个实例必然在校验与换入之间交错；桌面主进程与首个 Agent 运行时在升级后
    // 就是同时走到这里。
    const slow = {
      readExecutableArchs: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [process.arch];
      },
    };
    try {
      await installerFor(installRoot).ensureInstalled();
      await writeFile(
        manifestPath(destination),
        JSON.stringify({ producer: "something-else", protocol: 3 }),
      );
      const results = await Promise.all(
        Array.from({ length: 3 }, () => installerFor(installRoot, slow).ensureInstalled()),
      );
      expect(results).toEqual([destination, destination, destination]);
      expect(JSON.parse(await readFile(manifestPath(destination), "utf8"))).toMatchObject({
        producer: "kcode-cua-source",
        protocol: 3,
      });
      expect(
        JSON.parse(await readFile(manifestPath(rollback), "utf8")),
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
installerTest(
  "never asks to retire a Helper that runs from another installation through a symlinked executable",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-symlink-"));
    const installRoot = join(dir, "Applications");
    const destination = join(installRoot, "KCode Computer Use.app");
    // ps 的 comm 记录启动路径而不展开 /var → /private/var，另一份放在真实路径下才能与内核身份对上。
    const other = join(await realpath(dir), "other", "KCode Computer Use.app");
    // 另一份安装的 Helper 正在运行：持有自己的生命周期锁直到 stdin 关闭。
    const guardDir = await mkdtemp(join(dir, "guard-"));
    await cp(app, other, { recursive: true });
    const resident = spawn(executablePath(other), ["--lifecycle-guard", guardDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        resident.stdout.once("data", (chunk: Buffer) =>
          chunk.toString() === "locked\n" ? resolve() : reject(new Error("guard not locked")),
        );
        resident.once("exit", () => reject(new Error("guard exited early")));
      });
      // 稳定路径上是真实目录，可执行文件却指向那一份的二进制；清单改写成需要替换的旧构建。
      await mkdir(installRoot, { recursive: true });
      await cp(app, destination, { recursive: true });
      await rm(executablePath(destination));
      await symlink(executablePath(other), executablePath(destination));
      await writeFile(
        manifestPath(destination),
        JSON.stringify({ producer: "something-else", protocol: 3 }),
      );
      // upgrade_required 会让 Host 终止该进程；这里必须是需要人工处理的 not_authorized。
      await expect(installerFor(installRoot).ensureInstalled()).rejects.toMatchObject({
        code: "not_authorized",
      });
      expect(resident.exitCode).toBeNull();
      expect(() => process.kill(resident.pid!, 0)).not.toThrow();
    } finally {
      resident.stdin.end();
      if (resident.exitCode === null) resident.kill("SIGKILL");
      await new Promise((resolve) => resident.once("close", resolve));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
