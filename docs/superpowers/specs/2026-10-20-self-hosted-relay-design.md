# 自托管 Relay 与免登录手机远控设计（self-hosted-relay）

- 日期：2026-10-20
- 分支：kcode（自用 fork，不分发）
- 状态：已批准方案 A，待 spec 审阅
- 前置：kcode flavor 共存（95522e85）与 `~/.kcode` 全量隔离（fff5c8ee）

## 背景

新版手机远控（Relay V2）要求手机浏览器先完成账号 OAuth 登录：入口门禁在
`packages/web/src/web-remote-control/app/webRemoteControlEntry.ts:84`（无 JWT 渲染登录页），
且 JWT 是 relay 协议的鉴权凭据——`POST /api/v1/remote/token` 必须
`Authorization: Bearer <jwt>` 才能换一次性 token 建 WebSocket，设备列表也按 JWT 账号隔离。
官方 relay（`zcode.z.ai`，私有 Go 仓库 zcode-server）不受本仓库控制，因此
「保留官方 relay、客户端单方面去掉登录」不可行。

去掉登录的唯一路径是把 relay 收归自托管：本仓库已有完整 wire 契约
（`docs/web-remote-control/relay-v2-pairing.md`、`packages/shared/src/web-remote-relay/`）
与测试假 relay 实现（`packages/shared/test/fixtures/fake-relay-v2.ts`，真实 loopback
HTTP/WS），照契约实现单用户 relay 即可；手机端 HTTP/WS 地址全部从
`window.location.origin` 推导（`packages/web/src/main.tsx:413/422/1044`），天然支持自托管。

## 目标

1. 手机扫码/打开链接即连，免账号登录（登录页在该部署中不可达）。
2. relay server 自托管到用户 ECS（`alecs` 39.105.89.226，阿里云；备选 `txecs` 49.233.130.208，
   腾讯云；实现前先 ssh 验证环境）。
3. 官方 ZCode.app 与官方链路行为零变化；kcode 分支外观上仅新增自用能力。
4. KCode + ZCode 双端远控同时在线（各自 relay，根治互踢）。

## 非目标

- 不做多用户、多实例、Redis owner TTL、网关 mid 路由（单实例单用户足够自用）。
- 不修改 `@zcode/shared/web-remote-relay` wire 契约与双端 transport 状态机。
- 不改动官方手机页部署（OSS 版本目录、官方 OAuth 回调白名单）。
- TLS 终态不在本期：起步 IP + 高位端口 http；升级（域名 + Let's Encrypt 或
  Cloudflare Tunnel）只改 nginx 与 KCode setting，不改代码。

## 方案总览

```text
手机（免登录）                自建 ECS（单 origin，默认 http://IP:8787）         KCode 桌面
  扫码/书签打开 ── GET /remote/v4（self-host 构建；密钥经书签 URL `#k=` 首次注入 localStorage）
                          │ self-host-relay（Node, systemd：静态页 + relay + 限流，单进程）
                          │◄── POST /device（Bearer=真实 OAuth JWT，任意 bearer 即可）  注册 sid
                          │◄── POST /token(device) + ws2 + auth_init(sid, meta)
  POST /token(terminal) ──►│（Bearer=密钥，仅此端点与 GET /device 要求密钥）
  ◄─ ws2(token) → auth_init(sid) → matched ──► device 收 pair_status_ack(matched)
  └───────────── 既有 bootstrap / workspace bridge / rpc-frame（零改动）──────────────┘
