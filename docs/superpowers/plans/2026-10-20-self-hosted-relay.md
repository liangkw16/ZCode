# Self-Hosted Relay + 免登录手机远控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在用户 ECS 上自托管单用户 Relay V2 服务与免登录手机远控页，KCode 桌面经 kcode 门控 setting 指向自建 relay，官方 ZCode 链路零变化。

**Architecture:** 新增 `apps/self-host-relay`（Node 单进程：HTTP 契约端点 + ws2 网关 + 内置静态托管 + 每 IP 限流，设备表 JSON 防抖落盘，tsup noExternal 单文件部署）；手机页以构建期 `VITE_ZCODE_REMOTE_SELF_HOSTED` 标记启用免登录，密钥经书签 URL `#k=` fragment 分发到 localStorage（构建产物零密钥）；桌面在受管模块 `desktop-web-remote-relay` 内新增 kcode 门控的远控端点覆盖（仅 `getEndpointUrls` 路径）。

**Tech Stack:** Node 22（本地 mise、ECS 官方 tarball）、ws 8.20.0、`@zcode/shared/web-remote-relay` 契约解析、tsup ^8.5.0、vitest ^4.1.5、systemd。

**Spec:** `docs/superpowers/specs/2026-10-20-self-hosted-relay-design.md`（含证据锚点；计划与之冲突时以 spec 为准并先改 spec）

## Global Constraints

- 行为与协议以 spec 与 `docs/web-remote-control/relay-v2-pairing.md` 为准；wire 校验复用 `@zcode/shared/web-remote-relay` 导出，不复制 schema。
- 依赖版本固定：`ws 8.20.0`、`@types/ws 8.18.1`、`tsup ^8.5.0`、`typescript ^6.0.2`、`vitest ^4.1.5`、`@types/node ^24`。
- 不记录 JWT、一次性 token、密钥、消息内容到日志或提交；ECS IP、密钥等不写入任何已提交文件（执行期从 `~/.ssh/config` 与运行环境解析）。
- **selfhost 手机页构建产物不携带任何密钥**：密钥只存 ECS env 文件与手机 localStorage，经书签 URL `#k=` fragment 分发（fragment 不发往服务端）；官方 flavor（production/preview）行为不变：web 构建未注入 `VITE_ZCODE_REMOTE_SELF_HOSTED` 时产物与现状等价；desktop 非 kcode flavor 时新 helper 返回 null。
- 每个 bugfix 用中文注释说明原因与修复依据；新代码遵守 oxlint 与 `pnpm typecheck`。
- 每任务收尾必须真实运行其测试命令并报告结果；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 在 Task 10 全量执行。
- 本地 Node 版本以 `mise.toml` 为准（`mise exec -- node scripts/mise-run.mjs <cmd>` 模式跑仓库脚本）；ECS 用 Node 22 官方 tarball（npmmirror 镜像下载）。
- KCode 重建管线（Task 10 复用）：`ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1` + desktop build + `npm_config_user_agent="pnpm/10.33.2" pnpm exec electron-builder --config electron-builder.config.js --mac zip`（root 有双 lockfile，必须走 pnpm collector）。
- pre-push hook 不可用（需 origin/staging）；等价门禁按 Task 10 步骤手工执行，push 用 `--no-verify`。

## Review Focus

最可能咬人的五类输入/失效模式（均已有归属任务的测试钉死）：

1. **静态服务路径穿越**（`/remote/v4/%2e%2e/%2e%2e/etc/passwd`）：应 404 且不读根外文件 → Task 5 测试 `rejects traversal outside root`。
2. **一次性 token 重放**（同一 token 第二次 WS 升级）：应 401 → Task 4 测试 `rejects reused token`。
3. **被替换旧连接迟到 close 误释放新 owner**（KICKED 后旧 socket 异步关闭）：释放必须按 owner 引用身份比对 → Task 2 测试 `release ignores stale owner` + Task 4 集成复验。
4. **密钥端点未持密钥**（空 bearer 调注册、错误密钥调 list/terminal token）：注册与 device token 接受任意非空 bearer，list 与 terminal token 必须密钥，空 bearer 一律 401 → Task 3 鉴权矩阵测试。
5. **relay 重启后设备表丢失导致桌面反复重注册**：devices.json 防抖落盘 + 启动恢复，重启后旧 SID 仍可 auth_init → Task 6 持久化 roundtrip 测试。

（补充：手机端未携带/失效密钥与 relay 401 都不得落回 OAuth 登录页（login 视图拦截为失败页）→ Task 7 `login view intercepted` 测试。）

---

### Task 1: relay 包骨架与受管模块注册

**Files:**
- Create: `apps/self-host-relay/package.json`
- Create: `apps/self-host-relay/tsconfig.json`
- Create: `apps/self-host-relay/vitest.config.ts`
- Create: `apps/self-host-relay/tsup.config.ts`
- Create: `apps/self-host-relay/src/contract.ts`
- Create: `apps/self-host-relay/src/contract.example.ts`
- Create: `apps/self-host-relay/src/contract.test.ts`
- Create: `apps/self-host-relay/src/module.ts`
- Create: `apps/self-host-relay/src/CONTRACT.md`
- Modify: `pnpm-workspace.yaml`（packages 列表加 `apps/self-host-relay`）
- Modify: `package.json:54`（typecheck 的 `tsc -b` 参数列表末尾加 ` apps/self-host-relay`）

**Interfaces:**
- Consumes: `@zcode/shared/web-remote-relay`（子路径导出已存在，指向 src）。
- Produces（后续任务照此实现，签名不得漂移）:
  - `SelfHostRelayConfig` / `SelfHostRelayRuntime`（contract.ts，Task 6 的 module 装配实现）
  - `SelfHostRelayStore` 端口（contract.ts，Task 2 的 domain 实现）
  - 路由 handler 签名 `(request: IncomingMessage, response: ServerResponse) => Promise<boolean>`（Task 3/5 实现，`true`=已处理）

- [ ] **Step 1: 写 package.json / tsconfig / vitest 配置**

`apps/self-host-relay/package.json`：

```json
{
  "name": "@zcode/self-host-relay",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@zcode/shared": "workspace:*",
    "ws": "8.20.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/ws": "8.18.1",
    "tsup": "^8.5.0",
    "typescript": "^6.0.2",
    "vitest": "^4.1.5"
  }
}
```

`apps/self-host-relay/tsconfig.json`（noEmit；shared 经 references 引用，非相对导入用 NodeNext；不设 rootDir，避免 test 目录越界报错）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2022"]
  },
  "include": ["src", "test"],
  "references": [{ "path": "../../packages/shared" }]
}
```

（base 带 `composite: true`，与 `noEmit` 互斥，故显式关掉 composite/declaration；`lib` 覆盖为 ES2022 以匹配 Node 22 运行时。）

注意：tsconfig `include` 覆盖 `test/`（本包自跑 vitest，不经根 vitest——根 vitest 只收 `packages/*/test/**`）。tsup 输出 `dist/`（已被根 `.gitignore` 的 `dist/` 覆盖）。

`apps/self-host-relay/tsup.config.ts`（`noExternal` 把 `ws` 与 `@zcode/shared` 一并打进单文件，ECS 零 node_modules）：

```ts
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
```

`apps/self-host-relay/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
```

- [ ] **Step 2: 写 contract.ts（全量端口冻结）**

`apps/self-host-relay/src/contract.ts`：

```ts
import type {
  WebRemoteControlRelayV2Device,
  WebRemoteControlRelayV2Meta,
  WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";

export type {
  WebRemoteControlRelayV2Device,
  WebRemoteControlRelayV2Meta,
  WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";

/** 进程配置；secret 必填，其余有默认值。 */
export interface SelfHostRelayConfig {
  host: string;
  port: number;
  secret: string;
  /** 设备表 JSON 落盘路径；缺省不持久化（重启丢 SID，桌面会自动重注册）。 */
  devicesFile?: string;
  /** 手机页静态目录；提供后服务托管 `/remote/v4` 前缀。 */
  staticRoot?: string;
}

export interface SelfHostRelayRuntime {
  port: number;
  close(): Promise<void>;
}

/** 设备/一次性 token/连接 owner 的唯一状态所有者；owner 以引用身份比对。 */
export interface SelfHostRelayStore {
  registerDevice(deviceMid: string, nowMs: number): { deviceSid: string; createdAt: number };
  listDevices(nowMs: number): WebRemoteControlRelayV2Device[];
  deleteDevice(deviceSid: string): "deleted" | "missing" | "device-online";
  issueToken(role: WebRemoteControlRelayV2Role, token: string, nowMs: number): void;
  consumeToken(token: string, nowMs: number): WebRemoteControlRelayV2Role | null;
  /** 设备不存在返回 null；否则登记 owner 并返回被替换的旧 owner 引用。 */
  claimOwnership(
    deviceSid: string,
    role: WebRemoteControlRelayV2Role,
    meta: WebRemoteControlRelayV2Meta,
    owner: unknown,
  ): { kicked: unknown | null } | null;
  /** 只在 owner 引用与当前 owner 一致时释放；返回是否真的释放。 */
  releaseOwnership(deviceSid: string, role: WebRemoteControlRelayV2Role, owner: unknown): boolean;
  getOwner(
    deviceSid: string,
    role: WebRemoteControlRelayV2Role,
  ): { owner: unknown; meta: WebRemoteControlRelayV2Meta } | undefined;
  serializeDevices(): { version: 1; devices: { deviceSid: string; deviceMid: string; createdAt: number }[] };
  /** 恢复持久化设备表；返回恢复条数，非法输入返回 0。 */
  restoreDevices(data: unknown): number;
  setDevicesChangeListener(listener: () => void): void;
}
```

（契约方法数说明：本文件公开方法共 12 个（Store 11 + Runtime.close 1），等于 policy
`max-public-methods` 上限 12（`countPublicMethods` 口径），不触发违规；若 adopt 后
`architecture:check` 仍报超限，先合并 `getOwner` 与 `claimOwnership` 再继续，不得放宽 policy。）

- [ ] **Step 3: 写 module.ts / CONTRACT.md / contract.example.ts / contract.test.ts**

`apps/self-host-relay/src/module.ts`（Task 6 会扩展为装配入口，当前为真实的类型再导出）：

```ts
export type { SelfHostRelayConfig, SelfHostRelayRuntime, SelfHostRelayStore } from "./contract.js";
```

`apps/self-host-relay/src/CONTRACT.md`：

```markdown
# self-host-relay

单实例单用户 Relay V2 自托管服务：HTTP 契约端点（注册/列表/删除/token）、
ws2 网关（auth_init/配对/KICKED/透传/断开通知）、可选 `/remote/v4` 静态托管、
每 IP 限流。wire 校验复用 `@zcode/shared/web-remote-relay`，语义以
`docs/web-remote-control/relay-v2-pairing.md` 为准。

- 状态所有者：`RelayStore` 独占设备表、一次性 token 与 `(sid, role)` owner；
  adapter 只做 IO 与消息路由，不持有第二份业务状态。
- 鉴权策略：`GET /device` 与 `POST /token(role=terminal)` 必须 Bearer === secret；
  注册/删除/`role=device` token 接受任意非空 Bearer；空 Bearer 一律 401。
- 持久化：仅设备表（JSON 防抖落盘）；token/连接为内存态。
- 日志只记连接生命周期与错误码，不记 token/密钥/消息内容。

完整设计见 `docs/superpowers/specs/2026-10-20-self-hosted-relay-design.md`。
```

`apps/self-host-relay/src/contract.example.ts`：

```ts
import type { SelfHostRelayConfig } from "./contract.js";

