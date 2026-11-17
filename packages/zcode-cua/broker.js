import {
  callBrokerMethod as nativeCall,
  probeHelperHealth as nativeHealth,
} from "./dist/adapters/broker-api.js";
import { BROKER_METHODS } from "./dist/contract/manifest.js";

// 保留 IPC3 公共入口；所有系统调用都交给独立原生 Helper。
export { HELPER_GHOST_CURSOR_OVERLAY_ARG } from "./broker-helper-constants.js";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

export async function callBrokerMethod(args) {
  try {
    return await nativeCall(args);
  } catch (error) {
    throw new BrokerError(error.message, { code: error.code, details: error.details });
  }
}
export const probeHelperHealth = nativeHealth;

export { resolveBrokerSocketPath, mintBrokerSocketPath } from "./dist/adapters/socket-path.js";

export function parseRequestLine(line) {
  try {
    const value = JSON.parse(line);
    return value &&
      Number.isSafeInteger(value.id) &&
      value.id >= 0 &&
      typeof value.method === "string" &&
      (value.params === undefined ||
        (value.params && typeof value.params === "object" && !Array.isArray(value.params)))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(backend, request) {
  const handler = backend[request.method];
  if (!isBrokerMethod(request.method) || typeof handler !== "function")
    return {
      ...errorResponse("Unknown broker method", { code: "method_not_found" }),
      id: request.id,
    };
  try {
    return { ...okResponse(await handler.call(backend, request.params ?? {})), id: request.id };
  } catch (error) {
    return { ...errorResponse(error.message, { code: error.code ?? "internal" }), id: request.id };
  }
}
export async function handleRequestLine(backend, line) {
  const request = parseRequestLine(line);
  return request
    ? dispatchRequest(backend, request)
    : errorResponse("Invalid request", { code: "invalid_request" });
}
export function isBrokerMethod(method) {
  return BROKER_METHODS.includes(method);
}
export function isReadOnlyBrokerMethod(method) {
  return [
    "broker_info",
    "controller_status",
    "permission_status",
    "input_permission_status",
    "screen_capture_status",
    "supports_accessibility",
    "list_applications",
    "application_info",
    "list_windows",
    "capture_app",
    "element_at_point",
    "read_element",
    "is_focus_steal_prevented",
    "pip_is_running",
  ].includes(method);
}
