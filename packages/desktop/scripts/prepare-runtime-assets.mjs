#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { isRealComputerUseProducerInstalled } from "./computer-use-producer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// Windows Computer Use Helper 由真实 producer 提供；开源占位包没有 Helper runtime，跳过准备。
const shouldPrepareWindowsCuaHelper =
  target.os === "win32" &&
  isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot, platform: target.os });
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// 本机桌面包不再内置 glm 原生二进制（prepare:glm），改为内置 agent 的 JS bundle（prepare:agent-bundle），
// 运行时由 app 的 Electron Node runtime 执行。Source Server 资源由独立 stage:remote-assets 入口负责。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(target.os === "win32" ? ["prepare:windows-runtime-host"] : []),
  ...(shouldPrepareWindowsCuaHelper ? ["prepare:windows-cua-helper"] : []),
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

// 源码 producer 必须先构建 JS；macOS 再构建同一份原生 Helper，禁止消费恢复目录的产物。
if (isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot })) {
  runCommand(pnpmCommand, ["--filter", "@zcode/zcode-cua", "build", "--typescript-only"], {
    cwd: resolve(desktopRoot, "../.."),
    env: process.env,
  });
  if (target.os === "darwin")
    runCommand(
      process.execPath,
      [
        resolve(desktopRoot, "../zcode-cua/scripts/build-native.mjs"),
        "--arch",
        target.arch,
        ...(process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME
          ? ["--identity", process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME]
          : []),
      ],
      { cwd: desktopRoot, env: process.env },
    );
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
