// Config Merger - Merge configs by priority

import type {
  CompactRuntimeConfig,
  HookEventName,
  HookMatcherConfig,
  PluginOptionValues,
  RuntimeConfigPatch,
} from "@zcode/contracts";
import { ConfigScope, ConfigScopePriority } from "@zcode/contracts";

type CompactModelOverrides = NonNullable<CompactRuntimeConfig["modelOverrides"]>;

/**
 * modelOverrides 是 provider→model→字段 三层结构：浅覆盖会让高优先层只改一个模型的
 * 一个字段时丢掉低层其他条目，与 microcompact 子对象是同一种坑，必须逐层合并；
 * 两条合并入口（本文件的 mergeConfigs 与 ConfigStore 增量 merge）必须共用本 helper，
 * 否则公开增量接口与启动路径产生不同语义。
 */
export function mergeCompactModelOverrides(
  previous: CompactModelOverrides | undefined,
  next: CompactModelOverrides | undefined,
): CompactModelOverrides | undefined {
  if (previous === undefined && next === undefined) return undefined;
  const merged: CompactModelOverrides = { ...(previous ?? {}) };
  for (const [providerId, models] of Object.entries(next ?? {})) {
    const mergedModels = { ...(merged[providerId] ?? {}) };
    for (const [modelId, override] of Object.entries(models)) {
      const mergedOverride = { ...(mergedModels[modelId] ?? {}) };
      // 显式 undefined 不覆盖低层已配置值（omitUndefined 语义）。
      for (const [field, value] of Object.entries(override) as Array<
        [keyof typeof override, number | undefined]
      >) {
        if (value !== undefined) mergedOverride[field] = value;
      }
      mergedModels[modelId] = mergedOverride;
    }
    merged[providerId] = mergedModels;
  }
  return merged;
}

type PluginOptions = Record<string, PluginOptionValues>;

/**
 * Config source with priority info
 */
interface PrioritizedConfig {
  config: RuntimeConfigPatch;
  scope: ConfigScope;
  priority: number;
}

/**
 * Merge multiple configs by scope priority
 * Lower priority = applied first, higher priority = applied last (overwrites)
 */
