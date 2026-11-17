# Computer Use source producer

当前 `packages/zcode-cua` 是从源码构建的 macOS producer，保留原有十二个公开导出路径、十四个模型工具和 IPC3 协议。构建输入只有仓库 TypeScript、Objective-C++、系统框架及已锁定的公共依赖；恢复目录、旧 Node SEA、私有 addon 和源码字符串补丁不再是运行或发布输入。

唯一能力判定为 `packages/desktop/scripts/computer-use-producer.mjs`：安装清单必须声明 `zcodeCuaProducer.kind=source`、`protocol=3` 和目标平台。当前 platforms 只有 darwin，因此不能由“不是占位包”推断 Windows runtime 存在。构建配置同步求值，只同步读取这一份小清单。

`prepare:runtime-assets` 先构建 producer JS，再以目标架构构建原生 Helper；之后才构建/暂存 Agent。electron-builder 从 `packages/zcode-cua/dist/native/darwin-<arch>/KCode Computer Use.app` 附带同一产物。原生 Helper 不依赖 Koffi 或 Sharp；其他插件的图像处理需求仍由其自身清单决定。

开发入口从当前检出构建相同产物，ad-hoc 开发许可必须显式启用且不能覆盖正式签名策略。Release 必须验证签名、架构、source manifest、build id 与实际 socket owner；不能把编译成功或设置页授权显示当作电脑控制验收通过。

Helper 身份为 `dev.zcode.cua-helper.kcode`，规范安装目录为 `~/Applications/KCode Computer Use.app`。权限由同一 bundle 负责：正常查询通过 LaunchServices 的短命进程采样 AX/录屏事实，失败显示 unknown/不可用；后台不提示授权、不截图。generation 与桌面 epoch 约束功能探针复用。主应用与 Helper 的最低 macOS 版本均为13。

默认连接地址为 `/tmp/zcode-cua-<uid>/kcode-broker.sock`（显式 env/参数仍有效）。物理控制 lease 仍在共同的私有 runtime 目录下，与其他存活 controller 互斥。取消等待原生清理回执后允许同会话继续，停止保持逻辑会话 latch，不重放可能已经派发的输入。

回归入口为 CUA 包独立 suite、工程构建测试、设置页候选 E2E；真实签名冷启动、取消/重连、锁屏恢复、TCC 变更、浏览器和真实模型操作必须在 M2 已安装 Release 上完成。

详细合同与验收：[源码替换设计](../superpowers/specs/2026-11-17-kcode-cua-macos-replacement-design.md)。历史恢复和 REA 结果只作为调研证据，见 [CUA research](../cua/research/2026-11-17-codex-computer-use-implementation-review.md)。
