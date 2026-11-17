import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CuaHelperInstaller, CuaHelperInstallerOptions } from "../../broker-server.js";
import { NativeBrokerError } from "./broker-client.js";
const exec = promisify(execFile);
export const HELPER_NAME = "KCode Computer Use.app";
export const HELPER_ID = "dev.zcode.cua-helper.kcode";
export const executablePath = (app: string) => join(app, "Contents/MacOS/KCode Computer Use");
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
export function createCuaHelperInstaller(
  options: CuaHelperInstallerOptions = {},
): CuaHelperInstaller {
  const env = options.env ?? process.env;
  const installRoot = env.ZCODE_CUA_HELPER_INSTALL_ROOT || join(homedir(), "Applications");
  const destination = join(installRoot, HELPER_NAME);
  let installing: Promise<string> | undefined;
  const verifyInstalled = async (app: string) => {
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
    await defaultCuaHelperVerifierDependencies.verifyCodeSignature(app);
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
  };
  async function install() {
    const source = options.bundledAppPath;
    if (!source) {
      await verifyInstalled(destination);
      return destination;
    }
    await verifyInstalled(source);
    if (resolve(source) === resolve(destination)) return destination;
    try {
      await verifyInstalled(destination);
      if ((await helperManifest(source)).buildId === (await helperManifest(destination)).buildId)
        return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        /* Existing invalid installation is replaced only after source verification. */
      }
    }
    await mkdir(installRoot, { recursive: true });
    const stagingRoot = await mkdtemp(join(installRoot, ".kcode-cua-install-"));
    const staging = join(stagingRoot, HELPER_NAME);
    const backup = join(stagingRoot, "previous.app");
    let moved = false;
    try {
      await cp(source, staging, { recursive: true, preserveTimestamps: true, dereference: false });
      await verifyInstalled(staging);
      try {
        await access(destination);
        await rename(destination, backup);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
