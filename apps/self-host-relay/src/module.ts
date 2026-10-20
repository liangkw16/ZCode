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
    pending = writeFile(
      devicesFile,
      `${JSON.stringify(store.serializeDevices(), null, 2)}\n`,
      "utf-8",
    ).catch((error: unknown) => {
      console.error("[self-host-relay] devices persist failed", error);
    });
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
  const staticHandler = config.staticRoot
    ? createSelfHostStaticHandler({ rootDir: config.staticRoot })
    : undefined;
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
