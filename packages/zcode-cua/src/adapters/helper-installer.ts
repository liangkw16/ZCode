import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CuaHelperInstaller, CuaHelperInstallerOptions } from "../../broker-server.js";
import { NativeBrokerError } from "./broker-client.js";
import { withLifecycleGuard } from "./lifecycle-guard.js";
import { HELPER_NAME, HELPER_ID, executablePath } from "./helper-paths.js";
import { certificateFingerprint, productMainCertificate } from "./signing.js";
import { findLiveHelper } from "./process-identity.js";
export { HELPER_NAME, HELPER_ID, executablePath } from "./helper-paths.js";
const exec = promisify(execFile);
export async function helperManifest(app: string): Promise<{
  producer: string;
  protocol: number;
  buildId: string;
  arch: string;
  bundleId: string;
  signing: string;
}> {
  return JSON.parse(await readFile(join(app, "Contents/Resources/source-manifest.json"), "utf8"));
}
export const defaultCuaHelperVerifierDependencies = {
  async readExecutableArchs(path: string) {
    const { stdout } = await exec("/usr/bin/lipo", ["-archs", path]);
    return stdout
      .trim()
      .split(/\s+/)
      .map((a) => (a === "x86_64" ? "x64" : a));
  },
  async verifyCodeSignature(path: string) {
    await exec("/usr/bin/codesign", ["--verify", "--strict", path]);
  },
};
const isErrno = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException).code === code;
const existsOnDisk = async (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (!isErrno(error, "ENOENT")) throw error;
      return false;
    },
  );
