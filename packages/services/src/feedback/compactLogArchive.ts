import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { CLI_MEMORY_DIAGNOSTIC_DIRECTORY, ZCODE_DATA_DIR_SEGMENT } from "@zcode/shared";
import { getAppConfigDir, getFeedbackLogArchiveDir } from "../paths.js";
import { createFeedbackDiagnosticArchive } from "./feedbackLogArchive.js";

interface ArchiveProgressEvent {
  processedBytes: number;
  totalBytes: number;
}

export async function prepareCompactLogArchive(options?: {
  full?: boolean;
  createFullArchive?: (
    sourceDir: string,
    options?: { onProgress?: (event: ArchiveProgressEvent) => void },
  ) => Promise<{ path: string; size: number }>;
  onProgress?: (event: ArchiveProgressEvent) => void;
}): Promise<{ path: string; size: number }> {
  const sourceDir = getAppConfigDir();
  if (options?.full && options.createFullArchive) {
    return options.createFullArchive(sourceDir, { onProgress: options.onProgress });
  }
  return createFeedbackDiagnosticArchive({
    sources: [
      {
        // 修复原因：目录原先硬编码 "~/.zcode"，kcode 构建下反馈包会带上 ZCode 的 memory 诊断。
        // archivePrefix 是压缩包内的布局约定（消费方按它定位），不随产品变化。
        directory: join(homedir(), ZCODE_DATA_DIR_SEGMENT, "cli", CLI_MEMORY_DIAGNOSTIC_DIRECTORY),
        archivePrefix: ".zcode/cli/memory-diagnostics",
        contentPolicy: "cli-memory",
        onlyCurrentDay: false,
      },
      { directory: join(sourceDir, "logs"), archivePrefix: "logs" },
    ],
    outputRootDir: getFeedbackLogArchiveDir(),
    ...(!options?.full ? { maxTotalBytes: 2 * 1024 * 1024 } : {}),
    onProgress: options?.onProgress,
  });
}

export async function cleanupLogArchive(path: string): Promise<void> {
  await rm(join(path, ".."), { recursive: true, force: true }).catch(() => {});
}
