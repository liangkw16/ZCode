import { resolveWebRemoteControlScreenLocale } from "#src/web-remote-control/ui/webRemoteControlFailureScreen.js";

const NOTICE_AUTO_DISMISS_MS = 4000;

/**
 * 任务视图被其他页面抢占时的一次性提示。web 文件不在共享 UI 的 Tailwind 扫描目录内，
 * 这里全部使用内联样式，避免依赖可能未生成的 utility class。
 */
export function showWebRemoteControlTaskPreemptedNotice(): () => void {
  const zh =
    resolveWebRemoteControlScreenLocale(navigator.language) === "zh-CN";
  const toast = document.createElement("div");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("data-web-remote-control-task-preempted", "true");
  toast.textContent = zh
    ? "该会话已在其他页面打开"
    : "This conversation is now open in another tab";
  Object.assign(toast.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "60",
    maxWidth: "calc(100vw - 1.5rem)",
    padding: "8px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(128, 128, 128, 0.45)",
    background: "rgba(24, 24, 27, 0.94)",
    color: "#fafafa",
    fontSize: "14px",
    lineHeight: "20px",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(toast);
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
  };
  const timer = setTimeout(dismiss, NOTICE_AUTO_DISMISS_MS);
  toast.addEventListener("click", dismiss);
  return dismiss;
}