export function mergeConfigs(...configs: PrioritizedConfig[]): RuntimeConfigPatch {
  // Sort by priority (ascending)
  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  const result: RuntimeConfigPatch = {};

  for (const { config: inputConfig, scope } of sorted) {
    const config =
      scope === ConfigScope.Project && inputConfig.plugins
        ? (() => {
            // Marketplace 是 Host User inventory 的目录配置，不属于 Workspace 项目配置。
            // 保留 schema 兼容旧文件，但不能让项目层字段进入 merged RuntimeConfig/catalog。
            const projectPlugins = { ...inputConfig.plugins };
            delete projectPlugins.extraKnownMarketplaces;
            return { ...inputConfig, plugins: projectPlugins };
          })()
        : inputConfig;
    const previousHooks = result.hooks;
    const previousPlugins = result.plugins;
    const previousCompact = result.compact;
    Object.assign(result, config);

    // Deep merge nested objects
    if (config.modelStream) {
      result.modelStream = { ...result.modelStream, ...config.modelStream };
    }
    if (config.permission) {
      result.permission = { ...result.permission, ...config.permission };
    }
    if (config.storage) {
      result.storage = { ...result.storage, ...config.storage };
    }
    if (config.network) {
      result.network = { ...result.network, ...config.network };
    }
    if (config.features) {
      result.features = { ...result.features, ...config.features };
    }
    if (config.memory) {
      result.memory = { ...result.memory, ...config.memory };
    }
    if (config.mcp) {
      result.mcp = {
        ...result.mcp,
        ...config.mcp,
        servers: {
          ...result.mcp?.servers,
          ...config.mcp.servers,
        },
      };
    }
    if (config.plugins) {
      // Workspace Plugin 配置和 User Plugin 配置共用同一个 RuntimeConfig，不能让后一个
      // `plugins` 对象整体覆盖前一个来源；否则 Workspace 只声明一个插件时会丢掉 User
      // 的其它启用项和 options。enabledPlugins 按 pluginId、options 按 pluginId/option key
      // 合并，dirs 保留两层候选根目录，最终 resolver 再做去重和路径校验。
      result.plugins = {
        // Object.assign 已先把 result.plugins 指向当前高优先级层。若这里只展开
        // result.plugins，Workspace 仅写 options 时会把 User 层 dirs 整体丢掉，导致下一次
        // configure 连插件本身都无法发现。必须显式从 previousPlugins 开始构造。
        ...previousPlugins,
        ...config.plugins,
        ...(config.plugins.dirs
          ? {
              dirs: [...new Set([...(previousPlugins?.dirs ?? []), ...config.plugins.dirs])],
            }
          : {}),
        ...(config.plugins.enabledPlugins
          ? {
              enabledPlugins: {
                ...previousPlugins?.enabledPlugins,
                ...config.plugins.enabledPlugins,
              },
            }
          : {}),
        ...(config.plugins.extraKnownMarketplaces
          ? {
              extraKnownMarketplaces: {
                ...previousPlugins?.extraKnownMarketplaces,
                ...config.plugins.extraKnownMarketplaces,
              },
            }
          : {}),
        ...(config.plugins.options
          ? {
              options: mergePluginOptions(previousPlugins?.options, config.plugins.options),
            }
          : {}),
      };
    }
    if (config.skills) {
      result.skills = {
        ...result.skills,
        ...config.skills,
      };
    }
    if (config.skillOverrides) {
      result.skillOverrides = {
        ...result.skillOverrides,
        ...config.skillOverrides,
      };
    }
    if (config.commandOverrides) {
      result.commandOverrides = {
        ...result.commandOverrides,
        ...config.commandOverrides,
      };
    }
    if (config.logging) {
      result.logging = { ...result.logging, ...config.logging };
    }
    if (config.toolConcurrency) {
      result.toolConcurrency = { ...result.toolConcurrency, ...config.toolConcurrency };
    }
    if (config.modelAnomalyGuard) {
      result.modelAnomalyGuard = {
        ...result.modelAnomalyGuard,
        ...config.modelAnomalyGuard,
      };
    }
    if (config.hooks) {
      result.hooks = mergeHooksConfig(previousHooks, config.hooks);
    }
    if (config.compact) {
      const mergedModelOverrides = mergeCompactModelOverrides(
        previousCompact?.modelOverrides,
        config.compact.modelOverrides,
      );
      result.compact = {
        // Object.assign 已把 result.compact 指向当前高优先级层；必须从 previousCompact
        // 开始构造，否则低优先层只写 compact 顶层字段时会被整段覆盖丢失。
        ...previousCompact,
        ...config.compact,
        // microcompact 是独立子对象，浅覆盖会让 User 层只写 enabled 时丢掉 Project 层的阈值调优。
        ...((previousCompact?.microcompact || config.compact.microcompact)
          ? {
              microcompact: {
                ...previousCompact?.microcompact,
                ...config.compact.microcompact,
              },
            }
          : {}),
        // modelOverrides 与 microcompact 同理：provider→model→字段三层逐级合并，不做整表替换。
        ...(mergedModelOverrides !== undefined ? { modelOverrides: mergedModelOverrides } : {}),
      };
    }
    if (config.ui) {
      result.ui = { ...result.ui, ...config.ui };
    }
  }

  return result;
}

function mergePluginOptions(
  current: PluginOptions | undefined,
  next: PluginOptions,
): PluginOptions {
  const merged: PluginOptions = { ...(current ?? {}) };
  for (const [pluginId, options] of Object.entries(next)) {
    merged[pluginId] = {
      ...(merged[pluginId] ?? {}),
      ...options,
    };
  }
  return merged;
}

function mergeHooksConfig(
  current: RuntimeConfigPatch["hooks"],
  next: NonNullable<RuntimeConfigPatch["hooks"]>,
): NonNullable<RuntimeConfigPatch["hooks"]> {
  const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
    ...current?.events,
  };

  // project hooks 不能整体覆盖 user hooks，空的 project `enabled:false` 也不能
  // 关闭 user hooks。每个配置文件只控制自己的事件，因此仅在该来源启用时追加事件，
  // effective enabled 由任一已启用来源决定。
  if (next.enabled !== false) {
    for (const [eventName, matchers] of Object.entries(next.events ?? {}) as Array<
      [HookEventName, HookMatcherConfig[]]
    >) {
      if (!matchers) continue;
      events[eventName] = [...(events[eventName] ?? []), ...matchers];
    }
  }

  return {
    ...current,
    ...next,
    enabled: current?.enabled === true || next.enabled === true,
    events,
  };
}

/**
 * Get priority for a config scope
 */
export function getScopePriority(scope: ConfigScope): number {
  return ConfigScopePriority[scope];
}

/**
 * Create a prioritized config entry
 */
export function createPrioritizedConfig(
  config: RuntimeConfigPatch,
  scope: ConfigScope,
): PrioritizedConfig {
  return {
    config,
    scope,
    priority: getScopePriority(scope),
  };
}
