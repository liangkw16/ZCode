import { MODEL_TOOLS } from "../contract/manifest.js";
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = { action_sent: false, dispatch_status: "not_sent" },
  ) {
    super(message);
  }
}
export type Bag = Record<string, any>;
function fail(message: string): never {
  throw new RequestError("invalid_request", message);
}
function copy(value: unknown, depth = 0): any {
  if (depth > 12) fail("Request nesting exceeds limit");
  if (typeof value === "string") {
    if (value.length > 1024 * 1024) fail("Text exceeds limit");
    return value.toWellFormed();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Number must be finite");
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value !== "object") fail("Request must contain JSON values");
  if (Array.isArray(value)) {
    if (value.length > 2048) fail("Array exceeds limit");
    return value.map((v) => copy(v, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    fail("Request must contain plain objects");
  const result: Bag = {};
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (d.get || d.set || ["__proto__", "constructor", "prototype"].includes(key))
      fail("Request property is not allowed");
    if (d.value !== undefined) result[key] = copy(d.value, depth + 1);
  }
  return result;
}
const shape = (value: unknown, keys: string[], label: string): Bag => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`${label}: unknown key ${key}`);
  return value as Bag;
};
const positiveInteger = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
export function appReference(v: unknown): Bag {
  const app = shape(v, ["pid", "bundle_id", "name", "window_id"], "app_ref");
  if (!["pid", "bundle_id", "name"].some((k) => app[k] !== undefined))
    fail("app_ref needs pid, bundle_id or name");
  for (const key of ["pid", "window_id"])
    if (app[key] !== undefined && !positiveInteger(app[key]))
      fail(`${key} must be a positive integer`);
  if (app.pid !== undefined && app.pid > 2147483647)
    fail("pid exceeds the native process ID range");
  if (app.window_id !== undefined && app.window_id > 4294967295)
    fail("window_id exceeds the native window ID range");
  for (const key of ["bundle_id", "name"])
    if (
      app[key] !== undefined &&
      (typeof app[key] !== "string" || !app[key].trim() || app[key].length > 1024)
    )
      fail(`${key} must be nonempty text`);
  return app;
}
function target(v: unknown): Bag {
  const t = shape(v, ["type", "index", "x", "y", "frame_id"], "target");
  if (t.type === "element") {
    if (
      !Number.isSafeInteger(t.index) ||
      t.index < 0 ||
      Object.keys(t).some((k) => !["type", "index"].includes(k))
    )
      fail("Element target needs a nonnegative integer index");
  } else if (t.type === "coordinate") {
    if (
      ![t.x, t.y].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      t.index !== undefined ||
      (t.frame_id !== undefined && (typeof t.frame_id !== "string" || t.frame_id.length > 200))
    )
      fail("Coordinate target needs nonnegative integer x/y");
  } else fail("Target type must be element or coordinate");
  return t;
}
const schemas: Record<string, string[]> = {
  list_apps: [],
  list_windows: ["app_ref"],
  get_app_state: ["app_ref", "include_screenshot", "disable_diffing", "tree_shown_to_model"],
  left_click: [
    "app_ref",
    "target",
    "mouse_button",
    "click_count",
    "modifiers",
    "strategy",
    "return_state",
  ],
  scroll: ["app_ref", "target", "scroll_direction", "scroll_amount", "strategy", "return_state"],
  left_click_drag: ["app_ref", "from_target", "to", "modifiers", "strategy", "return_state"],
  type: ["app_ref", "text", "return_state"],
  set_value: ["app_ref", "target", "value", "return_state"],
  select_text: ["app_ref", "target", "text_range", "return_state"],
  key: ["app_ref", "text", "hold_seconds", "strategy", "return_state"],
  perform_action: ["app_ref", "target", "action", "return_state"],
  paste: ["app_ref", "text", "format", "return_state"],
  request_access: [],
  stop_computer_control: [],
};
export function validateRequest(name: string, input: unknown): Bag {
  if (!(MODEL_TOOLS as readonly string[]).includes(name))
    throw new RequestError("method_not_found", "Unknown computer-use tool");
  const args = shape(copy(input ?? {}), schemas[name], "arguments");
  if (schemas[name].includes("app_ref")) args.app_ref = appReference(args.app_ref);
  for (const key of ["target", "from_target", "to"])
    if (schemas[name].includes(key)) args[key] = target(args[key]);
  for (const key of ["include_screenshot", "disable_diffing", "tree_shown_to_model"])
    if (args[key] !== undefined && typeof args[key] !== "boolean") fail(`${key} must be boolean`);
  for (const key of ["text", "value", "action"])
    if (schemas[name].includes(key) && typeof args[key] !== "string") fail(`${key} must be text`);
  if (args.return_state !== undefined && !["none", "compact", "full"].includes(args.return_state))
    fail("return_state must be none, compact or full");
  if (args.strategy !== undefined && !["auto", "event", "ax"].includes(args.strategy))
    fail("Unsupported strategy");
  if (args.mouse_button !== undefined && !["left", "right", "middle"].includes(args.mouse_button))
    fail("Invalid mouse button");
  if (
    args.click_count !== undefined &&
    (!positiveInteger(args.click_count) || args.click_count > 3)
  )
    fail("click_count must be 1..3");
  if (
    name === "scroll" &&
    (!["up", "down", "left", "right"].includes(args.scroll_direction) ||
      (args.scroll_amount !== undefined &&
        (typeof args.scroll_amount !== "number" ||
          args.scroll_amount <= 0 ||
          args.scroll_amount > 100)))
  )
    fail("Invalid scroll direction or amount");
  if (
    args.hold_seconds !== undefined &&
    (typeof args.hold_seconds !== "number" || args.hold_seconds < 0 || args.hold_seconds > 30)
  )
    fail("hold_seconds must be 0..30");
  if (
    name === "select_text" &&
    (!Array.isArray(args.text_range) ||
      args.text_range.length !== 2 ||
      !args.text_range.every((n: number) => Number.isSafeInteger(n) && n >= 0))
  )
    fail("text_range must be [start,length] integers");
  if (args.format !== undefined && !["text", "md", "html"].includes(args.format))
    fail("format must be text, md or html");
  if (
    args.modifiers !== undefined &&
    (!Array.isArray(args.modifiers) ||
      args.modifiers.length > 4 ||
      !args.modifiers.every(
        (m: unknown) =>
          typeof m === "string" &&
          ["cmd", "command", "ctrl", "control", "alt", "option", "shift", "meta", "super"].includes(
            m.toLowerCase(),
          ),
      ))
  )
    fail("Invalid modifiers");
  return args;
}
export function sessionKey(context: Bag) {
  if (context.runtimeScope !== "main")
    throw new RequestError("not_authorized", "Computer Use is not available in subagent");
  const identity =
    context.workspaceIdentity?.trim() || context.workspacePath || context.workspaceKey;
  if (
    typeof context.sessionId !== "string" ||
    !context.sessionId.trim() ||
    typeof identity !== "string" ||
    !identity
  )
    fail("Invalid computer-use session context");
  return JSON.stringify([identity, context.sessionId, context.remoteSessionId ?? null]);
}
export const appMatches = (state: Bag, app: Bag) =>
  Object.entries(app).every(([k, v]) =>
    k === "window_id" ? state.window?.window_id === v : state.app?.[k] === v,
  );
