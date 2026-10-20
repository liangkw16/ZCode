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
