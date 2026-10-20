import type { SelfHostRelayConfig } from "./contract.js";

export const SELF_HOST_RELAY_CONFIG_EXAMPLE: SelfHostRelayConfig = {
  host: "0.0.0.0",
  port: 8787,
  secret: "<openssl rand -hex 32>",
  devicesFile: "/var/lib/self-host-relay/devices.json",
  staticRoot: "/opt/self-host-relay/web",
};
