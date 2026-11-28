import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

// ScreenCaptureKit stream 的源码实现与 Helper plist 一致，最低 macOS13。
// 低版本必须在授权引导前拒绝，不能表现为 Helper 一直无响应。
export const CUA_MINIMUM_MACOS_VERSION = "13.0";
const CUA_MINIMUM_DARWIN_MAJOR = 22;

export function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
