// Helper 的补丁只增加输入准入前置条件，不接管 session、输入锁或取消清理。
export function installMacosCuaSessionGate(backend, { readConsoleState, denied }) {
  const methods = [
    "capture_app",
    "click",
    "scroll",
    "drag",
    "type_text",
    "type_text_to_app",
    "press_key",
    "press_key_to_app",
    "hold_key",
    "hold_key_to_app",
    "paste",
    "element_press",
    "element_show_menu",
    "element_focus",
    "element_set_value",
    "element_perform_action",
    "element_select_text",
    "element_scroll",
  ];
  for (const name of methods) {
    const dispatch = backend[name];
    if (typeof dispatch !== "function") continue;
    backend[name] = async function (...args) {
      let state;
      try {
        const raw = await readConsoleState();
        const matches =
          typeof raw === "string" ? [...raw.matchAll(/"IOConsoleLocked"\s*=\s*(Yes|No)\b/g)] : [];
        if (matches.length === 1) state = matches[0][1];
      } catch {
        // 真机发现锁屏会遮蔽 AX 树但窗口事件仍回 accepted；未知系统状态不能视为已解锁。
      }
      if (state !== "No") {
        const locked = state === "Yes";
        throw denied(
          locked
            ? "The macOS session is locked. Unlock the screen, then observe the target again. action_sent=false."
            : "The macOS session state is unavailable. Observe again after the session is available. action_sent=false.",
          {
            action_sent: false,
            reason: locked ? "screen_locked" : "session_state_unavailable",
          },
        );
      }
      return dispatch.apply(this, args);
    };
  }
}

export function patchMacosCuaSessionGate(source) {
  const marker = "// KCode macOS console session admission";
  if (source.includes(marker)) throw new Error("macOS session gate is already installed");
  const anchor = "    adapter = nextAdapter;";
  if (source.split(anchor).length !== 2)
    throw new Error("Expected exactly one Helper backend entry");
  // 读系统事实而非维护第二份锁屏缓存；释放输入与健康检查不经过这道门。
  const installation = `${marker}
    if (process.platform === "darwin") {
      (${installMacosCuaSessionGate.toString()})(nextBackend, {
        readConsoleState: () => new Promise((resolve, reject) => {
          import_node_child_process5.execFile("/usr/sbin/ioreg", ["-n", "Root", "-d", "1", "-l"],
            { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 1000 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
        }),
        denied: permissionDenied
      });
    }
`;
  return source.replace(anchor, installation + anchor);
}

export function macosCuaScrollDistance(pages, direction, bounds) {
  const axis = direction === "left" || direction === "right" ? 2 : 3;
  return Math.round(pages * bounds[axis] * 0.8);
}

export function patchMacosCuaScrollPages(source) {
  const call =
    "adapter.scrollToWindow(target.pid, target.bundleId, target.windowId, target.bounds, point2.x, point2.y, amount2, direction2, ...provenAttachedSurfaceArgs(target))";
  if (source.split(call).length !== 2)
    throw new Error("Expected exactly one macOS window scroll dispatch");
  // 真机记录证明原生参数按像素消费；在已验证窗口的派发边界换算页数，避免一页只动 1px。
  return source.replace(
    call,
    call.replace(
      "amount2, direction2",
      `(${macosCuaScrollDistance.toString()})(amount2, direction2, target.bounds), direction2`,
    ),
  );
}
