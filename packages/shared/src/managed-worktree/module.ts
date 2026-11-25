export const moduleDefinition = {
  id: "managed-worktree-shared",
  // 受管根目录随产品数据目录 segment（<dataBaseDir>/<segment>/worktrees），常量取自 shared 根。
  requires: ["shared"],
  provides: ["managed-worktree-layout", "workspace-hook-trust-identity"],
} as const;
