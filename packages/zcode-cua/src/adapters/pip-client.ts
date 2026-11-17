import type { PipSessionClientOptions, PipSessionClient } from "../../pip-session-node.js";
import type { PipSessionEvent } from "../../pip-session.js";
import { createBrokerClient } from "./broker-client.js";
export function createPipSessionClient(options: PipSessionClientOptions = {}): PipSessionClient {
  const client = options.socketPath
    ? createBrokerClient({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? 2500,
        role: "presentation",
      })
    : undefined;
  let closed = false,
    ready = false;
  const connect = async () => {
    if (closed || !client) return;
    if (!ready) {
      const result = await client.call<any>("pip_session_handshake", {
        protocolVersion: 2,
        runtimeId: "zcode-cua-pip-session-v2",
      });
      if (result.ready !== true || result.protocolVersion !== 2)
        throw new Error("PiP protocol mismatch");
      ready = true;
    }
  };
  return {
    get enabled() {
      return !!client && !closed;
    },
    connect,
    async send(event: PipSessionEvent) {
      if (!client || closed) return { applied: false, reason: "closed" };
      await connect();
      try {
        return await client.call("pip_session_event", { event });
      } catch (error) {
        ready = false;
        options.onDiagnostic?.({
          code: (error as any).code ?? "unavailable",
          message: "PiP event was not acknowledged",
        });
        throw error;
      }
    },
    close() {
      closed = true;
      void client?.close();
    },
  };
}