```

三块改动：

| 组件 | 位置 | 改动 |
| ---- | ---- | ---- |
| relay server | 新包 `apps/self-host-relay`（新受管模块） | 单实例单用户 Node 服务，复用 shared 契约解析 |
| 手机页 | `packages/web`（受管模块内新增 adapter + 构建脚本） | 构建期 self-host 模式：stub auth 免登录 |
| KCode 桌面 | `packages/desktop/src/main/web-remote-relay`（受管模块内） | kcode 门控的远控端点覆盖，来源 setting |

## 详细设计

### 1. relay server（apps/self-host-relay）

新 workspace 包（`pnpm-workspace.yaml` 增加 `apps/self-host-relay`），依赖 `ws` 与
`@zcode/shared`（仅 `web-remote-relay` 子路径的解析器/常量）。用
`pnpm architecture:adopt self-host-relay --root apps/self-host-relay/src` 注册受管模块，
按 contract/domain/app/adapters 分层：

- `contract.ts`：复用/重导出 shared wire 类型与 HTTP 信封类型；声明服务配置类型
  （`{listenHost, listenPort, secret, devicesFile}`）。
- `domain/`（纯函数）：设备表/一次性 token 表/连接 owner 表的状态迁移——注册生成新 SID、
  token 签发与原子消费判定、`(sid, role)` owner 替换、断开通知决策。不持有定时器与 IO。
- `adapters/`：Node `http` + `ws` 服务器（HTTP 4 端点 + ws2 升级）、设备表 JSON 文件持久化。
- `module.ts`：装配入口；`app/` 层编排（鉴权策略、消息路由）。
- tsup 打成单文件 bundle 部署到 ECS，systemd 常驻。

#### 1.1 HTTP 契约（严格按 relay-v2-pairing.md）

成功信封 `{code: 0, msg, data}`；失败 `{code: 非零, msg}`，参数非法返回 HTTP 400 +
`code: 3001`；删除在线设备 HTTP 400 + `code: 3005`；删除不存在的 SID 幂等成功。

| 端点 | Bearer 要求 | 行为 |
| ---- | ---- | ---- |
| `POST /api/v1/remote/device` `{device_mid}` | 任意非空 | 校验 device_mid 非空白 ≤128 字符；同 MID 每次注册产生新 SID（16 随机字节 base64url）；记录 `{device_sid, device_mid, online, created_at, meta:{}}` |
| `GET /api/v1/remote/device` | **必须等于密钥** | 返回全部设备记录（单用户）；在线设备 `meta` 取自 device 连接的 `auth_init.meta`，离线为 `{}` |
| `POST /api/v1/remote/device/delete` `{device_sid}` | 任意非空 | 仅允许删除离线设备（在线返回 3005）；SID 不可猜测即天然防滥用 |
| `POST /api/v1/remote/token` `{role}` | `role=terminal` **必须等于密钥**；`role=device` 任意非空 | 签发 22 字符 base64url 一次性 token（16 随机字节，无填充），有效期 60 秒，绑定角色；响应带 `Cache-Control: no-store` |

密钥错误/缺失返回 HTTP 401（手机端映射 auth-required；正常部署下密钥正确不会触达）。
所有 bearer 映射到固定单用户 `self`；设备表、token 表按该用户隔离（无跨用户分支）。
内置每 IP 限流（20 req/s，超出返回 429，防注册端点被刷爆设备表）；无 CORS 头
（同源部署 + 桌面 main 进程调用均不需要）。

#### 1.2 WebSocket 契约

入口 `/api/v1/remote/ws2?token=...`（忽略 `mid` 路由提示——单实例）。缺失/无效/过期/
已消费 token 在升级前返回 401；消费必须原子（升级成功即从表中移除，重连重新申请）。
只接受 JSON 文本，单消息最大 1 MiB。时间戳为 Unix 秒（拒绝毫秒值），不参与授权。

- `auth_init{device_sid, meta?, client_ts?}`：`device_sid` 非空白 ≤128 UTF-8 字节。
  - device 角色：未知 SID 返回 `AUTH_FAILED`（桌面 transport 既有「同次启动最多重注册一次」
    语义会重注册）。成功后进入 `waiting`，记录 meta（name/platform/version）。
  - terminal 角色：SID 未知 → `AUTH_FAILED`（手机映射 device-not-owned）；SID 已知但
    device 不在线 → `auth_ack(waiting)`（与假 relay 行为一致，手机停在「等待桌面端配对」
    阶段继续心跳，桌面上线即 matched）。`DEVICE_OFFLINE` 仅用于已配对会话中 device 断开。
  - 重复认证或未认证发 data/query → `WRONG_PARAM` 并关闭。
- 同 `(sid, role)` 新连接替换旧 owner：旧连接收 `KICKED` 后关闭；异步 close 不得移除新 owner。
- `pair_status_query{client_ts?}` → `pair_status_ack{terminal_sid, pair_status, server_ts}`
  （terminal_sid 按契约：device 查询问对端 terminal SID，terminal 查询为空）。
- `data{payload, client_ts?}` → 仅在双方已认证且 `matched` 时转发给同 SID 另一角色，
  附 `server_ts`；不读取 payload 内容。
- 断开：device 断开 → terminal 收 `pair_status_ack(waiting)` 推送与 `DEVICE_OFFLINE` 后关闭；
  terminal 断开 → device 仅收 `waiting` 推送。
- 错误码仅 `AUTH_FAILED | WRONG_PARAM | KICKED | INTERNAL | DEVICE_OFFLINE`。
- 不加服务端协议 ping：双端客户端 5s±1s 的 `pair_status_query` 心跳已提供持续流量与
  半开检测（15s watchdog），蜂窝 NAT 保活足够。

#### 1.3 状态与持久化

- 内存态：一次性 token 表、连接表、`(sid, role)` owner 表（重启即清，安全）。
- 文件持久化：设备表（sid/mid/created_at）写 `devices.json`（防抖落盘）。重启后设备记录
  保留、在线位清零——桌面用存储中的旧 SID 重连 `auth_init` 直接成功，手机记忆的 SID 仍有效，
  relay 重启对双端透明；无需数据库。
- 桌面端 re-register 走既有路径（身份/端点变化时尽力删除旧 SID，失败不阻塞）。

#### 1.4 部署

- ECS（默认 `alecs`，实现前先验证两台的系统版本、Node 可用性与端口连通性；结论记入实现记录）。
- **默认形态：单进程直连，无 nginx。** relay 服务自身提供可选静态目录托管
  （`/remote/v4` 前缀 → 手机页构建产物，含路径穿越防护与 `index.html` 回退），与
  HTTP/WS 同 origin 同端口（默认 `0.0.0.0:8787`，http）。手机 URL 即
  `http://<ECS-IP>:8787/remote/v4`。
