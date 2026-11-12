// Env Config Adapter - Parse the intentionally small ZCODE_* environment surface.

import type { RuntimeConfigPatch } from "@zcode/contracts";

interface EnvConfigOptions {
  prefix?: string;
}

const DEFAULT_PREFIX = "ZCODE_";

/**
 * Parse ZCODE_* environment variables into config
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): RuntimeConfigPatch {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const config: RuntimeConfigPatch = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;

    const configKey = key.slice(prefix.length);
    // Storage config
    if (configKey === "STORAGE_DIR") {
      if (!config.storage) config.storage = {};
      config.storage.dir = value;
    } else if (configKey === "SESSION_DB_PATH" || configKey === "SESSION_DB") {
      if (!config.storage) config.storage = {};
      config.storage.sessionDbPath = value;
    }

    // Network config
    else if (configKey === "HTTP_PROXY") {
      if (!config.network) config.network = {};
      config.network.httpProxy = value;
    } else if (configKey === "NO_PROXY") {
      if (!config.network) config.network = {};
      config.network.noProxy = value;
    } else if (configKey === "AGENT_CA_CERT") {
      if (!config.network) config.network = {};
      config.network.caCertFile = value;
    } else if (configKey === "HTTP_TIMEOUT" || configKey === "TIMEOUT") {
      if (!config.network) config.network = {};
      config.network.timeout = normalizeNumber(value);
    }

    // Logging config
    else if (configKey === "LOG_FORMAT") {
      if (!config.logging) config.logging = {};
      config.logging.format = normalizeLogFormat(value);
    }

    // Tool Concurrency config
    else if (configKey === "MAX_TOOL_CONCURRENCY") {
      if (!config.toolConcurrency) config.toolConcurrency = {};
      config.toolConcurrency.maxConcurrency = normalizeNumber(value);
    }

    // Compact config（上下文压缩策略）。数值解析失败时跳过而不是落 0：
    // 0 对 thresholdRatio 是非法值、对 token 字段会改变压缩行为。
    else if (configKey === "COMPACT_ENABLED") {
      const enabled = normalizeBoolean(value);
      if (enabled !== undefined) {
        if (!config.compact) config.compact = {};
        config.compact.enabled = enabled;
      }
    } else if (configKey === "COMPACT_CONTEXT_WINDOW_TOKENS") {
      const tokens = normalizePositiveInteger(value);
      if (tokens !== undefined) {
        if (!config.compact) config.compact = {};
        config.compact.contextWindowTokens = tokens;
      }
    } else if (configKey === "COMPACT_BUFFER_TOKENS") {
      const tokens = normalizePositiveInteger(value);
      if (tokens !== undefined) {
        if (!config.compact) config.compact = {};
        config.compact.bufferTokens = tokens;
      }
    } else if (configKey === "COMPACT_THRESHOLD_RATIO") {
      const ratio = Number(value);
      if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) {
        if (!config.compact) config.compact = {};
        config.compact.thresholdRatio = ratio;
      }
    } else if (configKey === "COMPACT_KEEP_RECENT_TOKENS") {
      const tokens = normalizePositiveInteger(value);
      if (tokens !== undefined) {
        if (!config.compact) config.compact = {};
        config.compact.keepRecentTokens = tokens;
      }
    } else if (configKey === "MICROCOMPACT_ENABLED") {
      const enabled = normalizeBoolean(value);
      if (enabled !== undefined) {
        if (!config.compact) config.compact = {};
        if (!config.compact.microcompact) config.compact.microcompact = {};
        config.compact.microcompact.enabled = enabled;
      }
    }
  }

  return config;
}

/**
 * Get tool concurrency config from environment
 */
export function getToolConcurrencyConfig(): { maxConcurrency: number } {
  return {
    maxConcurrency: normalizeNumber(process.env.ZCODE_MAX_TOOL_CONCURRENCY ?? "10"),
  };
}

// ============================================================
// Helpers
// ============================================================

function normalizeNumber(value: string): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function normalizeBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

function normalizePositiveInteger(value: string): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.floor(num);
}

function normalizeLogFormat(value: string): "text" | "json" {
  const format = value.toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  return "text";
}
