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
  banner: {
    // ws 的可选依赖（bufferutil/utf-8-validate）在运行期 try/catch require；
    // ESM 产物没有 require，注入 createRequire 让其优雅回退到纯 JS 实现。
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
