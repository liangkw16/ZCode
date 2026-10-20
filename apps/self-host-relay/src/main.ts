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
