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

## 多 terminal 扩展（2026-10-21）

- 同一 `device_sid` 允许多个 terminal 连接，按 `terminal_id` 区分；同 id 重连只替换旧连接。
- `auth_init.terminal_id?` 由客户端提供；缺省时使用连接级 `terminal_sid`。
- `auth_ack.terminal_id?` 仅当 terminal 自己携带了 `terminal_id` 时才回显（旧客户端兼容开关，
  旧 web 的 strict 解析不认识未知字段）。
- relay → device 的 `data` 增加 `from_terminal_id?`；device → relay 的 `data` 支持
  `target_terminal_id?`，缺省广播给全部 terminal；转发给 terminal 前剥离该字段。
- device 的 `auth_ack.terminal_ids?` / `pair_status_ack.terminal_ids?` 是权威 terminal 集合；
  单个 terminal 断开只更新列表，device 断开才关闭全部 terminal 并发送 `DEVICE_OFFLINE`。
- terminal 上限默认 32（`maxTerminals` 可配置），超出回 `KICKED`。
- 完整语义见 `docs/superpowers/specs/2026-10-21-multi-terminal-web-remote-control-design.md`。