- 进程：tsup 单文件 bundle（`noExternal` 打入 `ws` 与 `@zcode/shared`，ECS 零
  node_modules）+ `self-host-relay.service`（systemd，`EnvironmentFile` 注入
  `SELF_HOST_RELAY_SECRET` 等配置；密钥 `openssl rand -hex 32` 生成，只存 ECS env 文件与
  手机 localStorage，不入库、不入日志、不进任何公开资源）。部署产出书签 URL
  `http://<origin>/remote/v4#k=<secret>` 供手机首次打开。
- 升级 TLS（域名 + certbot 或 cloudflared tunnel）时在前面引入 nginx 做终止/静态/反代，
  relay 退回 `127.0.0.1` 监听：仅改部署配置与 KCode setting 的 origin，代码与 bundle 不动。

### 2. 手机页 self-host 模式（packages/web）

- 构建期注入 `VITE_ZCODE_REMOTE_SELF_HOSTED=1`（存在即启用）；根 `package.json` 新增
  `build:web-remote-control:selfhost`（`vite build --base=/remote/v4/`）。**构建产物不携带
  任何密钥**——密钥经部署产出的书签 URL `http://<origin>/remote/v4#k=<secret>` 首次分发：
  页面解析 `#k=` 后写入同源 localStorage（`zcode-self-host-key`）并用 `replaceState` 摘除
  fragment（fragment 不发送到服务端）。未注入 env 时产物与现状等价，官方部署不受影响。
- `packages/web/src/web-remote-control/adapters/` 新增 `selfHostAuth.ts`：实现与
  `WebAuthService` 相同的 auth 端口——`getZCodeJwtToken() → localStorage 密钥（缺失为
  null）`、`getActiveAccount() → {displayName: "Self-host"}`、
  `startLogin()/logout()` 渲染 reason 为 `relay-unavailable` 的失败页。
- 登录页在该模式不可达：`main.tsx` 的 `onView` 拦截 `kind: "login"`，未携带/失效密钥、
  relay 401（`switchAccount` 的 `logout` + 登录视图）一律渲染 `relay-unavailable` 失败页。
  手机首次使用需打开一次带 `#k=` 的书签 URL；此后 QR 直连（无 fragment）凭 localStorage
  密钥工作，私密模式丢存储则重开书签。
- `main.tsx` 构造 `WebRemoteControlEntry` 时按 env 选择 stub 或既有 `webAuthService`；
  登录页、OAuth 回调（`isWebRemoteControlOAuthCallback` 需要 `code/state`，扫码链接不带）、
  切换账号弹窗在该模式下不可达。
- 版本守卫（`webRemoteControlVersion.ts`）为纯客户端逻辑，无 OSS 运行时依赖；
  KCode 3.16.1 > v4 门槛 3.4.0，无兼容问题。
