import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@zcode/adapters/config";
import type { ConfigResult } from "@zcode/adapters/config";
import { resolveFileLoggerMinLevel } from "@zcode/adapters/logging";
import { LogLevel } from "@zcode/contracts";
import { resolveConfiguredLoggingLevel } from "../src/app/app-config-options.js";

const development = { ZCODE_RUNTIME_ENV: "development" };

async function withConfigFiles(
  files: Record<string, string>,
  run: (dir: string, pathOf: (name: string) => string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-log-level-"));
  try {
    for (const [name, contents] of Object.entries(files))
      await writeFile(join(dir, name), contents);
    await run(dir, (name) => join(dir, name));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fileLevelIn = (result: ConfigResult) =>
  resolveFileLoggerMinLevel({
    configLevel: resolveConfiguredLoggingLevel(result),
    env: development,
  });

/**
 * 走真实的 createConfig 入口：合并后的 logging.level 总有值（系统默认补出 "info"）。
 * 修复原因：此前把这个默认值当成显式配置，开发态默认文件日志丢失 debug 事件。
 */
describe("file logger level from config", () => {
  it("keeps the development default when no config file declares logging.level", async () => {
    await withConfigFiles({ "config.json": "{}" }, async (dir, pathOf) => {
      const result = createConfig({ env: {}, userConfigPath: pathOf("config.json"), workingDirectory: dir });
      expect(result.config.logging.level).toBe("info");
      expect(resolveConfiguredLoggingLevel(result)).toBeUndefined();
      expect(fileLevelIn(result)).toBe(LogLevel.Debug);
    });
  });

  it("lets a user config file override the environment default", async () => {
    await withConfigFiles(
      { "config.json": '{"logging":{"level":"warn"}}' },
      async (dir, pathOf) => {
        const result = createConfig({
          env: {},
          userConfigPath: pathOf("config.json"),
          workingDirectory: dir,
        });
        expect(fileLevelIn(result)).toBe(LogLevel.Warn);
      },
    );
  });

  it("ignores logging.level in a project config file because project files cannot declare it", async () => {
    await withConfigFiles(
      { "project.json": '{"logging":{"level":"error"}}' },
      async (dir, pathOf) => {
        const result = createConfig({
          env: {},
          projectConfigPath: pathOf("project.json"),
          skipUserConfig: true,
          workingDirectory: dir,
        });
        // 项目配置只开放扩展声明：写了也不生效，不算显式配置，开发态仍是默认的 Debug。
        expect(result.config.logging.level).toBe("info");
        expect(resolveConfiguredLoggingLevel(result)).toBeUndefined();
        expect(fileLevelIn(result)).toBe(LogLevel.Debug);
      },
    );
  });

  it("lets a user config file enable debug output in production", async () => {
    await withConfigFiles(
      { "config.json": '{"logging":{"level":"debug"}}' },
      async (dir, pathOf) => {
        const result = createConfig({
          env: {},
          userConfigPath: pathOf("config.json"),
          workingDirectory: dir,
        });
        expect(
          resolveFileLoggerMinLevel({
            configLevel: resolveConfiguredLoggingLevel(result),
            env: {},
          }),
        ).toBe(LogLevel.Debug);
      },
    );
  });
});