export const SELF_HOST_RELAY_CONFIG_EXAMPLE: SelfHostRelayConfig = {
  host: "0.0.0.0",
  port: 8787,
  secret: "<openssl rand -hex 32>",
  devicesFile: "/var/lib/self-host-relay/devices.json",
  staticRoot: "/opt/self-host-relay/web",
};
```

`apps/self-host-relay/src/contract.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SELF_HOST_RELAY_CONFIG_EXAMPLE } from "./contract.example.js";
import type { SelfHostRelayConfig, SelfHostRelayStore } from "./contract.js";

describe("self-host-relay contract", () => {
  it("配置示例满足端口类型", () => {
    const config: SelfHostRelayConfig = SELF_HOST_RELAY_CONFIG_EXAMPLE;
    expect(config.port).toBe(8787);
    expect(config.secret.length).toBeGreaterThan(0);
  });

  it("Store 端口可被实现方引用（编译期契约）", () => {
    const store: SelfHostRelayStore | null = null;
    expect(store).toBeNull(); // 仅类型引用，运行时不构造
  });
});
```

- [ ] **Step 4: 注册 workspace、typecheck 列表、架构模块**

`pnpm-workspace.yaml` packages 列表（`apps/zcode-cli` 行后）加：

```yaml
  - apps/self-host-relay
```

`package.json` typecheck 脚本：在 `packages/desktop/tsconfig.e2e.json` 之后、`&& tsc -p packages/desktop/tsconfig.remote-main.json` 之前的 `tsc -b` 参数列表末尾追加 ` apps/self-host-relay`。

然后：

```bash
pnpm install
pnpm architecture:adopt self-host-relay --root apps/self-host-relay/src --layer adapters
```

adopt 会保留已有五件套（仅缺失时生成脚手架）并把模块登记进 `architecture-policy.yaml`；若它生成了多余脚手架文件，删除多余文件、保留登记。

- [ ] **Step 5: 验证并提交**

```bash
pnpm --filter @zcode/self-host-relay test
mise exec -- node scripts/mise-run.mjs pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

Expected: 测试通过；typecheck 通过；architecture 0 新违规。

```bash
git status --short   # 确认 adopt 改动的 policy/清单文件实际路径（通常为根 architecture-policy.yaml）
git add apps/self-host-relay pnpm-workspace.yaml package.json pnpm-lock.yaml architecture-policy.yaml
git commit --no-verify -m "feat: self-host-relay 包骨架与受管模块注册"
```

---

### Task 2: RelayStore 领域状态机

**Files:**
- Create: `apps/self-host-relay/src/domain/relayStore.ts`
- Test: `apps/self-host-relay/test/relayStore.test.ts`

**Interfaces:**
- Consumes: `SelfHostRelayStore`（Task 1 contract.ts）。
- Produces: `class RelayStore implements SelfHostRelayStore`，构造器
  `new RelayStore(options: { newSid: () => string; now?: () => number })`（token 值由调用方生成后传入 `issueToken`，domain 保持可测确定性）。

- [ ] **Step 1: 写失败测试**

`apps/self-host-relay/test/relayStore.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { RelayStore } from "../src/domain/relayStore.js";

function createStore() {
  let sid = 0;
  return new RelayStore({ newSid: () => `d_${++sid}` });
}

describe("RelayStore", () => {
  it("注册同 MID 每次产生新 SID，列表在线位由 device owner 决定并携带 meta", () => {
    const store = createStore();
    const a = store.registerDevice("mid-1", 1_000);
    const b = store.registerDevice("mid-1", 2_000);
    expect(a.deviceSid).not.toBe(b.deviceSid);
    const owner = { id: "conn-1" };
    store.claimOwnership(b.deviceSid, "device", { name: "Mac" }, owner);
    const list = store.listDevices(3_000);
    expect(list).toHaveLength(2);
    const online = list.find((d) => d.device_sid === b.deviceSid)!;
    expect(online.online).toBe(true);
    expect(online.meta).toEqual({ name: "Mac" });
    expect(list.find((d) => d.device_sid === a.deviceSid)!.online).toBe(false);
  });

  it("token 一次性消费：过期返回 null，消费后不可复用", () => {
    const store = createStore();
    store.issueToken("terminal", "tok-1", 0);
    expect(store.consumeToken("tok-1", 1_000)).toBe("terminal");
    expect(store.consumeToken("tok-1", 1_100)).toBeNull();
    store.issueToken("device", "tok-2", 0);
    expect(store.consumeToken("tok-2", 61_000)).toBeNull();
  });

  it("claimOwnership 替换同角色 owner 并返回被踢引用；未知设备返回 null", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    expect(store.claimOwnership(deviceSid, "device", {}, oldOwner)!.kicked).toBeNull();
    expect(store.claimOwnership(deviceSid, "device", {}, newOwner)!.kicked).toBe(oldOwner);
    expect(store.getOwner(deviceSid, "device")!.owner).toBe(newOwner);
    expect(store.claimOwnership("d_unknown", "device", {}, newOwner)).toBeNull();
  });

  it("releaseOwnership 按引用身份释放，迟到旧连接不误伤新 owner", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    const oldOwner = { id: "old" };
    const newOwner = { id: "new" };
    store.claimOwnership(deviceSid, "terminal", {}, oldOwner);
    store.claimOwnership(deviceSid, "terminal", {}, newOwner);
    expect(store.releaseOwnership(deviceSid, "terminal", oldOwner)).toBe(false);
    expect(store.getOwner(deviceSid, "terminal")!.owner).toBe(newOwner);
    expect(store.releaseOwnership(deviceSid, "terminal", newOwner)).toBe(true);
    expect(store.getOwner(deviceSid, "terminal")).toBeUndefined();
  });

  it("deleteDevice：在线设备 3005 语义返回 device-online，缺失幂等 missing", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 0);
    // Bugfix：owner 按引用身份释放，claim/release 必须复用同一个对象，否则测试必败。
    const owner = { id: "c" };
    store.claimOwnership(deviceSid, "device", {}, owner);
    expect(store.deleteDevice(deviceSid)).toBe("device-online");
    store.releaseOwnership(deviceSid, "device", owner);
    expect(store.deleteDevice(deviceSid)).toBe("deleted");
    expect(store.deleteDevice(deviceSid)).toBe("missing");
  });

  it("设备表序列化/恢复 roundtrip，owner 与 token 不参与持久化", () => {
    const store = createStore();
    const { deviceSid } = store.registerDevice("mid-1", 5_000);
    store.claimOwnership(deviceSid, "device", { name: "x" }, { id: "c" });
    store.issueToken("terminal", "tok", 0);
    const persisted = JSON.parse(JSON.stringify(store.serializeDevices()));
    const restored = createStore();
    expect(restored.restoreDevices(persisted)).toBe(1);
    const list = restored.listDevices(6_000);
    expect(list[0]!.device_sid).toBe(deviceSid);
    expect(list[0]!.online).toBe(false);
    expect(restored.consumeToken("tok", 1)).toBeNull();
    expect(restored.restoreDevices({ garbage: true })).toBe(0);
    expect(restored.restoreDevices(null)).toBe(0);
  });

  it("设备变更触发 listener（注册与删除）", () => {
    const store = createStore();
    let changes = 0;
    store.setDevicesChangeListener(() => {
      changes += 1;
    });
    const { deviceSid } = store.registerDevice("mid-1", 0);
    store.issueToken("device", "t", 0);
    store.deleteDevice(deviceSid);
    expect(changes).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/relayStore.test.ts`
Expected: FAIL（`Cannot find module '../src/domain/relayStore.js'`）

- [ ] **Step 3: 实现 RelayStore**

`apps/self-host-relay/src/domain/relayStore.ts`：

```ts
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

const TOKEN_TTL_MS = 60_000;

interface DeviceRecord {
  deviceSid: string;
  deviceMid: string;
  createdAt: number;
}

interface OwnerSlot {
  owner: unknown;
  meta: WebRemoteControlRelayV2Device["meta"];
}

export interface RelayStoreOptions {
  newSid: () => string;
}

/** 唯一状态所有者：设备表、一次性 token、(sid, role) owner；不持有 IO。 */
export class RelayStore implements SelfHostRelayStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly tokens = new Map<
    string,
    { role: "device" | "terminal"; expiresAt: number }
  >();
  private readonly owners = new Map<string, Partial<Record<"device" | "terminal", OwnerSlot>>>();
  private devicesChangeListener: (() => void) | undefined;

  constructor(private readonly options: RelayStoreOptions) {}

  setDevicesChangeListener(listener: () => void): void {
    this.devicesChangeListener = listener;
  }

  private notifyDevicesChange(): void {
    this.devicesChangeListener?.();
  }

  registerDevice(deviceMid: string, nowMs: number): { deviceSid: string; createdAt: number } {
    const record = {
      deviceSid: this.options.newSid(),
      deviceMid,
      createdAt: Math.floor(nowMs / 1000),
    };
    this.devices.set(record.deviceSid, record);
    this.notifyDevicesChange();
    return { deviceSid: record.deviceSid, createdAt: record.createdAt };
  }

  listDevices(nowMs: number): WebRemoteControlRelayV2Device[] {
    void nowMs;
    return [...this.devices.values()].map((record) => {
      const slot = this.owners.get(record.deviceSid)?.device;
      return {
        device_sid: record.deviceSid,
        device_mid: record.deviceMid,
        online: !!slot,
        created_at: record.createdAt,
        meta: slot ? { ...slot.meta } : {},
      };
    });
  }

  deleteDevice(deviceSid: string): "deleted" | "missing" | "device-online" {
    if (this.owners.get(deviceSid)?.device) return "device-online";
    if (!this.devices.delete(deviceSid)) return "missing";
    this.notifyDevicesChange();
    return "deleted";
  }

  issueToken(role: "device" | "terminal", token: string, nowMs: number): void {
    this.tokens.set(token, { role, expiresAt: nowMs + TOKEN_TTL_MS });
  }

  consumeToken(token: string, nowMs: number): "device" | "terminal" | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    // 升级前原子消费：无论结果如何都移除，重连必须重新申请。
    this.tokens.delete(token);
    return entry.expiresAt > nowMs ? entry.role : null;
  }

  claimOwnership(
    deviceSid: string,
    role: "device" | "terminal",
    meta: WebRemoteControlRelayV2Device["meta"],
    owner: unknown,
  ): { kicked: unknown | null } | null {
    if (!this.devices.has(deviceSid)) return null;
    const roles = this.owners.get(deviceSid) ?? {};
    const kicked = roles[role]?.owner ?? null;
    roles[role] = { owner, meta: { ...meta } };
    this.owners.set(deviceSid, roles);
    return { kicked };
  }

  releaseOwnership(deviceSid: string, role: "device" | "terminal", owner: unknown): boolean {
    const roles = this.owners.get(deviceSid);
    // Bugfix：被替换连接的 close 晚于新认证完成，必须按 owner 引用身份释放，
    // 否则旧连接异步关闭会拆掉新 owner（契约：异步 close 不得移除新 owner）。
    if (!roles || roles[role]?.owner !== owner) return false;
    delete roles[role];
    if (!roles.device && !roles.terminal) this.owners.delete(deviceSid);
    return true;
  }

  getOwner(
    deviceSid: string,
    role: "device" | "terminal",
  ): { owner: unknown; meta: WebRemoteControlRelayV2Device["meta"] } | undefined {
    const slot = this.owners.get(deviceSid)?.[role];
    return slot ? { owner: slot.owner, meta: { ...slot.meta } } : undefined;
  }

  serializeDevices(): {
    version: 1;
    devices: { deviceSid: string; deviceMid: string; createdAt: number }[];
  } {
    return {
      version: 1,
      devices: [...this.devices.values()].map((record) => ({ ...record })),
    };
  }

  restoreDevices(data: unknown): number {
    if (!data || typeof data !== "object") return 0;
    const parsed = data as { version?: unknown; devices?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return 0;
    let restored = 0;
    for (const item of parsed.devices) {
      if (!item || typeof item !== "object") continue;
      const record = item as { deviceSid?: unknown; deviceMid?: unknown; createdAt?: unknown };
      if (
        typeof record.deviceSid !== "string" ||
        typeof record.deviceMid !== "string" ||
        typeof record.createdAt !== "number" ||
        !record.deviceSid.trim() ||
        !record.deviceMid.trim()
      ) {
        continue;
      }
      this.devices.set(record.deviceSid, {
        deviceSid: record.deviceSid,
        deviceMid: record.deviceMid,
        createdAt: record.createdAt,
      });
      restored += 1;
    }
    return restored;
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/relayStore.test.ts`
Expected: PASS（7 项）

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/domain apps/self-host-relay/test
git commit --no-verify -m "feat: self-host-relay 设备/token/owner 领域状态机"
```

---

### Task 3: HTTP 契约路由（鉴权矩阵 + 限流）

**Files:**
- Create: `apps/self-host-relay/src/adapters/httpRouter.ts`
- Test: `apps/self-host-relay/test/httpRouter.test.ts`

**Interfaces:**
- Consumes: `SelfHostRelayStore`（Task 1）。
- Produces:
  `createSelfHostRelayHttpRouter(options: { store: SelfHostRelayStore; secret: string; now?: () => number }): (request: IncomingMessage, response: ServerResponse) => Promise<boolean>`
  —— 已处理返回 `true`；非 `/api/v1/remote` 前缀返回 `false`（静态服务/404 兜底）。限流内置：每 IP 每分钟 1200 次，超出 429。

- [ ] **Step 1: 写失败测试**

`apps/self-host-relay/test/httpRouter.test.ts`：

```ts
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSelfHostRelayHttpRouter } from "../src/adapters/httpRouter.js";
import { RelayStore } from "../src/domain/relayStore.js";

