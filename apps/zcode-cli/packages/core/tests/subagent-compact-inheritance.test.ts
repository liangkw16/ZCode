import { describe, expect, it } from "vitest";
import {
  applyCompactModelOverrides,
  getAutoCompactThreshold,
} from "../src/compact/index.js";
import {
  buildChildCompactConfig,
  type ChildCompactConfigParent,
} from "../src/runtime/methods/subagent.js";

describe("buildChildCompactConfig", () => {
  const parentCompact: ChildCompactConfigParent = {
    thresholdRatio: 0.76,
    modelOverrides: {
      test: { "child-model": { contextWindowTokens: 100_000 } },
    },
  };

  it("child 只继承未解析的 modelOverrides 覆盖表，不继承全局阈值字段", () => {
    expect(buildChildCompactConfig(parentCompact)).toEqual({
      modelOverrides: {
        test: { "child-model": { contextWindowTokens: 100_000 } },
      },
    });
  });

  it("父 compact 无 modelOverrides 时 child compact 保持不存在", () => {
    // 全局阈值字段不得经子代理接线泄漏，维持"不配置 modelOverrides 行为不变"。
    expect(buildChildCompactConfig({ thresholdRatio: 0.76, bufferTokens: 9_000 })).toBeUndefined();
    expect(buildChildCompactConfig(undefined)).toBeUndefined();
  });

  it("child 用自己的模型身份解析继承的覆盖表（128K child → 66K）", () => {
    const childConfig = buildChildCompactConfig(parentCompact);
    const { config, source } = applyCompactModelOverrides(
      {
        contextWindow: 128_000,
        maxOutputTokens: 64_000,
        ...childConfig,
      },
      { providerId: "test", modelId: "child-model" },
    );

    expect(source).toBe("model-override");
    // 100K − 21K − 13K = 66K：child 以自身身份命中覆盖，父模型不受影响。
    expect(getAutoCompactThreshold(config)).toBe(66_000);
  });
});