- relay 内置静态服务托管 `/remote/v4` 与 `/remote/v4/assets/`（同一 `index.html` +
  hash 资源，目录不存在该前缀 404）。

### 3. KCode 桌面端点覆盖（packages/desktop）

现状（已核实）：production 环境 `resolveZCodeEndpointOrigin` 忽略 setting 覆盖
（`packages/shared/src/zcodeEndpoint.ts:185-188`）；打包态 env 注入仅 OTLP 键
（`packages/desktop/src/main/desktopRuntimeEnv.ts:171-173`）——打包 KCode 无法纯配置改端点。

改动（全部落在受管模块 `desktop-web-remote-relay` 内）：

- 新增纯函数 `resolveWebRemoteControlEndpointOverrideUrls(options)`：
  `flavor === "kcode" && setting.zcodeEndpointOrigin` 存在时，以该 origin 构建
  `{origin, relayWsUrl, remoteUrl}`（复用 `buildZCodeEndpointUrls` + `resolveWebRemoteControlRelayWsUrl`）。
- `packages/desktop/src/main/index.ts:925-936` 的 `getEndpointUrls` 接入该函数：仅覆盖
  远控三端点；`apiBaseUrl`、遥测、帮助配置、插件市场等其余流量仍走官方域。
  模块加载期的 fallback 常量（`index.ts:938-942`）保持不动——它们只在
  `getEndpointUrls` 不可用时兜底，主进程恒注入该回调，属死路径默认值。
- 优先级：`ZCODE_WEB_REMOTE_CONTROL_URL` / `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` env
  覆盖（既有开发调试口）> setting 覆盖 > 默认官方域。
- setting 键复用 `zcodeEndpointOrigin`（已有 zod 校验，`normalizeZCodeEndpointOrigin` 接受
  http/https，`http://IP:端口` 合法）；用户在 `~/.kcode/v2/setting.json` 写入即生效，
  改 ECS 只改这一个值。非 kcode flavor（production/preview）行为不变。
- 桌面 App 自身登录门禁不变（KCode 本来就需要登录使用模型；被去除的只是手机端登录）。

### 4. 安全模型

- 能力最小化：`GET /device`（泄露 SID）与 `POST /token role=terminal`（可连桌面）是仅有的
  两个敏感能力，均要求密钥；注册与 device token 接受任意 bearer——攻击者最多注册垃圾设备，
  拿不到你的 SID（不可猜测、列表有密钥），无法以 terminal 身份连你的桌面。
- **密钥不进入任何公开资源**：构建产物零密钥；密钥只存 ECS env 文件与手机 localStorage，
  经书签 URL fragment 一次性分发（fragment 不发往服务端）。匿名访问者只能得到一个连不上的
  页面（登录视图被拦截为失败页）。SID 构成二次能力凭据。
- http 起步的风险明示：明文 http 下页面完整性可被链路篡改（注入脚本可窃取 localStorage
  密钥），业务消息（会话内容含代码）同样明文；自用接受此风险并保留 TLS 升级路径（见 1.4，
  域名 + certbot 或 cloudflared tunnel，只改部署配置与 origin）。relay 不落任何业务数据
  （透传 + 内存连接表），符合「外部 relay 不保存任务队列/快照」的仓库边界。
- 日志：relay 仅记录连接生命周期与错误码，不记录 token/密钥/消息内容（遵守 AGENTS.md 凭据规则）。

## 事件顺序与 owner

```text
设备表/在线事实 owner：self-host-relay（唯一）
一次性 token owner：self-host-relay（签发→升级前原子消费）
连接与 (sid, role) owner：self-host-relay（替换发 KICKED）
桌面 device 身份持久化 owner：desktop manager（deviceStorage，既有）
手机最近设备偏好 owner：手机 localStorage（既有，仅展示偏好）
业务状态（task/session/stream）：完全不在 relay，桌面 Host 与既有 owner 不变

注册：desktop JWT(任意 bearer) → POST /device → 新 sid → 落盘 devices.json
建连：POST /token → ws2 升级原子消费 → auth_init → owner 登记/替换(KICKED)
配对：terminal auth_init(在线 sid) → 双方 matched → data 双向透传
重启：内存态清空 → 设备表从 devices.json 恢复 → 双端旧 SID 重连成功（透明）
```

## 测试与验收

