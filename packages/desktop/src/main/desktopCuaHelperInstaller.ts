import { join } from "node:path";
import { app } from "electron";
import { ZCODE_PRODUCT_FLAVOR, ZCODE_RUNTIME_ENV_KEY } from "@zcode/shared";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  canonicalizeCuaHelperInstallerOptions,
  createCuaHelperInstaller,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@zcode/services/node";

type InstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

export { normalizeCuaHelperArch, normalizeCuaHelperArchs } from "@zcode/services/node";

export interface DesktopCuaHelperInstallerOptions extends Pick<
  CuaHelperInstallerOptions,
  "env" | "logger"
> {
  bundledHelperAppPath?: string;
  platform?: NodeJS.Platform | string;
  isPackaged?: boolean;
  resourcesPath?: string;
}

export function resolvePackagedCuaHelperAppPath(
  options: Pick<DesktopCuaHelperInstallerOptions, "platform" | "isPackaged" | "resourcesPath"> = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const isPackaged = options.isPackaged ?? app.isPackaged;
  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const normalizedResourcesPath = resourcesPath?.trim();
  return platform === "darwin" && isPackaged && normalizedResourcesPath
    ? join(normalizedResourcesPath, "cua-helper", HELPER_APP_NAME)
    : undefined;
}

export function createDesktopCuaHelperInstaller(
  options: DesktopCuaHelperInstallerOptions,
  createInstaller: InstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  const bundledAppPath = options.bundledHelperAppPath ?? resolvePackagedCuaHelperAppPath(options);
  const env = { ...options.env };
  // The unsigned-local escape hatch belongs only to unpackaged development.
  // A signed app with a bundled Helper must be deterministic even when its
  // LaunchServices environment was polluted by an earlier dev session.
  if (bundledAppPath) {
    delete env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL;
    if (options.isPackaged ?? app.isPackaged) {
      // Main 未经过 Host 的环境装配，会误选 dev/0.0.0；随包引导必须固定为同一产品身份。
      env[ZCODE_RUNTIME_ENV_KEY] = "production";
      if (ZCODE_PRODUCT_FLAVOR === "preview" || ZCODE_PRODUCT_FLAVOR === "kcode") {
        env.ZCODE_CUA_HELPER_INSTALL_VARIANT = ZCODE_PRODUCT_FLAVOR;
      } else {
        delete env.ZCODE_CUA_HELPER_INSTALL_VARIANT;
      }
    }
  }
  return createInstaller(
    canonicalizeCuaHelperInstallerOptions({
      env,
      logger: options.logger,
      bundledAppPath,
    }),
  );
}
