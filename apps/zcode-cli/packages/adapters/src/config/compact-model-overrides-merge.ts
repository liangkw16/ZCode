// Compact modelOverrides 三层合并 helper —— 供启动合并与 ConfigStore 增量 merge 共用。

import type { CompactRuntimeConfig } from "@zcode/contracts";

type CompactModelOverrides = NonNullable<CompactRuntimeConfig["modelOverrides"]>;

/**
 * modelOverrides 是 provider→model→字段 三层结构：浅覆盖会让高优先层只改一个模型的
 * 一个字段时丢掉低层其他条目，与 microcompact 子对象是同一种坑，必须逐层合并；
 * 两条合并入口（启动 mergeConfigs 与 ConfigStore 增量 merge）必须共用本 helper，
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