export function createCuaHelperInstaller(
  options: CuaHelperInstallerOptions = {},
): CuaHelperInstaller {
  const env = options.env ?? process.env;
  const installRoot = env.ZCODE_CUA_HELPER_INSTALL_ROOT || join(homedir(), "Applications");
  const destination = join(installRoot, HELPER_NAME);
  // 回滚副本与安装锁同住一个目录。锁文件在换入期间必须一直在，所以只替换副本本身，不删目录。
  const rollbackRoot = join(installRoot, ".kcode-cua-rollback");
  const backup = join(rollbackRoot, HELPER_NAME);
  let installing: Promise<string> | undefined;
  let mainCertificate: Promise<string | undefined> | undefined;
  const inspect = async (app: string) => {
    const info = await lstat(app);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new NativeBrokerError("not_authorized", "Helper must be a real application directory");
    const manifest = await helperManifest(app);
    if (
      manifest.producer !== "kcode-cua-source" ||
      manifest.protocol !== 3 ||
      manifest.bundleId !== HELPER_ID
    )
      throw new NativeBrokerError(
        "version_mismatch",
        "Helper is not a compatible source-built KCode producer",
      );
    try {
      await defaultCuaHelperVerifierDependencies.verifyCodeSignature(app);
    } catch (error) {
      // codesign 用非零退出码表达“签名不成立”，这是校验结论，同样说明这份安装需要被替换；
      // codesign 自身缺失之类的 IO 错误照旧上抛。
      if (typeof (error as { code?: unknown }).code === "number")
        throw new NativeBrokerError("not_authorized", "Helper code signature does not verify");
      throw error;
    }
    mainCertificate ??= productMainCertificate();
    const [mainSigner, helperSigner] = await Promise.all([
      mainCertificate,
      certificateFingerprint(app),
    ]);
    // manifest 的 signing 字段只是构建记录；实际签名必须匹配正在运行的 KCode 主应用。
    if (
      mainSigner
        ? helperSigner !== mainSigner
        : !(env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL === "1" && helperSigner === undefined)
    )
      throw new NativeBrokerError(
        "not_authorized",
        "Helper signer does not match the verified KCode application",
      );
    const readArchs =
      options.dependencies?.readExecutableArchs ??
      defaultCuaHelperVerifierDependencies.readExecutableArchs;
    const archs = await readArchs(executablePath(app));
    if (!archs.includes(process.arch))
      throw new NativeBrokerError(
        "architecture_mismatch",
        "Helper architecture does not match this runtime",
      );
    if (
      manifest.signing === "development-adhoc" &&
      env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL !== "1"
    )
      throw new NativeBrokerError(
        "not_authorized",
        "Unsigned development Helper cannot be installed in production",
      );
    const { stdout: bundle } = await exec("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      join(app, "Contents/Info.plist"),
    ]);
    if (bundle.trim() !== HELPER_ID)
      throw new NativeBrokerError("not_authorized", "Helper bundle identity mismatch");
    return manifest;
  };
  const verifyInstalled = async (app: string) => {
    await inspect(app);
  };
  // 稳定路径上已安装的一份能否原样复用。校验不通过、旧安装被改坏、或者更早的安装根本没有清单，
  // 都说明它需要被替换；其余 IO 错误照旧上抛。
  const installedBuildId = async () => {
    try {
      return (await inspect(destination)).buildId;
    } catch (error) {
      if (!(error instanceof NativeBrokerError) && !isErrno(error, "ENOENT")) throw error;
      return undefined;
    }
  };
  // 原生 guard 只接受当前用户私有的真实目录作为锁目录。
  const ensurePrivateDirectory = async (path: string) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw new NativeBrokerError(
        "not_authorized",
        "CUA install state directory must be a private user directory",
      );
    if (info.mode & 0o077) await chmod(path, 0o700);
  };
  // 稳定路径上已有安装时，运行中的旧 Helper 必须先退出，否则换包后它加载到的资源会是新版本的。
  // 只有包目录和包内可执行文件都是真实文件时，按真实路径找到的进程才归属于这份安装。经符号链接
  // 指向别处的二进制无法与另一份安装区分，而 upgrade_required 会让 Host 终止该进程，所以只报错。
  const requireReplaceable = async (source: string) => {
    const installedExecutable = await realpath(executablePath(destination)).catch(
      (error: NodeJS.ErrnoException) => {
        // 安装损坏到没有可执行文件时，不可能有进程从它启动。
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    if (!installedExecutable) return;
    const live = await findLiveHelper(executablePath(source), executablePath(destination));
    if (!live) return;
    const [bundle, file] = await Promise.all([
      lstat(destination),
      lstat(executablePath(destination)),
    ]);
    if (
      bundle.isSymbolicLink() ||
      file.isSymbolicLink() ||
      installedExecutable !== executablePath(await realpath(destination))
    )
      throw new NativeBrokerError(
        "not_authorized",
        "Installed Helper is a symbolic link to another installation; remove it before upgrading",
      );
    throw new NativeBrokerError(
      "upgrade_required",
      "Running source Helper must exit before replacing its bundle",
      { ...live },
    );
  };
  async function install() {
    const source = options.bundledAppPath;
    if (!source) {
      await verifyInstalled(destination);
      return destination;
    }
    await verifyInstalled(source);
    if (resolve(source) === resolve(destination)) return destination;
    const sourceBuildId = (await helperManifest(source)).buildId;
    // 已安装的一份与随包构建一致时直接复用：不写盘，也不取锁。
    if ((await installedBuildId()) === sourceBuildId) return destination;
    await mkdir(installRoot, { recursive: true });
    await ensurePrivateDirectory(rollbackRoot);
    // 修复原因：首次安装与替换此前没有跨进程互斥，只有单个实例内的去重。升级后桌面主进程与首个
    // Agent 运行时会同时安装：后者删掉前者的回滚副本，前者换入失败后回滚又把后者的新包删掉。
    // 现在整段在按安装目标的锁内完成，锁由内核持有，持锁进程崩溃即释放。
    return withLifecycleGuard(source, rollbackRoot, async () => {
      // 等锁期间可能已被别的实例装好，持锁后复核。
      if ((await installedBuildId()) === sourceBuildId) return destination;
      const exists = await existsOnDisk(destination);
      if (exists) await requireReplaceable(source);
      const stagingRoot = await mkdtemp(join(installRoot, ".kcode-cua-install-"));
      const staging = join(stagingRoot, HELPER_NAME);
      // 可回滚副本放在暂存目录之外：设计要求“发现同路径已有安装则保存可回滚副本”，固定保留
      // 最近一次被替换的安装；新安装失败时由它恢复。
      let moved = false;
      try {
        await cp(source, staging, {
          recursive: true,
          preserveTimestamps: true,
          dereference: false,
        });
        await verifyInstalled(staging);
        if (exists) {
          await rm(backup, { recursive: true, force: true });
          await rename(destination, backup);
          moved = true;
        }
        try {
          await rename(staging, destination);
          await verifyInstalled(destination);
        } catch (error) {
          if (moved) {
            await rm(destination, { recursive: true, force: true });
            await rename(backup, destination);
          }
          throw error;
        }
        return destination;
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    });
  }
  return {
    verifyInstalled,
    ensureInstalled() {
      if (!installing) {
        installing = install().finally(() => {
          installing = undefined;
        });
      }
      return installing;
    },
  };
}
