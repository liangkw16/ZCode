import { join } from "node:path";
// Helper 的稳定命名与可执行文件位置。安装器和生命周期锁都要用，放在叶子模块里避免二者互相引用。
export const HELPER_NAME = "KCode Computer Use.app";
export const HELPER_ID = "dev.zcode.cua-helper.kcode";
export const executablePath = (app: string) => join(app, "Contents/MacOS/KCode Computer Use");
