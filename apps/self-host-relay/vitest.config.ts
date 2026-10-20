import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 架构治理要求 managed 模块的 contract.test.ts 放模块目录内（与根 vitest 约定一致）。
    include: ["test/**/*.test.ts", "src/**/contract.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
