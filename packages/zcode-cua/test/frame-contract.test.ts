import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY as key,
  parseOfficialCuaImageRef,
  containsImageRefAuthority,
  readRasterEnvelopeIdentity,
  preserveOfficialCuaFrameResult,
  attestOfficialCuaFrameContent,
} from "../frame-contract.js";
const data =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/J0AAAAASUVORK5CYII=";
const bytes = Buffer.from(data, "base64");
const ref = {
  type: "text",
  text: JSON.stringify({
    image_ref: { frame_id: "frame-unique", width: 1, height: 1, actionable: true },
  }),
};
const meta = {
  version: 1,
  frame_id: "frame-unique",
  width: 1,
  height: 1,
  media_type: "image/png",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const result = () => ({
  content: [{ type: "image", data, mimeType: "image/png" }, ref],
  _meta: { [key]: meta },
});
const processor = {
  resizeToFit: async () => ({
    data: bytes,
    mediaType: "image/png",
    width: 1,
    height: 1,
    originalWidth: 1,
    originalHeight: 1,
    resized: false,
  }),
};
it("parses exact actionable authority and detects nested or embedded credentials", () => {
  expect(parseOfficialCuaImageRef(ref)).toEqual({ frameId: "frame-unique", width: 1, height: 1 });
  expect(
    parseOfficialCuaImageRef({
      type: "text",
      text: ref.text.replace('"actionable":true', '"actionable":true,"extra":1'),
    }),
  ).toBeNull();
  expect(containsImageRefAuthority({ value: ["prefix " + ref.text + " suffix"] })).toBe(true);
  expect(containsImageRefAuthority({ value: "plain text" })).toBe(false);
});
it("checks complete PNG envelope, exact byte hash and host full decode without resizing", async () => {
  expect(readRasterEnvelopeIdentity(bytes)).toEqual({ mimeType: "image/png", width: 1, height: 1 });
  expect(readRasterEnvelopeIdentity(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
  expect(
    (await preserveOfficialCuaFrameResult(result(), { imageProcessorPort: processor })).isError,
  ).not.toBe(true);
  expect((await preserveOfficialCuaFrameResult(result())).isError).toBe(true);
  const forged = result();
  forged._meta[key] = { ...meta, sha256: "0".repeat(64) };
  expect(
    (await preserveOfficialCuaFrameResult(forged, { imageProcessorPort: processor })).isError,
  ).toBe(true);
  expect(
    (
      await preserveOfficialCuaFrameResult(result(), {
        imageProcessorPort: {
          resizeToFit: async () => ({ ...(await processor.resizeToFit()), resized: true }),
        },
      })
    ).isError,
  ).toBe(true);
});
it("requires adjacency, a single raster, exact dimensions and no authority in structured data", async () => {
  for (const mutated of [
    { ...result(), content: [ref, ...result().content] },
    { ...result(), structuredContent: { stolen: ref.text } },
    {
      ...result(),
      content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: "gap" }, ref],
    },
  ]) {
    expect(
      (await preserveOfficialCuaFrameResult(mutated, { imageProcessorPort: processor })).isError,
    ).toBe(true);
  }
  const content = [
    { type: "image", dataUrl: `data:image/png;base64,${data}`, mediaType: "image/png" },
    ref,
  ];
  expect(attestOfficialCuaFrameContent(content, "official_cua_frame_v1")).toMatchObject({
    frameId: "frame-unique",
    sha256: meta.sha256,
  });
  expect(attestOfficialCuaFrameContent(content, "other")).toBeUndefined();
});
