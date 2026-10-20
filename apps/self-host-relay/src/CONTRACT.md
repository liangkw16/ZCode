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
