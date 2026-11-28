export const CUA_REQUEST_ACCESS_STATUS_META_KEY = "zcode.cua/request-access-status-v1";
export const cuaRequestAccessStatusSchema = {
  safeParse(input) {
    if (
      input &&
      typeof input === "object" &&
      input.schemaVersion === 1 &&
      input.platform === "darwin" &&
      typeof input.grantOwner === "string" &&
      input.grantOwner.length > 0 &&
      ["granted", "stale", "denied"].includes(input.accessibility) &&
      ["unknown", "granted", "denied"].includes(input.screenRecording)
    )
      return { success: true, data: input };
    return { success: false, error: new Error("Invalid computer-use permission facts") };
  },
};
