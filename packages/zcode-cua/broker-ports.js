export function isCuaPermissionStatusAvailable(result) {
  // 正常服务结果没有 available 字段；只有显式 false 才表示 Helper 不可用。
  return (
    Boolean(result) &&
    typeof result === "object" &&
    result.available !== false &&
    "accessibility" in result &&
    "screenRecording" in result
  );
}

export function shouldRunCuaScreenCaptureProbe(state, options) {
  return state === "granted" && options?.probeScreenCapture === true;
}
