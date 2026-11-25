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
  // 修复原因：键集合原先比给模型看的工具文档（docs/computer-use.md）窄——type 的 target/strategy、
  // set_value 的 strategy、key 的 repeat 都会被判成 unknown key，在派发前拒绝。这里对齐文档契约。
  type: ["app_ref", "text", "target", "strategy", "return_state"],
  set_value: ["app_ref", "target", "value", "strategy", "return_state"],
  select_text: ["app_ref", "target", "text_range", "return_state"],
  key: ["app_ref", "text", "repeat", "hold_seconds", "strategy", "return_state"],
  perform_action: ["app_ref", "target", "action", "return_state"],
  paste: ["app_ref", "text", "format", "return_state"],
  request_access: [],
  stop_computer_control: [],
};
const MODIFIER_NAMES = [
  "cmd",
  "command",
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
  "meta",
  "super",
] as const;
export const KEY_REPEAT_MAX = 100;
// 文档约定 modifiers 是 "+" 分隔的和弦字符串（如 "cmd+shift"），空串表示没有修饰键；
// 原生侧使用名称数组。原先只收数组，SDK 透传的字符串在派发前就被拒绝。
function modifiers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = typeof value === "string" ? value.split("+") : value;
  if (!Array.isArray(parts) || parts.length > 4) fail("Invalid modifiers");
  const names: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") fail("Invalid modifiers");
    const name = part.trim().toLowerCase();
    if (name === "" && typeof value === "string" && parts.length === 1) break;
    if (!(MODIFIER_NAMES as readonly string[]).includes(name) || names.includes(name))
      fail("Invalid modifiers");
    names.push(name);
  }
  return names;
}
export function validateRequest(name: string, input: unknown): Bag {
  if (!(MODEL_TOOLS as readonly string[]).includes(name))
    throw new RequestError("method_not_found", "Unknown computer-use tool");
  const args = shape(copy(input ?? {}), schemas[name], "arguments");
  if (schemas[name].includes("app_ref")) args.app_ref = appReference(args.app_ref);
  // type 的 target 是可选的（文档 type({text, target?})），缺省时输入到当前焦点；其余动作的目标必填。
  for (const key of ["target", "from_target", "to"])
    if (schemas[name].includes(key) && !(name === "type" && args[key] === undefined))
      args[key] = target(args[key]);
  for (const key of ["include_screenshot", "disable_diffing", "tree_shown_to_model"])
    if (args[key] !== undefined && typeof args[key] !== "boolean") fail(`${key} must be boolean`);
  for (const key of ["text", "value", "action"])
    if (schemas[name].includes(key) && typeof args[key] !== "string") fail(`${key} must be text`);
  if (args.return_state !== undefined && !["none", "compact", "full"].includes(args.return_state))
    fail("return_state must be none, compact or full");
  // 文档写作 "a11y"，内部与原生侧的名称是 "ax"。
  if (args.strategy !== undefined) {
    const strategy = args.strategy === "a11y" ? "ax" : args.strategy;
    if (typeof strategy !== "string" || !["auto", "ax", "event"].includes(strategy))
      fail("Unsupported strategy");
    args.strategy = strategy;
  }
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
  if (args.repeat !== undefined && (!positiveInteger(args.repeat) || args.repeat > KEY_REPEAT_MAX))
    fail(`repeat must be 1..${KEY_REPEAT_MAX}`);
  // 文档约定 select_text 不带 text_range 时选中整个值，范围由运行时按观测到的元素值补齐。
  if (
    name === "select_text" &&
    args.text_range !== undefined &&
    (!Array.isArray(args.text_range) ||
      args.text_range.length !== 2 ||
      !args.text_range.every((n: number) => Number.isSafeInteger(n) && n >= 0))
  )
    fail("text_range must be [start,length] integers");
  if (args.format !== undefined && !["text", "md", "html"].includes(args.format))
    fail("format must be text, md or html");
  args.modifiers = modifiers(args.modifiers);
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
