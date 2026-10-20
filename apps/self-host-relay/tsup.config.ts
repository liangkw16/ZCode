import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  target: "node22",
  outDir: "dist",
  clean: true,
  platform: "node",
  // 单文件部署：tsup 默认外置 dependencies（ws）与 workspace 包，ECS 上会缺模块无法启动。
  noExternal: [/.+/],
});