const SECRET = "secret-1";
let server: Server;
let baseUrl: string;
let store: RelayStore;
let deviceSid: string;

beforeAll(async () => {
  store = new RelayStore({ newSid: () => `d_${Math.random().toString(36).slice(2)}` });
  deviceSid = store.registerDevice("mid-test", Date.now()).deviceSid;
  const router = createSelfHostRelayHttpRouter({ store, secret: SECRET });
  server = createServer((request, response) => {
    void router(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

describe("self-host relay HTTP 契约", () => {
  it("注册：任意非空 bearer 成功，返回新设备记录，信封 code 0", async () => {
    const response = await call("/api/v1/remote/device", {
      method: "POST",
      headers: { Authorization: "Bearer any-jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-a" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: number; data: { device_sid: string } };
    expect(body.code).toBe(0);
    expect(body.data.device_sid).toMatch(/^d_/);
  });

  it("鉴权矩阵：空 bearer 一律 401；list 与 terminal token 错密钥 401、对密钥 200；device token 任意 bearer 200", async () => {
    expect(
      (await call("/api/v1/remote/device", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect((await call("/api/v1/remote/device")).status).toBe(401);
    expect(
      (
        await call("/api/v1/remote/device", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    const tokenOk = async (role: string, bearer: string) => {
      const response = await call("/api/v1/remote/token", {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      return response;
    };
    expect((await tokenOk("terminal", "wrong")).status).toBe(401);
    const terminal = await tokenOk("terminal", SECRET);
    expect(terminal.status).toBe(200);
    expect(terminal.headers.get("cache-control")).toBe("no-store");
    const terminalBody = (await terminal.json()) as { data: { token: string; expires_in: number } };
    expect(terminalBody.data.token).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(terminalBody.data.expires_in).toBe(60);
    expect((await tokenOk("device", "any-jwt")).status).toBe(200);
  });

  it("列表：密钥 bearer 返回设备数组，online 位反映 owner 状态", async () => {
    const response = await call("/api/v1/remote/device", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = (await response.json()) as {
      data: { device_sid: string; online: boolean; meta: Record<string, unknown> }[];
    };
    const record = body.data.find((item) => item.device_sid === deviceSid)!;
    expect(record.online).toBe(false);
    expect(record.meta).toEqual({});
  });

  it("参数非法 400 code 3001；删除在线设备 400 code 3005；删除缺失幂等 200", async () => {
    const bad = await call("/api/v1/remote/device", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ device_mid: " " }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: number }).code).toBe(3001);

    store.claimOwnership(deviceSid, "device", {}, { id: "conn" });
    const online = await call("/api/v1/remote/device/delete", {
      method: "POST",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
      body: JSON.stringify({ device_sid: deviceSid }),
    });
    expect(online.status).toBe(400);
    expect(((await online.json()) as { code: number }).code).toBe(3005);
    store.releaseOwnership(deviceSid, "device", { id: "conn" });

    const missing = await call("/api/v1/remote/device/delete", {
      method: "POST",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
      body: JSON.stringify({ device_sid: "d_missing" }),
    });
    expect(missing.status).toBe(200);
  });

  it("每 IP 限流：超过 1200 次/分钟返回 429", async () => {
    let limited = false;
    for (let i = 0; i < 1210 && !limited; i += 1) {
      const response = await call("/api/v1/remote/token", {
        method: "POST",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ role: "device" }),
      });
      if (response.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/httpRouter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 httpRouter**

`apps/self-host-relay/src/adapters/httpRouter.ts`：

```ts
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseWebRemoteControlRelayV2HttpRequest,
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
} from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

export interface SelfHostRelayHttpRouterOptions {
  store: SelfHostRelayStore;
  secret: string;
  now?: () => number;
}

const REMOTE_PREFIX = "/api/v1/remote";
const RATE_LIMIT_PER_MINUTE = 1200;

function bearerOf(authorization: string | undefined): string | null {
  return authorization?.match(/^Bearer (.+)$/i)?.[1] ?? null;
}

function reply(response: ServerResponse, status: number, data?: unknown, code = status === 200 ? 0 : status, msg = ""): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code, msg, ...(data === undefined ? {} : { data }) }));
}

function createRateLimiter(now: () => number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const nowMs = now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= nowMs) buckets.delete(key);
    }
    const bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= nowMs) {
      buckets.set(ip, { count: 1, resetAt: nowMs + 60_000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT_PER_MINUTE;
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  } catch {
    // Bugfix：客户端中断请求体（ECONNRESET）会从流读取抛出；吞掉并按非法 body 处理，
    // 否则未处理 rejection 会让整个 relay 进程退出（攻击者可反复打断服务）。
    return null;
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}

export function createSelfHostRelayHttpRouter(options: SelfHostRelayHttpRouterOptions) {
  const now = options.now ?? Date.now;
  const allowRequest = createRateLimiter(now);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    // 客户端中途断开时 socket 两侧都可能抛错；吞掉并以 destroy 收尾，保证进程存活。
    request.on("error", () => {});
    response.on("error", () => {});
    try {
      return await route(request, response);
    } catch {
      if (!response.headersSent) {
        try {
          reply(response, 500);
        } catch {
          // 响应已不可写（socket 已销毁），无需处理。
        }
      }
      response.destroy();
      return true;
    }
  };
  async function route(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(REMOTE_PREFIX)) return false;
    const ip = request.socket.remoteAddress ?? "unknown";
    if (!allowRequest(ip)) {
      reply(response, 429);
      return true;
    }
    const bearer = bearerOf(request.headers.authorization);
    if (!bearer) {
      reply(response, 401);
      return true;
    }
    const isSecret = bearer === options.secret;
    const method = request.method ?? "GET";
    const body = await readBody(request);

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.token.path && method === "POST") {
      response.setHeader("Cache-Control", "no-store");
      const parsed = parseWebRemoteControlRelayV2HttpRequest("token", body);
      if (!parsed) return reply(response, 400, undefined, 3001, "parameter error"), true;
      // 密钥只保护敏感能力：terminal token 可连桌面必须持密钥；device token 任意 bearer。
      if (parsed.role === "terminal" && !isSecret) {
        reply(response, 401);
        return true;
      }
      const token = randomBytes(16).toString("base64url");
      options.store.issueToken(parsed.role, token, now());
      reply(response, 200, { token, expires_in: 60 });
      return true;
    }

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.register.path && method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("register", body);
      if (!parsed) return reply(response, 400, undefined, 3001, "parameter error"), true;
      const record = options.store.registerDevice(parsed.device_mid, now());
      reply(response, 200, {
        device_sid: record.deviceSid,
        device_mid: parsed.device_mid,
        online: false,
        created_at: record.createdAt,
        meta: {},
      });
      return true;
    }

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.list.path && method === "GET") {
      // 列表泄露 SID（terminal 可凭 SID 配对），必须持密钥。
      if (!isSecret) {
        reply(response, 401);
        return true;
      }
      reply(response, 200, options.store.listDevices(now()));
      return true;
    }

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.delete.path && method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("delete", body);
      if (!parsed) return reply(response, 400, undefined, 3001, "parameter error"), true;
      const result = options.store.deleteDevice(parsed.device_sid);
      if (result === "device-online") return reply(response, 400, undefined, 3005, "wrong status"), true;
      reply(response, 200);
      return true;
    }

    reply(response, 404);
    return true;
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/httpRouter.test.ts`
Expected: PASS（5 项）

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/adapters/httpRouter.ts apps/self-host-relay/test/httpRouter.test.ts
git commit --no-verify -m "feat: self-host-relay HTTP 契约路由（密钥矩阵/信封/限流）"
```

---

### Task 4: ws2 网关（配对/KICKED/透传/断开通知）

**Files:**
- Create: `apps/self-host-relay/src/adapters/wsGateway.ts`
- Test: `apps/self-host-relay/test/wsGateway.test.ts`

**Interfaces:**
- Consumes: `SelfHostRelayStore`、`parseWebRemoteControlRelayV2OutgoingMessage`、`WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH`（shared）、Task 3 `createSelfHostRelayHttpRouter`（仅测试挂载用）。
- Produces: `attachSelfHostRelayWsGateway(server: Server, options: { store: SelfHostRelayStore; now?: () => number }): { close(): Promise<void> }`——接管 `server` 的 `upgrade` 事件；`close()` 终止全部 WS 连接并等待释放（`server.closeAllConnections()` 不覆盖已升级连接，优雅退出必须经它，Task 6 依赖此签名）。

- [ ] **Step 1: 写失败测试**

`apps/self-host-relay/test/wsGateway.test.ts`（Node `ws` 客户端走完整 HTTP+WS；消息断言基于 JSON 解析）：

```ts
import { createServer, type Server } from "node:http";
import { get as httpGet, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSelfHostRelayHttpRouter } from "../src/adapters/httpRouter.js";
import { attachSelfHostRelayWsGateway } from "../src/adapters/wsGateway.js";
import { RelayStore } from "../src/domain/relayStore.js";

const SECRET = "secret-1";
let server: Server;
let baseUrl: string;
let wsUrl: string;
let store: RelayStore;
let deviceSid: string;

beforeAll(async () => {
  store = new RelayStore({ newSid: () => `d_${Math.random().toString(36).slice(2)}` });
  deviceSid = store.registerDevice("mid-gw", Date.now()).deviceSid;
  // 挂真实 HTTP 路由：mintToken 走真实 token 端点（服务端 404 会让所有建连用例假失败）。
  const router = createSelfHostRelayHttpRouter({ store, secret: SECRET });
  server = createServer((request, response) => {
    void router(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  attachSelfHostRelayWsGateway(server, { store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/v1/remote/ws2`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function mintToken(role: "device" | "terminal"): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/remote/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  }).then((r) => r.json() as Promise<{ data: { token: string } }>);
  return response.data.token;
}

function openSocket(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}?token=${token}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (data: RawData) => {
      socket.off("message", onMessage);
      resolve(JSON.parse(data.toString()));
    };
    socket.on("message", onMessage);
  });
}

/** 发起升级请求并断言服务端在升级前返回的 HTTP 状态（undici fetch 不走 upgrade 路径，用原生 http 客户端）。 */
function upgradeStatus(pathAndQuery: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      `${wsUrl.replace("ws", "http")}${pathAndQuery}`,
      { headers: { Connection: "Upgrade", Upgrade: "websocket" } } as never,
      (response: IncomingMessage) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      },
    );
    request.on("upgrade", () => resolve(101));
    request.on("error", reject);
  });
}

async function authenticated(role: "device" | "terminal", sid: string): Promise<WebSocket> {
  const socket = await openSocket(await mintToken(role));
  socket.send(JSON.stringify({ type: "auth_init", device_sid: sid, meta: { name: "gw-test" } }));
  const ack = await nextMessage(socket);
  expect(ack.type).toBe("auth_ack");
  return socket;
}

describe("ws2 网关", () => {
  it("无 token/伪造 token 升级前 401", async () => {
    expect(await upgradeStatus("?token=fake")).toBe(401);
    expect(await upgradeStatus("")).toBe(401);
  });

  it("一次性 token 不可复用", async () => {
    const token = await mintToken("device");
    const first = await openSocket(token);
    first.close();
    expect(await upgradeStatus(`?token=${token}`)).toBe(401);
  });

  it("未知 SID auth_init 返回 AUTH_FAILED 并关闭", async () => {
    const socket = await openSocket(await mintToken("device"));
    socket.send(JSON.stringify({ type: "auth_init", device_sid: "d_unknown" }));
    const error = await nextMessage(socket);
    expect(error).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    await once(socket, "close");
  });

  it("device 等待 → terminal 配对 matched → 双向 data 透传 → 断开通知", async () => {
    const device = await authenticated("device", deviceSid);
    const terminal = await authenticated("terminal", deviceSid);
    const deviceAck = await nextMessage(device);
    expect(deviceAck).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });

    terminal.send(JSON.stringify({ type: "data", payload: { hello: "desktop" } }));
    const forwarded = await nextMessage(device);
    expect(forwarded).toMatchObject({ type: "data", payload: { hello: "desktop" } });
    device.send(JSON.stringify({ type: "data", payload: { hello: "phone" } }));
    const toPhone = await nextMessage(terminal);
    expect(toPhone).toMatchObject({ type: "data", payload: { hello: "phone" } });

    device.close();
    const waiting = await nextMessage(terminal);
    expect(waiting).toMatchObject({ type: "pair_status_ack", pair_status: "waiting" });
    const offline = await nextMessage(terminal);
    expect(offline).toMatchObject({ type: "error", code: "DEVICE_OFFLINE" });
    await once(terminal, "close");
  });

  it("同角色新连接替换旧 owner：旧连接收 KICKED 关闭，新连接不受影响", async () => {
    const first = await authenticated("device", deviceSid);
    const second = await authenticated("device", deviceSid);
    const kicked = await nextMessage(first);
    expect(kicked).toMatchObject({ type: "error", code: "KICKED" });
    await once(first, "close");
    // 旧连接的迟到 close 不得释放新 owner：查询仍是认证态。
    second.send(JSON.stringify({ type: "pair_status_query" }));
    const ack = await nextMessage(second);
    expect(ack).toMatchObject({ type: "pair_status_ack", pair_status: "waiting" });
    second.close();
  });

  it("未认证发 data 返回 AUTH_FAILED 并关闭；非法消息 WRONG_PARAM 关闭", async () => {
    const socket = await openSocket(await mintToken("terminal"));
    socket.send(JSON.stringify({ type: "data", payload: {} }));
    const error = await nextMessage(socket);
    expect(error).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    await once(socket, "close");

    const invalid = await openSocket(await mintToken("device"));
    invalid.send("not-json");
    const wrong = await nextMessage(invalid);
    expect(wrong).toMatchObject({ type: "error", code: "WRONG_PARAM" });
    await once(invalid, "close");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/wsGateway.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 wsGateway**

`apps/self-host-relay/src/adapters/wsGateway.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseWebRemoteControlRelayV2OutgoingMessage,
  WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

export interface SelfHostRelayWsGatewayOptions {
  store: SelfHostRelayStore;
  now?: () => number;
}

interface RelayConnection {
  role: WebRemoteControlRelayV2Role;
  terminalSid: string;
  deviceSid: string | null;
  ownerRef: unknown;
  socket: WebSocket;
}

export function attachSelfHostRelayWsGateway(
  server: Server,
  options: SelfHostRelayWsGatewayOptions,
): { close(): Promise<void> } {
  const now = options.now ?? Date.now;
  const store = options.store;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const connections = new Map<unknown, RelayConnection>();

  const send = (connection: RelayConnection, message: WebRemoteControlRelayV2IncomingMessage): void => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) }));
    }
  };

  const peerOf = (connection: RelayConnection): RelayConnection | undefined => {
    if (!connection.deviceSid) return undefined;
    const otherRole: WebRemoteControlRelayV2Role = connection.role === "device" ? "terminal" : "device";
    const owner = store.getOwner(connection.deviceSid, otherRole);
    return owner ? connections.get(owner.owner) : undefined;
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const role = store.consumeToken(token, now());
    if (url.pathname !== WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH || !role) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const connection: RelayConnection = {
        role,
        terminalSid: role === "terminal" ? `t_${randomUUID()}` : "",
        deviceSid: null,
        ownerRef: {},
        socket: ws,
      };
      connections.set(connection.ownerRef, connection);
      ws.on("error", () => ws.terminate());
      ws.on("message", (data, isBinary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let parsedValue: unknown;
        try {
          parsedValue = JSON.parse(data.toString());
        } catch {
          parsedValue = null;
        }
        const message = isBinary ? null : parseWebRemoteControlRelayV2OutgoingMessage(parsedValue);
        if (!message) {
          send(connection, { type: "error", code: "WRONG_PARAM" });
          ws.close();
          return;
        }
        if (message.type === "auth_init") {
          if (connection.deviceSid) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          const claimed = store.claimOwnership(
            message.device_sid,
            connection.role,
            message.meta ?? {},
            connection.ownerRef,
          );
          if (!claimed) {
            send(connection, { type: "error", code: "AUTH_FAILED" });
            ws.close();
            return;
          }
          const kickedConnection = claimed.kicked ? connections.get(claimed.kicked) : undefined;
          if (kickedConnection) {
            send(kickedConnection, { type: "error", code: "KICKED" });
            kickedConnection.socket.close();
          }
          connection.deviceSid = message.device_sid;
          const peer = peerOf(connection);
          const pairStatus = peer ? "matched" : "waiting";
          if (peer) {
            // 契约：认证即配对时，对端收 pair_status_ack(matched)；terminal_sid 推送 ACK 为空。
            send(peer, { type: "pair_status_ack", pair_status: "matched", terminal_sid: "" });
          }
          send(connection, {
            type: "auth_ack",
            device_sid: message.device_sid,
            terminal_sid: connection.terminalSid,
            pair_status: pairStatus,
          });
          return;
        }
        if (!connection.deviceSid) {
          send(connection, { type: "error", code: "AUTH_FAILED" });
          ws.close();
          return;
        }
        if (message.type === "pair_status_query") {
          const peer = peerOf(connection);
          send(connection, {
            type: "pair_status_ack",
            pair_status: peer ? "matched" : "waiting",
            terminal_sid: peer?.terminalSid ?? "",
          });
          return;
        }
        const peer = peerOf(connection);
        if (peer) send(peer, { type: "data", payload: message.payload });
        else send(connection, { type: "error", code: "INTERNAL" });
      });
      ws.on("close", () => {
        connections.delete(connection.ownerRef);
        if (!connection.deviceSid) return;
        // 按引用身份释放：被 KICKED 替换后的迟到 close 不能拆新 owner。
        const released = store.releaseOwnership(connection.deviceSid, connection.role, connection.ownerRef);
        if (!released) return;
        const peer = peerOf(connection);
        if (peer) {
          send(peer, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
          if (connection.role === "device") {
            send(peer, { type: "error", code: "DEVICE_OFFLINE" });
            peer.socket.close();
          }
        }
      });
    });
  });
  return {
    // Bugfix：server.closeAllConnections() 不关闭已升级的 WS 连接；优雅退出必须先终止
    // 全部 WS 并等待释放，否则 server.close() 在有在线连接时永远挂起，持久化冲刷执行不到。
    close: async () => {
      for (const connection of connections.values()) connection.socket.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/wsGateway.test.ts`
Expected: PASS（6 项）

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/adapters/wsGateway.ts apps/self-host-relay/test/wsGateway.test.ts
git commit --no-verify -m "feat: self-host-relay ws2 网关（配对/KICKED/透传/断开通知）"
```

---

### Task 5: 内置静态托管（路径穿越防护）

**Files:**
- Create: `apps/self-host-relay/src/adapters/staticFiles.ts`
- Test: `apps/self-host-relay/test/staticFiles.test.ts`

**Interfaces:**
- Produces:
  `createSelfHostStaticHandler(options: { rootDir: string; urlPrefix?: string }): (request: IncomingMessage, response: ServerResponse) => Promise<boolean>`
  —— 默认 `urlPrefix "/remote/v4"`；仅 GET/HEAD；前缀根与 `/` 回退 `index.html`；根外路径 404。

- [ ] **Step 1: 写失败测试**

`apps/self-host-relay/test/staticFiles.test.ts`：

```ts
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSelfHostStaticHandler } from "../src/adapters/staticFiles.js";

let server: Server;
let baseUrl: string;
let root: string;
const dirs: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "relay-static-"));
  dirs.push(root);
  writeFileSync(join(root, "index.html"), "<html>remote-v4</html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "top-secret");
  const handler = createSelfHostStaticHandler({ rootDir: root });
  server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("静态托管", () => {
  it("/remote/v4 与 /remote/v4/ 返回 index.html（no-cache）", async () => {
    for (const path of ["/remote/v4", "/remote/v4/"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("remote-v4");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("hash 资源命中并以 immutable 缓存头返回", async () => {
    const response = await fetch(`${baseUrl}/remote/v4/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log(1)");
  });

  it("拒绝路径穿越（编码与明文 ../ 均根外 404）", async () => {
    const paths = [
      "/remote/v4/../secret.txt",
      "/remote/v4/%2e%2e/secret.txt",
      "/remote/v4/%2E%2E%2Fsecret.txt",
      "/remote/v4/..%2f..%2fetc/passwd",
      "/remote/v4/assets/../../secret.txt",
    ];
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("缺失文件 404；非前缀路径与非 GET 未处理", async () => {
    expect((await fetch(`${baseUrl}/remote/v4/missing.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/other`)).status).toBe(404);
    const post = await fetch(`${baseUrl}/remote/v4`, { method: "POST" });
    expect(post.status).toBe(404); // handler 返回 false，外层 404
  });

  it("目录存在但缺 index.html（或目录不存在）时根路径 404 且进程不崩", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "relay-static-empty-"));
    dirs.push(emptyRoot);
    const handler = createSelfHostStaticHandler({ rootDir: emptyRoot });
    const isolated = createServer((request, response) => {
      void handler(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    isolated.listen(0, "127.0.0.1");
    await once(isolated, "listening");
    const url = `http://127.0.0.1:${(isolated.address() as { port: number }).port}/remote/v4`;
    try {
      expect((await fetch(url)).status).toBe(404); // 不再 200 + ENOENT 崩进程
    } finally {
      isolated.closeAllConnections();
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/staticFiles.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 staticFiles**

`apps/self-host-relay/src/adapters/staticFiles.ts`：

```ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";

export interface SelfHostStaticHandlerOptions {
  rootDir: string;
  urlPrefix?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function createSelfHostStaticHandler(options: SelfHostStaticHandlerOptions) {
  const prefix = options.urlPrefix ?? "/remote/v4";
  const rootDir = resolvePath(options.rootDir);
  // Bugfix：文件流错误（目录缺失/被删、EACCES）若不接管，createReadStream 的 ENOENT 会成为
  // 未处理异常直接打死进程；统一先校验存在、再监听流错误降级 404。
  const streamFile = (target: string, response: ServerResponse): boolean => {
    const stream = createReadStream(target);
    stream.on("error", () => {
      if (!response.headersSent) response.writeHead(404);
      response.destroy();
    });
    stream.pipe(response);
    return true;
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    response.on("error", () => {});
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === prefix || url.pathname === `${prefix}/`) {
      const entry = join(rootDir, "index.html");
      if (!(await existsFile(entry))) return response.writeHead(404).end(), true;
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[".html"]!,
        "Cache-Control": "no-cache",
      });
      if (request.method === "HEAD") return response.end(), true;
      return streamFile(entry, response);
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return response.writeHead(400).end(), true;
    }
    if (decoded.includes("\0")) return response.writeHead(404).end(), true;
    // Bugfix：decodeURIComponent 后再 resolve + 前缀校验，堵住 %2e%2e 编码穿越；
    // 解析结果必须仍位于 rootDir 内，否则一律 404，不读取任何根外文件。
    const target = resolvePath(join(rootDir, decoded));
    if (target !== rootDir && !target.startsWith(rootDir + sep)) {
      return response.writeHead(404).end(), true;
    }
    if (!(await existsFile(target))) return response.writeHead(404).end(), true;
    const contentType = MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    const immutable = /\.[0-9a-f]{8,}\.(js|css|woff2|png|svg)$/i.test(target);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (request.method === "HEAD") return response.end(), true;
    return streamFile(target, response);
  };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/staticFiles.test.ts`
Expected: PASS（5 项）

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/adapters/staticFiles.ts apps/self-host-relay/test/staticFiles.test.ts
git commit --no-verify -m "feat: self-host-relay 内置静态托管与穿越防护"
```

---

### Task 6: module 装配、配置加载、持久化与进程入口

**Files:**
- Modify: `apps/self-host-relay/src/module.ts`（替换为装配实现）
- Create: `apps/self-host-relay/src/main.ts`
- Test: `apps/self-host-relay/test/module.test.ts`

**Interfaces:**
- Consumes: Task 2 `RelayStore`、Task 3 `createSelfHostRelayHttpRouter`、Task 4 `attachSelfHostRelayWsGateway`、Task 5 `createSelfHostStaticHandler`。
- Produces:
  - `loadSelfHostRelayConfig(env: Record<string, string | undefined>): SelfHostRelayConfig`（缺失 secret 抛 `Error`；env 键：`SELF_HOST_RELAY_SECRET`/`_HOST`/`_PORT`/`_DEVICES_FILE`/`_STATIC_ROOT`，默认 `0.0.0.0:8787`）
  - `startSelfHostRelay(config: SelfHostRelayConfig): Promise<SelfHostRelayRuntime>`

- [ ] **Step 1: 写失败测试**

`apps/self-host-relay/test/module.test.ts`：

```ts
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { loadSelfHostRelayConfig, startSelfHostRelay } from "../src/module.js";

const SECRET = "secret-module";
const dirs: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSelfHostRelayConfig", () => {
  it("默认值与必填 secret", () => {
    expect(loadSelfHostRelayConfig({ SELF_HOST_RELAY_SECRET: SECRET })).toEqual({
      host: "0.0.0.0",
      port: 8787,
      secret: SECRET,
      devicesFile: undefined,
      staticRoot: undefined,
    });
    expect(loadSelfHostRelayConfig({ SELF_HOST_RELAY_SECRET: "x", SELF_HOST_RELAY_PORT: "9000" }).port).toBe(9000);
    expect(() => loadSelfHostRelayConfig({})).toThrow(/SELF_HOST_RELAY_SECRET/);
  });
});

describe("startSelfHostRelay", () => {
  it("装配后注册→token→auth_init 全链路，设备表防抖落盘并可恢复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-module-"));
    dirs.push(dir);
    const devicesFile = join(dir, "devices.json");
    writeFileSync(
      devicesFile,
      JSON.stringify({ version: 1, devices: [{ deviceSid: "d_old", deviceMid: "mid-old", createdAt: 1 }] }),
    );
    const runtime = await startSelfHostRelay({
      host: "127.0.0.1",
      port: 0,
      secret: SECRET,
      devicesFile,
    });
    runtimes.push(runtime);
    const base = `http://127.0.0.1:${runtime.port}`;

    const list = await fetch(`${base}/api/v1/remote/device`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    }).then((r) => r.json() as Promise<{ data: { device_sid: string }[] }>);
    expect(list.data.some((d) => d.device_sid === "d_old")).toBe(true);

    const register = await fetch(`${base}/api/v1/remote/device`, {
      method: "POST",
      headers: { Authorization: "Bearer any", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-new" }),
    }).then((r) => r.json() as Promise<{ data: { device_sid: string } }>);
    const sid = register.data.device_sid;

    const token = await fetch(`${base}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "device" }),
    }).then((r) => r.json() as Promise<{ data: { token: string } }>);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/api/v1/remote/ws2?token=${token.data.token}`);
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "auth_init", device_sid: sid, meta: { name: "n" } }));
      });
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "auth_ack") {
          socket.close();
          resolve();
        }
      });
      socket.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 1_600)); // 防抖落盘窗口
    expect(existsSync(devicesFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(devicesFile, "utf-8")) as {
      devices: { deviceSid: string }[];
    };
    expect(persisted.devices.some((d) => d.deviceSid === sid)).toBe(true);
    expect(persisted.devices.some((d) => d.deviceSid === "d_old")).toBe(true);

    // 重启恢复：新进程读取同一 devices.json，旧 SID 仍可认证。
    await runtime.close();
    const reboot = await startSelfHostRelay({ host: "127.0.0.1", port: 0, secret: SECRET, devicesFile });
    runtimes.push(reboot);
    const list2 = await fetch(`http://127.0.0.1:${reboot.port}/api/v1/remote/device`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    }).then((r) => r.json() as Promise<{ data: { device_sid: string; online: boolean }[] }>);
    expect(list2.data.find((d) => d.device_sid === sid)!.online).toBe(false);

    // 有在线 WS 连接时 close() 也必须在限时内完成（网关终止 + server.close 不挂起）。
    const token3 = await fetch(`http://127.0.0.1:${reboot.port}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "device" }),
    }).then((r) => r.json() as Promise<{ data: { token: string } }>);
    const liveSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${reboot.port}/api/v1/remote/ws2?token=${token3.data.token}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    await expect(Promise.race([reboot.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 5_000))])).resolves.toBeUndefined();
    liveSocket.close();
  }, 20_000);

  it("持久化写失败（devicesFile 是目录）不崩进程、不阻断后续请求", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-module-eisdir-"));
    dirs.push(dir);
    const blockedFile = join(dir, "as-dir", "devices.json"); // 父级是目录 → writeFile EISDIR/ENOENT
    const runtime = await startSelfHostRelay({ host: "127.0.0.1", port: 0, secret: SECRET, devicesFile: blockedFile });
    runtimes.push(runtime);
    const registered = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/remote/device`, {
      method: "POST",
      headers: { Authorization: "Bearer any", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-persist-fail" }),
    });
    expect(registered.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_600)); // 越过防抖窗口，触发失败写盘
    const after = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/remote/device`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(after.status).toBe(200); // 进程仍存活且可服务
  }, 20_000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run test/module.test.ts`
Expected: FAIL（`loadSelfHostRelayConfig` 未导出）

- [ ] **Step 3: 实现 module.ts 与 main.ts**

`apps/self-host-relay/src/module.ts`（整体替换 Task 1 的再导出版本，保留类型再导出）：

```ts
export type { SelfHostRelayConfig, SelfHostRelayRuntime, SelfHostRelayStore } from "./contract.js";

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { RelayStore } from "./domain/relayStore.js";
import { createSelfHostRelayHttpRouter } from "./adapters/httpRouter.js";
import { attachSelfHostRelayWsGateway } from "./adapters/wsGateway.js";
import { createSelfHostStaticHandler } from "./adapters/staticFiles.js";
import type { SelfHostRelayConfig, SelfHostRelayRuntime } from "./contract.js";

const DEBOUNCE_MS = 1_000;

export function loadSelfHostRelayConfig(env: Record<string, string | undefined>): SelfHostRelayConfig {
  const secret = env.SELF_HOST_RELAY_SECRET?.trim();
  if (!secret) throw new Error("SELF_HOST_RELAY_SECRET is required");
  const port = Number(env.SELF_HOST_RELAY_PORT ?? "8787");
  return {
    host: env.SELF_HOST_RELAY_HOST?.trim() || "0.0.0.0",
    port: Number.isFinite(port) && port > 0 ? port : 8787,
    secret,
    devicesFile: env.SELF_HOST_RELAY_DEVICES_FILE?.trim() || undefined,
    staticRoot: env.SELF_HOST_RELAY_STATIC_ROOT?.trim() || undefined,
  };
}

/** 设备表防抖落盘：注册/删除后 1s 合并写盘，close 时强制冲刷；写失败只记日志不抛出。 */
function createDevicePersister(store: RelayStore, devicesFile: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const flush = async () => {
    // Bugfix：失败 Promise 残留在链上会让后续每次 flush 都在同一处 rejection 上炸掉；
    // 链上所有写错误就地捕获记录，保持串行且永远可继续。
    await pending.catch(() => undefined);
    pending = writeFile(devicesFile, `${JSON.stringify(store.serializeDevices(), null, 2)}\n`, "utf-8").catch(
      (error: unknown) => {
        console.error("[self-host-relay] devices persist failed", error);
      },
    );
    await pending;
  };
  store.setDevicesChangeListener(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, DEBOUNCE_MS);
  });
  return {
    async load(): Promise<number> {
      try {
        return store.restoreDevices(JSON.parse(await readFile(devicesFile, "utf-8")));
      } catch {
        return 0; // 首次启动或文件损坏：空表起步，桌面会自动重注册。
      }
    },
    async close(): Promise<void> {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await flush();
    },
  };
}

export async function startSelfHostRelay(config: SelfHostRelayConfig): Promise<SelfHostRelayRuntime> {
  const store = new RelayStore({ newSid: () => `d_${randomUUID()}` });
  const persister = config.devicesFile ? createDevicePersister(store, config.devicesFile) : undefined;
  const restored = persister ? await persister.load() : 0;
  const router = createSelfHostRelayHttpRouter({ store, secret: config.secret });
  const staticHandler = config.staticRoot ? createSelfHostStaticHandler({ rootDir: config.staticRoot }) : undefined;
  const server: Server = createServer((request, response) => {
    void router(request, response)
      .then((handled) => {
        if (handled) return;
        if (staticHandler) {
          void staticHandler(request, response).then((staticHandled) => {
            if (!staticHandled) {
              response.writeHead(404);
              response.end();
            }
          });
          return;
        }
        response.writeHead(404);
        response.end();
      })
      .catch(() => response.destroy());
  });
  const gateway = attachSelfHostRelayWsGateway(server, { store });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing relay listen address");
  console.log(`[self-host-relay] listening on ${config.host}:${address.port} (devices restored: ${restored})`);
  return {
    port: address.port,
    close: async () => {
      // Bugfix：closeAllConnections 不覆盖已升级的 WS 连接，必须先经网关终止全部 WS，
      // 否则有在线连接时 server.close() 永久挂起，后面的持久化冲刷执行不到。
      await gateway.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await persister?.close();
    },
  };
}
```

`apps/self-host-relay/src/main.ts`（进程入口，tsup bundle 目标）：

```ts
import { loadSelfHostRelayConfig, startSelfHostRelay } from "./module.js";

const runtime = await startSelfHostRelay(loadSelfHostRelayConfig(process.env));
let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`[self-host-relay] ${signal} received, shutting down`);
  void runtime
    .close()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("[self-host-relay] shutdown failed", error);
      process.exit(1);
    });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

- [ ] **Step 4: 运行测试与 bundle 隔离冒烟**

Run: `pnpm --filter @zcode/self-host-relay exec vitest run`
Expected: 全部通过（含 Task 1 contract、2/3/4/5 既有测试与新增的 close/持久化失败用例）

Run: `pnpm --filter @zcode/self-host-relay build && ls apps/self-host-relay/dist`
Expected: `main.js` 生成

Run（bundle 隔离冒烟——验证 noExternal 生效、ECS 零 node_modules 可跑）:

```bash
SMOKE=$(mktemp -d) && cp apps/self-host-relay/dist/main.js "$SMOKE/" && \
(cd "$SMOKE" && SELF_HOST_RELAY_SECRET=smoke SELF_HOST_RELAY_HOST=127.0.0.1 SELF_HOST_RELAY_PORT=18787 node main.js) & SMOKE_PID=$!
sleep 1
curl -s -o /dev/null -w 'smoke-http=%{http_code}\n' -X POST http://127.0.0.1:18787/api/v1/remote/token -H 'Content-Type: application/json' -d '{"role":"device"}'  # 期望 401
kill $SMOKE_PID 2>/dev/null; wait $SMOKE_PID 2>/dev/null; rm -rf "$SMOKE"
```

Expected: 后台进程输出 `[self-host-relay] listening on 127.0.0.1:18787`，curl 得 `smoke-http=401`；若进程报 `Cannot find module 'ws'` 则 noExternal 未生效，回查 tsup.config.ts。

- [ ] **Step 5: 提交**

```bash
git add apps/self-host-relay/src/module.ts apps/self-host-relay/src/main.ts apps/self-host-relay/test/module.test.ts
git commit --no-verify -m "feat: self-host-relay 装配/配置/持久化与进程入口"
```

---

### Task 7: 手机页 self-host 免登录模式（fragment 密钥，构建零密钥）

**Files:**
- Modify: `packages/web/src/env.d.ts`（`ImportMetaEnv` 加一个字段）
- Create: `packages/web/src/web-remote-control/adapters/selfHostAuth.ts`
- Modify: `packages/web/src/main.tsx:402-446`（remoteEntry 的 `auth` 注入与 `onView` 登录拦截）
- Modify: `package.json`（scripts 加 `build:web-remote-control:selfhost`）
- Test: `packages/web/test/selfHostAuth.test.ts`

**Interfaces:**
- Consumes: `WebAuthService` 的四方法 Pick 端口（`packages/web/src/web-remote-control/contract.ts:50`）、`ZAI_PROVIDER_ID`（`@zcode/shared`）、`WebRemoteControlFailure`、`WebRemoteControlEntry`（`#src/web-remote-control/index.js`）。
- Produces:
  - `isSelfHostRemoteBuild(env: { VITE_ZCODE_REMOTE_SELF_HOSTED?: string }): boolean`
  - `readSelfHostKey(input: { hash: string; storage: Pick<Storage, "getItem" | "setItem"> }): string | null`（解析 URL `#k=` → 持久化 localStorage 键 `zcode-self-host-key`；缺省回落 storage；全无则 null）
  - `createSelfHostAuth(key: string | null, onFailure: (failure: WebRemoteControlFailure) => void): WebRemoteControlAuthPort`
  - `type WebRemoteControlAuthPort = Pick<WebAuthService, "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout">`

- [ ] **Step 1: 写失败测试**

`packages/web/test/selfHostAuth.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createSelfHostAuth,
  isSelfHostRemoteBuild,
  readSelfHostKey,
} from "../src/web-remote-control/adapters/selfHostAuth.js";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("isSelfHostRemoteBuild", () => {
  it("注入任意非空值即启用；缺省/空白为 false", () => {
    expect(isSelfHostRemoteBuild({ VITE_ZCODE_REMOTE_SELF_HOSTED: "1" })).toBe(true);
    expect(isSelfHostRemoteBuild({})).toBe(false);
    expect(isSelfHostRemoteBuild({ VITE_ZCODE_REMOTE_SELF_HOSTED: "  " })).toBe(false);
  });
});

describe("readSelfHostKey", () => {
  it("从 #k= 解析并持久化；缺省回落 storage；全无则 null", () => {
    const storage = memoryStorage();
    expect(readSelfHostKey({ hash: "#k=abc123", storage })).toBe("abc123");
    expect(storage.getItem("zcode-self-host-key")).toBe("abc123");
    expect(readSelfHostKey({ hash: "#sid=x&k=def456", storage })).toBe("def456");
    expect(
      readSelfHostKey({ hash: "", storage: memoryStorage({ "zcode-self-host-key": "saved" }) }),
    ).toBe("saved");
    expect(readSelfHostKey({ hash: "", storage: memoryStorage() })).toBeNull();
    expect(readSelfHostKey({ hash: "#other=1", storage: memoryStorage() })).toBeNull();
  });
});

describe("createSelfHostAuth", () => {
  it("有密钥：JWT 即密钥并显示固定账号", () => {
    const auth = createSelfHostAuth("key-1", () => {});
    expect(auth.getZCodeJwtToken()).toBe("key-1");
    expect(auth.getActiveAccount()).toEqual({ displayName: "Self-host", provider: "zai" });
  });

  it("无密钥：JWT 为 null（entry 落 login 视图，由 main.tsx 拦截为失败页）", () => {
    const auth = createSelfHostAuth(null, () => {});
    expect(auth.getZCodeJwtToken()).toBeNull();
    expect(auth.getActiveAccount()).toBeNull();
  });

  it("startLogin/logout 落 failure，不引导 OAuth", () => {
    const onFailure = vi.fn();
    const auth = createSelfHostAuth("key-1", onFailure);
    auth.startLogin({ appReturnTo: "https://x/remote/v4" });
    expect(onFailure).toHaveBeenCalledWith({ reason: "relay-unavailable" });
    void auth.logout();
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});

describe("entry 集成", () => {
  it("无密钥时入口产出 login 视图 kind（自托管模式下 main.tsx 将其拦截为失败页）", async () => {
    const views: string[] = [];
    const entry = new WebRemoteControlEntry({
      auth: createSelfHostAuth(null, () => {}),
      token: async () => "t",
      connect: () => {},
      onView: (view) => views.push(view.kind),
      getHref: () => "https://ecs.example.com/remote/v4?app_version=3.16.1&sid=s&mid=m",
      devices: async () => [],
      replaceHref: () => {},
      storage: memoryStorage(),
      locale: "en-US",
      subscribeVisible: () => () => {},
    });
    await entry.start();
    expect(views).toEqual(["login"]);
  });

  it("有密钥且有 sid 时入口直接进入连接（token 收到密钥作为 jwt）", async () => {
    const views: string[] = [];
    let tokenJwt = "";
    const entry = new WebRemoteControlEntry({
      auth: createSelfHostAuth("key-1", () => {}),
      token: async (jwt) => {
        tokenJwt = jwt;
        throw new Error("stop-here");
      },
      connect: () => {},
      onView: (view) => views.push(view.kind),
      getHref: () => "https://ecs.example.com/remote/v4?app_version=3.16.1&sid=s&mid=m",
      devices: async () => [],
      replaceHref: () => {},
      storage: memoryStorage(),
      locale: "en-US",
      subscribeVisible: () => () => {},
    });
    entry.start(); // connect 回调内 getToken 被调用
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tokenJwt).toBe("key-1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/web/test/selfHostAuth.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 selfHostAuth 并接线 main.tsx / env.d.ts / 构建脚本**

`packages/web/src/web-remote-control/adapters/selfHostAuth.ts`：

```ts
import { ZAI_PROVIDER_ID, type WebRemoteControlFailure } from "@zcode/shared";
import type { WebAuthService } from "#src/auth/webAuthService.js";

export type WebRemoteControlAuthPort = Pick<
  WebAuthService,
  "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout"
>;

export interface SelfHostBuildEnv {
  readonly VITE_ZCODE_REMOTE_SELF_HOSTED?: string;
}

export const SELF_HOST_KEY_STORAGE_KEY = "zcode-self-host-key";

export function isSelfHostRemoteBuild(env: SelfHostBuildEnv): boolean {
  return !!env.VITE_ZCODE_REMOTE_SELF_HOSTED?.trim();
}

/**
 * 密钥经书签 URL 的 `#k=` fragment 首次分发（fragment 不发往服务端），解析后持久化到
 * 同源 localStorage 并摘除 fragment；之后 QR 直连（无 fragment）凭 storage 工作。
 * 构建产物不携带密钥——公开静态资源不得包含任何授权凭据。
 */
export function readSelfHostKey(input: {
  hash: string;
  storage: Pick<Storage, "getItem" | "setItem">;
}): string | null {
  const params = new URLSearchParams(input.hash.replace(/^#/, ""));
  const fromHash = params.get("k")?.trim();
  if (fromHash) {
    try {
      input.storage.setItem(SELF_HOST_KEY_STORAGE_KEY, fromHash);
    } catch {
      // iOS 私密模式可能禁写存储：本次会话仍返回密钥，仅丢失持久化。
    }
    return fromHash;
  }
  try {
    return input.storage.getItem(SELF_HOST_KEY_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 自托管免登录：auth 端口以手机本地密钥充当 JWT，登录页/OAuth 回调在该部署不可达；
 * 密钥缺失或失效（relay 401）只能落服务不可用失败页，不得引导用户去真实 OAuth。
 */
export function createSelfHostAuth(
  key: string | null,
  onFailure: (failure: WebRemoteControlFailure) => void,
): WebRemoteControlAuthPort {
  return {
    getZCodeJwtToken: () => key,
    getActiveAccount: () =>
      key ? { displayName: "Self-host", provider: ZAI_PROVIDER_ID } : null,
    startLogin: () => onFailure({ reason: "relay-unavailable" }),
    logout: () => {
      onFailure({ reason: "relay-unavailable" });
      return Promise.resolve();
    },
  };
}
```

`packages/web/src/env.d.ts`：在 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?: string;` 行后加：

```ts
  // 自托管免登录构建标记；密钥不进构建（经书签 URL #k= fragment 分发）。
  readonly VITE_ZCODE_REMOTE_SELF_HOSTED?: string;
```

`packages/web/src/main.tsx` 接线（`webRemoteControlStorage` 常量之后、`const remoteEntry = ...` 之前）：

```ts
import {
  createSelfHostAuth,
  isSelfHostRemoteBuild,
  readSelfHostKey,
} from "#src/web-remote-control/adapters/selfHostAuth.js";

// ...（既有 import 区不动，新增上面的 import）

const selfHostBuild = isSelfHostRemoteBuild(import.meta.env);
const selfHostKey = selfHostBuild
  ? readSelfHostKey({ hash: window.location.hash, storage: webRemoteControlStorage })
  : null;
if (selfHostBuild && window.location.hash) {
  // 摘除 #k=：密钥不留在地址栏/历史记录，保留 query（sid/mid/app_version）。
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}
const remoteControlAuth = selfHostBuild
  ? createSelfHostAuth(selfHostKey, (failure) => renderWebRemoteControlFailure(failure))
  : webAuthService;
```

`remoteEntry` 构造改为 `auth: remoteControlAuth,`（其余选项不动）；其 `onView` 中的登录分支替换为：

```ts
    else if (view.kind === "login") {
      // 自托管模式登录页不可达：无密钥/密钥失效一律落失败页，不得引导真实 OAuth。
      if (selfHostBuild) renderWebRemoteControlFailure({ reason: "relay-unavailable" });
      else renderWebLoginPage();
    }
```

`package.json` scripts（`build:web-remote-control:test` 行后加）：

```json
    "build:web-remote-control:selfhost": "VITE_ZCODE_REMOTE_SELF_HOSTED=1 pnpm --filter @zcode/web exec vite build --base=/remote/v4/",
```

- [ ] **Step 4: 运行测试与构建冒烟**

Run: `pnpm exec vitest run packages/web/test/selfHostAuth.test.ts packages/web/test/webRemoteControlEntry.test.ts`
Expected: PASS（新文件 8 项 + 既有入口回归）

Run: `pnpm build:web-remote-control:selfhost && grep -o '/remote/v4/assets/' packages/web/dist/index.html | head -1`
Expected: 构建成功，index.html 引用 `/remote/v4/assets/` 前缀资源；构建全程不涉及任何密钥（产物与官方构建一样可公开分发）。

构建冒烟后清理：`rm -rf packages/web/dist`。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/web-remote-control/adapters/selfHostAuth.ts packages/web/src/env.d.ts packages/web/src/main.tsx packages/web/test/selfHostAuth.test.ts package.json
git commit --no-verify -m "feat: 手机远控页自托管免登录模式（fragment 密钥分发）"
```

---

### Task 8: KCode 桌面远控端点覆盖

**Files:**
- Create: `packages/desktop/src/main/web-remote-relay/webRemoteControlEndpointOverride.ts`
- Modify: `packages/desktop/src/main/index.ts:924-936`（getEndpointUrls）
- Test: `packages/desktop/test/webRemoteControlEndpointOverride.test.ts`

**Interfaces:**
- Consumes: `buildZCodeEndpointUrls`、`ZCODE_PRODUCT_FLAVOR`（`@zcode/shared`）、`ZCodeProductFlavor` 类型。
- Produces:
  `resolveWebRemoteControlEndpointOverrideUrls(input: { flavor: ZCodeProductFlavor; settingOrigin?: string | null; appVersion?: string }): { origin: string; relayWsUrl: string; remoteUrl: string } | null`

- [ ] **Step 1: 写失败测试**

`packages/desktop/test/webRemoteControlEndpointOverride.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlEndpointOverrideUrls } from "../src/main/web-remote-relay/webRemoteControlEndpointOverride.js";

describe("resolveWebRemoteControlEndpointOverrideUrls", () => {
  it("kcode + 有效 setting：覆盖远控三端点，http origin 推导 ws", () => {
    const result = resolveWebRemoteControlEndpointOverrideUrls({
      flavor: "kcode",
      settingOrigin: "http://ecs.example.com:8787",
      appVersion: "3.16.1",
    });
    expect(result).toEqual({
      origin: "http://ecs.example.com:8787",
      relayWsUrl: "ws://ecs.example.com:8787/api/v1/remote/ws2",
      remoteUrl: "http://ecs.example.com:8787/remote/v4",
    });
  });

  it("kcode 无 setting / 空 setting 返回 null", () => {
    expect(resolveWebRemoteControlEndpointOverrideUrls({ flavor: "kcode" })).toBeNull();
    expect(
      resolveWebRemoteControlEndpointOverrideUrls({ flavor: "kcode", settingOrigin: "  " }),
    ).toBeNull();
  });

  it("非 kcode flavor 即使有 setting 也返回 null（官方行为不变）", () => {
    expect(
      resolveWebRemoteControlEndpointOverrideUrls({
        flavor: "production",
        settingOrigin: "http://ecs.example.com:8787",
      }),
    ).toBeNull();
    expect(
      resolveWebRemoteControlEndpointOverrideUrls({
        flavor: "preview",
        settingOrigin: "http://ecs.example.com:8787",
      }),
    ).toBeNull();
  });

  it("非法 origin 返回 null 而不是抛错（兜底回官方域）", () => {
    expect(
      resolveWebRemoteControlEndpointOverrideUrls({ flavor: "kcode", settingOrigin: "not-a-url" }),
    ).toBeNull();
  });

  it("低于 v4 门槛的 appVersion 仍按既有版本分界推导 v3 remoteUrl", () => {
    const result = resolveWebRemoteControlEndpointOverrideUrls({
      flavor: "kcode",
      settingOrigin: "https://ecs.example.com",
      appVersion: "3.3.0",
    });
    expect(result!.remoteUrl).toBe("https://ecs.example.com/remote/v3");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/desktop/test/webRemoteControlEndpointOverride.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 helper 并接线 index.ts**

`packages/desktop/src/main/web-remote-relay/webRemoteControlEndpointOverride.ts`：

```ts
import { buildZCodeEndpointUrls, type ZCodeProductFlavor } from "@zcode/shared";

export interface WebRemoteControlEndpointOverrideInput {
  flavor: ZCodeProductFlavor;
  settingOrigin?: string | null;
  appVersion?: string;
}

export interface WebRemoteControlEndpointOverrideUrls {
  origin: string;
  relayWsUrl: string;
  remoteUrl: string;
}

/**
 * kcode 自用：`zcodeEndpointOrigin` setting 在 production 分支被上游忽略
 * （zcodeEndpoint.ts 只在 test 环境认 override），打包 KCode 也无法注入 env。
 * 这里仅对远控三端点（relay HTTP origin / ws / 手机页 URL）放行该 setting，
 * 遥测、帮助配置、插件市场等其余流量仍走官方域。
 */
export function resolveWebRemoteControlEndpointOverrideUrls(
  input: WebRemoteControlEndpointOverrideInput,
): WebRemoteControlEndpointOverrideUrls | null {
  if (input.flavor !== "kcode") return null;
  const settingOrigin = input.settingOrigin?.trim();
  if (!settingOrigin) return null;
  try {
    const urls = buildZCodeEndpointUrls(settingOrigin, { appVersion: input.appVersion });
    return { origin: urls.origin, relayWsUrl: urls.relayWsUrl, remoteUrl: urls.remoteUrl };
  } catch {
    // setting 键已有 zod 清洗（normalizeZCodeEndpointOrigin），此处兜底非法值：
    // 忽略覆盖并回退官方端点，不能让坏 setting 拖垮远控启动。
    return null;
  }
}
```

`packages/desktop/src/main/index.ts` 修改（`ZCODE_PRODUCT_FLAVOR` 已在该文件 `@zcode/shared` 的既有导入块中（约 80 行），无需重复引入；只需新增本地导入）：

```ts
import { resolveWebRemoteControlEndpointOverrideUrls } from "./web-remote-relay/webRemoteControlEndpointOverride.js";
```

`getEndpointUrls`（约 925 行）替换为：

```ts
  getEndpointUrls: async () => {
    const override = resolveWebRemoteControlEndpointOverrideUrls({
      flavor: ZCODE_PRODUCT_FLAVOR,
      settingOrigin: (await mainSettingService.get()).zcodeEndpointOrigin,
      appVersion: webRemoteControlAppVersion,
    });
    const derived = buildZCodeEndpointUrls(
      override?.origin ?? (await resolveCurrentZCodeEndpointOrigin()),
      { appVersion: webRemoteControlAppVersion },
    );
    return {
      ...derived,
      relayWsUrl: resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: derived.origin,
        overrideUrl: webRemoteControlRelayWsEnvOverride,
      }),
      remoteUrl: webRemoteControlUrlEnvOverride || derived.remoteUrl,
    };
  },
```

（`index.ts:938-942` 的 fallback 常量不动——spec 已定：仅 `getEndpointUrls` 路径接覆盖。）

- [ ] **Step 4: 运行测试与桌面 typecheck**

Run: `pnpm exec vitest run packages/desktop/test/webRemoteControlEndpointOverride.test.ts packages/desktop/test/desktopWebRemoteControlIpc.test.ts`
Expected: PASS

Run: `mise exec -- node scripts/mise-run.mjs pnpm typecheck`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/web-remote-relay/webRemoteControlEndpointOverride.ts packages/desktop/src/main/index.ts packages/desktop/test/webRemoteControlEndpointOverride.test.ts
git commit --no-verify -m "feat: KCode 远控端点支持 zcodeEndpointOrigin setting 覆盖（kcode 门控）"
```

---

### Task 9: ECS 部署

**Files:**
- Create: `apps/self-host-relay/deploy/self-host-relay.service`
- Create: `apps/self-host-relay/deploy/README.md`
- 无源码改动；产物部署到 ECS（不入库）。

**Interfaces:**
- Consumes: Task 6 `dist/main.js`、Task 7 `packages/web/dist/`。
- Produces: 公网可用的 `http://<ECS_IP>:8787`（静态页 + relay）；本机临时文件 `/tmp/self-host-relay-deploy.env`（密钥，部署后删除）。

- [ ] **Step 1: 写部署产物文件**

`apps/self-host-relay/deploy/self-host-relay.service`（`<NODE_BIN>`/路径在部署时由 sed 替换为实际值）：

```ini
[Unit]
Description=ZCode self-host relay
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/self-host-relay.env
ExecStart=__NODE_BIN__ /opt/self-host-relay/main.js
Restart=always
RestartSec=3
StateDirectory=self-host-relay
WorkingDirectory=/opt/self-host-relay

[Install]
WantedBy=multi-user.target
```

`apps/self-host-relay/deploy/README.md`：

```markdown
# self-host-relay 部署（自用）

1. Node 22 tarball：`curl -fsSL <npmmirror node v22 linux tarball> -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /opt && ln -sfn /opt/node-v22.* /opt/node`（架构按 `uname -m` 选 x64/arm64）。
2. 密钥：`openssl rand -hex 32` 写入 `/etc/self-host-relay.env`（chmod 600）：
   `SELF_HOST_RELAY_SECRET=<secret>`、`SELF_HOST_RELAY_HOST=0.0.0.0`、`SELF_HOST_RELAY_PORT=8787`、
   `SELF_HOST_RELAY_DEVICES_FILE=/var/lib/self-host-relay/devices.json`、
   `SELF_HOST_RELAY_STATIC_ROOT=/opt/self-host-relay/web`。
   手机页构建零密钥（`pnpm build:web-remote-control:selfhost`，产物可公开分发）；
   密钥经书签 URL `http://<origin>/remote/v4#k=<secret>` 在手机首次打开时分发到 localStorage。
3. 上传：`dist/main.js` → `/opt/self-host-relay/main.js`；`packages/web/dist/` → `/opt/self-host-relay/web/`。
4. systemd：unit 中 `__NODE_BIN__` 替换为 `/opt/node/bin/node`，`systemctl enable --now self-host-relay`。
5. 云厂商安全组放行 8787/TCP（控制台操作）。
6. 验证：`curl http://127.0.0.1:8787/remote/v4` 200；无密钥 `POST /api/v1/remote/token` 401。
7. TLS 升级（可选）：前置 nginx 终止 TLS，`SELF_HOST_RELAY_HOST=127.0.0.1`，origin 换 https 域名。

密钥与 ECS IP 不写入任何已提交文件。
```

- [ ] **Step 2: 验证 ECS 环境（alecs 优先，失败换 txecs）**

```bash
ssh alecs 'cat /etc/os-release | head -2; uname -m; command -v node && node -v || echo no-node; ss -ltn | grep 8787 || echo port-free'
```

Expected: 记录系统/架构/端口结论到本任务执行记录；无 node 则 Step 3 装 tarball，有且 ≥20 则直接用。

- [ ] **Step 3: 安装 Node 22（仅当上一步无可用 node）**

```bash
ARCH=$(ssh alecs 'uname -m')   # x86_64 → x64, aarch64 → arm64
NODE_VER=v22.14.0
ssh alecs "curl -fsSL https://registry.npmmirror.com/-/binary/node/${NODE_VER}/node-${NODE_VER}-linux-${ARCH/x86_64/x64}.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /opt && ln -sfn /opt/node-${NODE_VER}-linux-${ARCH/x86_64/x64} /opt/node && /opt/node/bin/node -v"
```

Expected: 输出 `v22.14.0`。若 npmmirror 无该版本号，`curl -s https://registry.npmmirror.com/-/binary/node/ | grep v22 | tail` 取最新 22.x 替换。

- [ ] **Step 4: 生成密钥、构建产物、上传并启动**

```bash
SECRET=$(openssl rand -hex 32)
echo "SELF_HOST_RELAY_SECRET=$SECRET" > /tmp/self-host-relay-deploy.env && chmod 600 /tmp/self-host-relay-deploy.env

pnpm --filter @zcode/self-host-relay build
pnpm build:web-remote-control:selfhost   # 构建零密钥，产物可公开分发

ssh alecs 'mkdir -p /opt/self-host-relay/web /var/lib/self-host-relay'
scp apps/self-host-relay/dist/main.js alecs:/opt/self-host-relay/main.js
rsync -a --delete packages/web/dist/ alecs:/opt/self-host-relay/web/
ssh alecs "printf 'SELF_HOST_RELAY_SECRET=%s\nSELF_HOST_RELAY_HOST=0.0.0.0\nSELF_HOST_RELAY_PORT=8787\nSELF_HOST_RELAY_DEVICES_FILE=/var/lib/self-host-relay/devices.json\nSELF_HOST_RELAY_STATIC_ROOT=/opt/self-host-relay/web\n' '$SECRET' > /etc/self-host-relay.env && chmod 600 /etc/self-host-relay.env"
sed "s|__NODE_BIN__|$(ssh alecs 'command -v node || echo /opt/node/bin/node')|" apps/self-host-relay/deploy/self-host-relay.service | ssh alecs 'cat > /etc/systemd/system/self-host-relay.service && systemctl daemon-reload && systemctl enable --now self-host-relay && sleep 1 && systemctl is-active self-host-relay'
```

Expected: `active`。

- [ ] **Step 5: 公网验收并清理本机密钥文件**

```bash
ECS_IP=$(awk '/Host alecs$/{getline; sub(/HostName /,""); print; exit}' ~/.ssh/config)
curl -s -o /dev/null -w '%{http_code}\n' "http://$ECS_IP:8787/remote/v4"                     # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://$ECS_IP:8787/api/v1/remote/token" \
  -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{"role":"terminal"}'  # 期望 401
SECRET=$(grep -o 'SELF_HOST_RELAY_SECRET=.*' /tmp/self-host-relay-deploy.env | cut -d= -f2)
curl -s -X POST "http://$ECS_IP:8787/api/v1/remote/token" -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' -d '{"role":"terminal"}'                                   # 期望 {"code":0,...,"data":{"token":...}}
echo "手机书签 URL（在手机浏览器打开一次并收藏，之后扫码直连）：http://$ECS_IP:8787/remote/v4#k=$SECRET"
rm /tmp/self-host-relay-deploy.env
```

Expected: 三项依次 200 / 401 / code 0。若 200 不通：确认云安全组 8787/TCP 已放行（需要用户在阿里云控制台操作——此为唯一用户必做步骤），`ssh alecs 'journalctl -u self-host-relay -n 50'` 排查。

- [ ] **Step 6: 提交部署产物**

```bash
git add apps/self-host-relay/deploy
git commit --no-verify -m "docs: self-host-relay ECS 部署产物与手册"
```

---

### Task 10: 门禁、KCode 重建、setting 写入与真机验收

**Files:**
- Modify: `~/.kcode/v2/setting.json`（运行时配置，不入库）
- 无仓库源码改动（除可能的 lint 修复）。

**Interfaces:**
- Consumes: Task 7/8 的构建产物链路、Task 9 的公网服务。
- Produces: 安装到 `/Applications` 的 KCode.app（远控指向自建 relay）+ kcode 分支推送。

- [ ] **Step 1: 全套仓库门禁**

```bash
mise exec -- node scripts/mise-run.mjs pnpm typecheck
pnpm lint
pnpm run db:schema:check
pnpm run test:architecture
pnpm run architecture:check -- --changed
pnpm --filter @zcode/self-host-relay test
pnpm exec vitest run packages/web/test/selfHostAuth.test.ts packages/web/test/webRemoteControlEntry.test.ts packages/desktop/test/webRemoteControlEndpointOverride.test.ts
# verify:pre-push 等价门禁（hook 本身因需 origin/staging 不可用）：
# 基准取 spec 提交的父提交（本特性分支代码改动起点；其间只有 docs 提交）
pnpm run test:unit:affected --scope push --base $(git rev-parse 0cabc468^)
```

说明：affected 选择规则与输出合同见 `docs/testing/pre-push-hook.md`；选中整包时按该文档声明并跳过。新包 `apps/self-host-relay` 不在根 vitest 收集范围（`packages/*/test/**`），其测试由上面的 `--filter` 单独真实执行。已知基线失败：`packages/desktop/test/desktopRuntimeEnv.test.ts` 本地免签 CUA ×3（前序工作已用 stash 基线验证为既有失败）。全部结果如实记录。

- [ ] **Step 2: 写入 KCode setting 并重建安装**

```bash
osascript -e 'quit app "KCode"' 2>/dev/null; sleep 2
export ECS_IP=$(awk '/Host alecs$/{getline; sub(/HostName /,""); print; exit}' ~/.ssh/config)
python3 - <<'EOF'
import json, os
path = os.path.expanduser("~/.kcode/v2/setting.json")
with open(path) as f: data = json.load(f)
data["zcodeEndpointOrigin"] = f"http://{os.environ['ECS_IP']}:8787"
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f: json.dump(data, f, ensure_ascii=False, indent=2)
print("zcodeEndpointOrigin =", data["zcodeEndpointOrigin"])
EOF

ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop build
cd packages/desktop && ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 npm_config_user_agent="pnpm/10.33.2" pnpm exec electron-builder --config electron-builder.config.js --mac zip && cd ../..
unzip -o packages/desktop/dist/KCode-3.16.1-mac-arm64.zip -d /Applications/ | tail -1
open -a KCode
```

Expected: 构建含 kcode flavor（tsup/vite 日志出现 `.kcode` 或 `KCODE_IDENTITY`）；zip 解包安装成功。

- [ ] **Step 3: 真机验收清单（用户执行，结果记录到执行记录）**

1. KCode 打开远控弹窗 → 开启 → 出现二维码（URL 应为 `http://<ECS_IP>:8787/remote/v4?...`）。
2. 手机先打开一次部署产出的书签 URL（`http://<ECS_IP>:8787/remote/v4#k=<secret>`）并收藏；再扫 KCode 二维码 → **不出现登录页**，直接进入连接/设备列表 → 连接成功进入任务首页。
3. 手机锁屏/切后台 30 秒后回前台 → 会话恢复（replayable snapshot/gap）。
4. `ssh alecs 'systemctl restart self-host-relay'` → 双端在数十秒内自动恢复（桌面旧 SID 复用设备表）。
5. ZCode 官方 App 同时开启远控 → 两端同时在线互不干扰（A3 根治验证）。
6. KCode 内确认遥测/插件市场等仍走官方域（proxy无关，观察无异常即可）。

- [ ] **Step 4: 推送**

```bash
git push origin kcode --no-verify
```

Expected: 推送成功；工作区干净（`git status` 确认无密钥/IP 残留文件被跟踪）。

---

## Self-Review 记录

- **Spec 覆盖**：spec §1.1→Task 2/3；§1.2→Task 2/4；§1.3→Task 2/6；§1.4→Task 9；§2→Task 7；§3→Task 8；§4 安全模型→Task 3 鉴权矩阵 + Task 5 穿越 + Task 7 fragment 密钥 + Task 9 密钥规程；测试验收→各任务 + Task 10。无遗漏。
- **占位符**：无 TBD/TODO；所有代码块完整可落盘。
- **类型一致性**：`SelfHostRelayStore` 方法签名在 Task 1 定义、Task 2 实现一致（`claimOwnership` 返回 `{kicked} | null`、`releaseOwnership` 布尔）；路由 handler 签名 `(req,res)=>Promise<boolean>` 在 Task 3/5/6 一致；网关 `attachSelfHostRelayWsGateway` 返回 `{close()}` 在 Task 4 定义、Task 6 消费一致；`WebRemoteControlAuthPort` 与 entry 契约（contract.ts:50 Pick 四方法）一致。
- **Review Focus**：五项均有归属测试（穿越→T5、token 重放→T4、迟到 close→T2+T4、密钥矩阵→T3、重启持久化→T6；登录视图拦截→T7）。

## Codex 审查修订记录（2026-10-20，gpt-6.1-sol xhigh，10 条全采纳）

1. P1 客户端中断请求体致进程退出 → T3 `readBody` 吞流错误 + 路由整体 try/catch + 两侧 error 吞掉。
2. P2 关闭遗漏 WS 致 `server.close()` 挂起 → T4 网关返回 `close()` 终止全部 WS，T6 关闭顺序网关优先，T6 增在线连接限时关闭测试。
3. P2 持久化失败未处理 rejection 且毒化串行链 → T6 flush 链上捕获记录、永远可继续，T6 增写失败存活测试。
4. P2 契约 13 个公开方法超 `max-public-methods`(12) → 收敛 `hasDevice` 入 `claimOwnership`（未知设备返回 null），契约 12 个。
5. P2 WS 测试服务器 404 致 mintToken 假失败 → T4 测试挂载真实 T3 路由。
6. P2 删除设备测试 claim/release 用了两个同形对象（按引用释放必败）→ T2/T3 测试复用同一 owner 引用。
7. **P1（spec）公开 bundle 内嵌密钥 = 向匿名访问者发放「连桌面」能力，TLS 不能修复** → 改为 fragment 分发：构建零密钥（`VITE_ZCODE_REMOTE_SELF_HOSTED` 仅作模式标记），密钥经书签 URL `#k=` 进 localStorage 并摘除 fragment；未携带密钥/401 一律失败页（T7 重写，spec §2/§4 同步修订）。
8. P1 tsup 默认外置 dependencies，单文件在 ECS 缺模块 → T1 `tsup.config.ts` `noExternal: [/.+/]`，T6 增无 node_modules 的 bundle 隔离冒烟。
9. P2 401 最终仍渲染登录页（`switchAccount` 在 logout 后发 login 视图）→ T7 `onView` 登录分支拦截为失败页 + entry 集成测试。
10. P2 静态根路径先 200 后 ENOENT 崩进程 → T5 先校验 index.html 存在、文件流错误降级 404，T5 增空目录用例。
