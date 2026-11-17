export * from "./dist/adapters/public-server.js";
export async function requestHelperAccessibilityPermissionViaLaunchServices(_options) {
  return { ok: false, reason: "Permission request mode is not installed yet" };
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices(_options) {
  return { ok: false, reason: "Permission request mode is not installed yet" };
}
