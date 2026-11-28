import type { CallBrokerMethodArgs, ProbeHelperHealthOptions } from "../../broker.js";
import { BROKER_METHODS } from "../contract/manifest.js";
import { createBrokerClient, NativeBrokerError } from "./broker-client.js";
export async function callBrokerMethod<T = unknown>(args: CallBrokerMethodArgs): Promise<T> {
  if (!(BROKER_METHODS as readonly string[]).includes(args.method))
    throw new NativeBrokerError("method_not_found", "Unknown CUA broker method");
  if (
    args.params !== undefined &&
    (!args.params || typeof args.params !== "object" || Array.isArray(args.params))
  )
    throw new NativeBrokerError("invalid_request", "Broker params must be an object");
  const client = createBrokerClient({ socketPath: args.socketPath, timeoutMs: args.timeoutMs });
  try {
    return await client.call<T>(args.method, (args.params ?? {}) as Record<string, unknown>);
  } finally {
    await client.close();
  }
}
export async function probeHelperHealth(
  socketPath: string,
  options: ProbeHelperHealthOptions = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 2500);
  let last: unknown;
  do {
    try {
      const info = await callBrokerMethod<{
        bundle_id?: string;
        pid?: number;
        main_loop_responsive?: boolean;
      }>({
        socketPath,
        method: "broker_info",
        timeoutMs: Math.min(options.perTryTimeoutMs ?? 500, Math.max(1, deadline - Date.now())),
      });
      if (
        !info.bundle_id ||
        !Number.isSafeInteger(info.pid) ||
        Number(info.pid) < 2 ||
        info.main_loop_responsive !== true
      )
        throw new NativeBrokerError(
          "helper_unresponsive",
          "Native Helper identity or AppKit loop unavailable",
        );
      return { bundleId: info.bundle_id, pid: info.pid! };
    } catch (error) {
      last = error;
      if (
        error instanceof NativeBrokerError &&
        ["not_authorized", "version_mismatch", "invalid_response"].includes(error.code)
      )
        throw error;
    }
    if (Date.now() < deadline)
      await new Promise((r) =>
        setTimeout(r, Math.min(options.pollIntervalMs ?? 50, Math.max(1, deadline - Date.now()))),
      );
  } while (Date.now() < deadline);
  throw last;
}