- relay 单测（Node，参照 fake-relay 测试模式与 shared 契约样例）：注册/列表/删除、
  参数校验与 3001/3005、密钥端点 401、一次性 token 签发/过期/重复消费、ws2 无 token 401、
  auth_init 各分支（未知 SID/离线/在线）、KICKED 替换与旧 close、断开通知方向性、
  data 透传与未认证拒绝、重启后设备表恢复。
- 手机页单测：self-host 模式（注入接缝复用 `webRemoteControlEntry.test.ts`
  既有模式）——`#k=` 解析/持久化/摘除、无密钥与 401 均落失败页且登录视图不可达、
  token 请求携带密钥 bearer、构建产物不含密钥。
- 桌面单测：`resolveWebRemoteControlEndpointOverrideUrls`——kcode+setting 覆盖、
  kcode 无 setting 默认、非 kcode+setting 不覆盖、env 覆盖优先。
- 构建验收：`build:web-remote-control:selfhost` 产物由本地 relay 进程静态托管冒烟可打开。
- 真机验收（用户执行，记录到实现记录）：手机扫码免登录直连；杀后台/锁屏恢复（replayable）；
  relay 重启后双端自动恢复；KCode（自建 relay）与 ZCode（官方 relay）双端远控同时在线。
- 仓库门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、
  affected 单测（`ZCODE_AFFECTED_TEST_BASE=<sha>`）。

## 开放决策记录

- TLS/域名未获用户答复（本轮提问未回）：默认按 IP + 高位端口 http 起步，设计保留
  仅改配置的 TLS 升级路径；若后续提供备案域名或选择 Cloudflare Tunnel，无代码变更。
- ECS 选型默认 `alecs`，实现时实测两台环境后定稿，结论记录在实现记录中。

## 追记 2026-10-20（二）：QR / 复制链接直连（密钥随链接分发）

### 背景

原设计密钥首次分发依赖"手动书签"：手机先打开带 `#k=` 的 URL 存密钥，之后才能扫码/直连。实测两步不便，用户预期对齐官方体验：**扫二维码或复制链接打开即进入控制页**。

### 决策

1. **密钥进入桌面**：新增 kcode 专属 setting `zcodeRelaySelfHostKey`（与 `zcodeEndpointOrigin` 同级，`~/.kcode/v2/setting.json`；`validationAppSettings` 注册 zod 清洗：trim、空值/非法值整键丢弃，模式同 `zcodeEndpointOrigin`）。无设置 UI，与 origin 一致经文件配置。
2. **密钥进入链接**：shared `buildWebRemoteControlExternalQrUrl` 新增可选参数 `selfHostKey`；非空时 `url.hash = "k=" + encodeURIComponent(key)`（fragment 不发往服务端）。桌面 manager 中 `qrUrl === connectUrl` 是同一字符串，一处注入，二维码与"复制链接"同时生效。
3. **门控（纯函数，desktop `web-remote-relay` 模块）**：`resolveWebRemoteControlSelfHostQrKey({flavor, settingOrigin, settingKey, finalRemoteUrl, appVersion})` 仅当 ① `ZCODE_PRODUCT_FLAVOR === "kcode"`、② setting origin 可解析、③ **最终手机页 URL（含 `ZCODE_WEB_REMOTE_CONTROL_URL` 等 env 覆盖后）的 origin === 自建 origin**、④ key 非空——全部成立才返回 key。门控落在最终 URL 而非配置快照：任何覆盖把手机页指向其它域时密钥一律不注入，防止密钥泄进官方域二维码（含跨域 env 覆盖组合）。
4. **手机页 / relay 零改动**：`readSelfHostKey` 已解析 `#k=` → localStorage → `replaceState` 摘除 fragment（query 的 sid/mid/name 配对参数不受影响）。

### 安全模型影响

QR / 复制链接成为主密钥载体——与原书签 URL **同一暴露面、同一信任级**（持有链接即 terminal）。二维码仅在远控弹窗打开期间渲染；setting 文件在单用户机器上明文存密钥（与 `~/.ssh` 私钥同级风险）。不进日志（manager 无 qrUrl/connectUrl 日志输出，实现时保持）。production/preview 构建零变化（无 setting 则 getter 返回 null，builder 不追加 hash）。

### 验收

