import { randomUUID } from "node:crypto";
import type { ComputerUseRuntimeOptions } from "../contract/index.js";
import { createRuntime } from "../app/runtime.js";
import { createBrokerClient } from "./broker-client.js";
import { resolveBrokerSocketPath } from "./socket-path.js";
import { createProductCuaHelperHost } from "./helper-host.js";
export function createComputerUseRuntime(options: ComputerUseRuntimeOptions = {}) {
  const env = { ...(options.env ?? process.env) };
  const path = options.brokerSocketPath ?? resolveBrokerSocketPath({ env });
  const broker = createBrokerClient({ socketPath: path });
  let host: ReturnType<typeof createProductCuaHelperHost> | undefined;
  return createRuntime({
    broker,
    id: randomUUID,
    async prepare() {
      if (options.ensureBrokerAvailable) await options.ensureBrokerAvailable();
      else if (
        !options.brokerSocketPath ||
        options.brokerSocketPath === env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim()
      ) {
        if (process.platform !== "darwin") throw new Error("Native computer use requires macOS");
        // 产品注入的是稳定入口，并不保证进程存活；每次新调用都走同一原生启动互斥边界。
        host ??= createProductCuaHelperHost({
          env,
          bundledHelperAppPath: env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim(),
        });
        await host.start();
      }
    },
  });
}
