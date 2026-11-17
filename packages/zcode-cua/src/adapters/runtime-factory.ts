import { randomUUID } from "node:crypto";
import type { ComputerUseRuntimeOptions } from "../contract/index.js";
import { createRuntime } from "../app/runtime.js";
import { createBrokerClient } from "./broker-client.js";
import { createProductCuaHelperHost } from "./helper-host.js";
export function createComputerUseRuntime(options: ComputerUseRuntimeOptions = {}) {
  const env = options.env ?? process.env;
  const path =
    options.brokerSocketPath ??
    env.ZCODE_CUA_PERMISSION_BROKER_SOCKET ??
    `/tmp/zcode-cua-${process.getuid?.() ?? "nouid"}/broker.sock`;
  const broker = createBrokerClient({ socketPath: path });
  let host: ReturnType<typeof createProductCuaHelperHost> | undefined;
  return createRuntime({
    broker,
    id: randomUUID,
    async prepare() {
      if (options.ensureBrokerAvailable) await options.ensureBrokerAvailable();
      else if (!options.brokerSocketPath && !env.ZCODE_CUA_PERMISSION_BROKER_SOCKET) {
        if (process.platform !== "darwin") throw new Error("Native computer use requires macOS");
        host ??= createProductCuaHelperHost({ env });
        await host.start();
      }
    },
  });
}