| # | 场景 | 预期 |
| --- | --- | --- |
| Q1 | shared builder：带 key | URL 追加 `#k=<encoded>`，query 参数不变 |
| Q2 | shared builder：无 key / 空串 | 与现状完全一致（无 hash） |
| Q3 | manager 注入 getter | `qrUrl`/`connectUrl` 含 `#k=` 且 search 不变；未注入时存量断言不变 |
| Q4 | 门控：最终手机页 URL 指向其它域（env 覆盖组合）/ flavor 非 kcode / key 空 | key 一律不进 URL（纯函数单测覆盖） |
| Q5 | 真机：写入 setting → KCode 开远控 → 手机扫码 | 不出现登录/缺钥失败页，直接配对进入 |
| Q6 | settings 清洗 | 非字符串/空白/超长值整键丢弃，不拖垮 settings 读取 |

## 追记 2026-10-20（三）：现任优先独占 + 静态预压缩

### 3.1 terminal 接管语义（回归官方"新替旧"，含一段已回退的实验记录）

**现状（最终决策）**：terminal `auth_init` 恢复官方 relay v2 语义——**新连接无条件接管**，旧连接收 `KICKED` 关闭；设备不存在（含已删除 SID）返回 `AUTH_FAILED`（契约 §1.2）；device 角色同样官方替换语义（桌面重启必须收回 device 位）。

**已回退的实验**（2026-10-20，留档防止重蹈）：曾实现"现任优先独占"（活跃现任 terminal 12s 窗口内新 terminal 排队等待、等满仍活跃则拒绝）以治理双页互踢。实测发现其阻断了**换设备控制**这一核心场景：旧页面（手机/另一台电脑）保持活跃心跳时，新设备排队 → 两次 `KICKED` → 客户端落"已被其他设备接管"终态页且无自愈路径——用户视角即"页面打不开"。官方语义下该场景秒级接管；双开互踢由客户端 `kickedDelay`（60s 内第二次 KICKED 进终态并停止重试）在 ~10 秒内自然收敛到最新设备，可接受。教训：单人自用场景"换设备"比"防双开"重要得多。

验收：现任活跃时新 terminal 立即接管且旧 terminal 收 KICKED；已删除 SID 返回 AUTH_FAILED；device 替换语义回归不变。

### 3.2 静态预压缩与编码协商

背景：主包 6.79MB 未压缩 × ECS 3Mbps → 首开 15s+；且现 immutable 正则（hex-only）匹配不到 Vite 实际 hash 命名（`index-B_ib1VwN.js` 含下划线/大写），hashed 资产从未命中 immutable 缓存。实测压缩收益：br 1.58MB（4.2s）/ gzip 1.92MB（5.1s）；Chromium 仅在 HTTPS 声明 br，当前 http://IP 部署手机实际走 gzip。

决策：

- 部署时预压缩：白名单 `.html/.js/.mjs/.css/.json/.svg/.txt/.xml` 生成 `.br` 与 `.gz` sidecar；`.map` 不压缩且部署时清除（sourcemap 不公开）。
- 协商：按 RFC 9110 解析 `Accept-Encoding`（token / q 权重 / 通配符 / identity / 大小写），可用表示按权重选择、同权重优先 br；identity 被禁（q=0）且无可用压缩表示 → 406；无头/空头保守回退原文。
- 响应头：`Content-Type`/`Cache-Control` 按原资源路径计算；`Content-Encoding` 按所选表示（原文不设）；`Content-Length` 用压缩文件长度；所有**可协商**资源（含原文回退）带 `Vary: Accept-Encoding`；HEAD 同选择、无正文（既有行为）。
- 安全：`.br`/`.gz` sidecar 直接请求一律 404（先校验原文件合法存在，再派生 sidecar 路径）；沿用既有 `%2e%2e` 穿越防护、流错误降级、下载中断销毁源流。
- immutable 修复：限定构建 `assets/` 目录 + hash 字符集 `[0-9A-Za-z_-]{8,}` 双条件（避免 `material-icons/folder-components.svg` 等固定名根级文件被误判缓存一年），以真实构建文件名（`index-B_ib1VwN.js`）做回归测试。
- 部署一致性：原文件与 sidecar 同批生成上传；资产先就绪、index.html 最后替换。
- 不引入 nginx（单进程自用，无必要）。

验收矩阵：仅 br / 仅 gzip / 不同 q / `br;q=0` / 无头 / 空头 / 通配符 / 禁 identity→406 / sidecar 缺失回退原文 / `.br` 直访 404 / HEAD / 真实 hash 文件 immutable 头 / Node 原生 HTTP 取原始响应解压后与原文件逐字节一致。
