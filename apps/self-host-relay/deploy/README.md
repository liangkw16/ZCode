# self-host-relay 部署（自用）

1. Node 22 tarball：`curl -fsSL <npmmirror node v22 linux tarball> -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /opt && ln -sfn /opt/node-v22.* /opt/node`（架构按 `uname -m` 选 x64/arm64）。
2. 密钥：`openssl rand -hex 32` 写入 `/etc/self-host-relay.env`（chmod 600）：
   `SELF_HOST_RELAY_SECRET=<secret>`、`SELF_HOST_RELAY_HOST=0.0.0.0`、`SELF_HOST_RELAY_PORT=8787`、
   `SELF_HOST_RELAY_DEVICES_FILE=/var/lib/self-host-relay/devices.json`、
   `SELF_HOST_RELAY_STATIC_ROOT=/opt/self-host-relay/web`。
   手机页构建零密钥（`pnpm build:web-remote-control:selfhost`，产物可公开分发）；
   密钥首选随 QR/复制链接分发：KCode 桌面端 setting 写入 `zcodeRelaySelfHostKey`（与
   `zcodeEndpointOrigin` 同级）后，二维码与复制链接自动携带 `#k=<secret>`，手机扫码即存即连；
   书签 URL `http://<origin>/remote/v4#k=<secret>` 保留为备用通道。
3. 上传：`dist/main.js` → `/opt/self-host-relay/main.js`；`packages/web/dist/` → `/opt/self-host-relay/web/`。
   上传前先 `pnpm compress:web-remote-control` 生成 `.br`/`.gz` sidecar（relay 按 Accept-Encoding 协商返回）；
   上传时排除 `*.map`（sourcemap 不公开）。资产文件先就绪、`index.html` 最后替换，保证原文件与 sidecar 同批。
4. systemd：unit 中 `__NODE_BIN__` 替换为 `/opt/node/bin/node`，`systemctl enable --now self-host-relay`。
5. 云厂商安全组放行 8787/TCP（控制台操作）。
6. 验证：`curl http://127.0.0.1:8787/remote/v4` 200；无密钥 `POST /api/v1/remote/token` 401。
7. TLS 升级（可选）：前置 nginx 终止 TLS，`SELF_HOST_RELAY_HOST=127.0.0.1`，origin 换 https 域名。

密钥与 ECS IP 不写入任何已提交文件。
