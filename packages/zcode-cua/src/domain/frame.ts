import { sha256 } from "@noble/hashes/sha256.js";
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;
type RecordValue = Record<string, any>;
export const record = (v: unknown): v is RecordValue =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const exact = (v: RecordValue, keys: string[]) =>
  Object.keys(v).sort().join("|") === keys.sort().join("|");
const dimension = (v: unknown): v is number =>
  Number.isInteger(v) && Number(v) > 0 && Number(v) <= 4096;
export function parseOfficialCuaImageRef(
  block: unknown,
): { frameId: string; width: number; height: number } | null | undefined {
  if (!record(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
  if (!block.text.includes("image_ref")) return undefined;
  if (block.text.length > 1024) return null;
  try {
    const v = JSON.parse(block.text);
    const r = v.image_ref;
    if (
      !record(v) ||
      !exact(v, ["image_ref"]) ||
      !record(r) ||
      !exact(r, ["frame_id", "width", "height", "actionable"]) ||
      typeof r.frame_id !== "string" ||
      !/^frame-[a-zA-Z0-9_-]{1,180}$/.test(r.frame_id) ||
      r.actionable !== true ||
      !dimension(r.width) ||
      !dimension(r.height) ||
      r.width * r.height > 16 * 1024 * 1024
    )
      return null;
    return { frameId: r.frame_id, width: r.width, height: r.height };
  } catch {
    return null;
  }
}
export function isOfficialCuaImageRefText(text: string) {
  return !!parseOfficialCuaImageRef({ type: "text", text });
}
export function containsOfficialCuaImageRefCredentialText(text: string) {
  // 字符预算耗尽时拒绝把内容降级为普通文本，避免截断绕过 authority 检查。
  return text.length > 263168 || /image_ref|frame_id/.test(text);
}
export function containsImageRefAuthority(value: unknown): boolean {
  const seen = new Set<object>();
  let budget = 4096;
  const visit = (v: unknown): boolean => {
    if (--budget < 0) return true;
    if (typeof v === "string") return containsOfficialCuaImageRefCredentialText(v);
    if (!v || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (/image_ref|frame_id/.test(k) || d.get || d.set || visit(d.value)) return true;
    }
    return false;
  };
  return visit(value);
}
export function sha256Hex(bytes: Uint8Array) {
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** 按 UTF-16 码元上限截断，且不在代理对中间切开：星体字符、emoji 不会变成半个。 */
export function truncateUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
export function readRasterEnvelopeIdentity(
  input: unknown,
): { mimeType: string; width: number; height: number; orientation?: number } | undefined {
  if (!(input instanceof Uint8Array) || input.length < 20) return;
  const b = input,
    v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (
    b[0] === 137 &&
    b[1] === 80 &&
    b[2] === 78 &&
    b[3] === 71 &&
    b[4] === 13 &&
    b[5] === 10 &&
    b[6] === 26 &&
    b[7] === 10
  ) {
    let offset = 8,
      width = 0,
      height = 0,
      seenData = false,
      seenHeader = false;
    while (offset + 12 <= b.length) {
      const length = v.getUint32(offset);
      if (length > b.length - offset - 12) return;
      const type = String.fromCharCode(...b.subarray(offset + 4, offset + 8));
      if (!seenHeader) {
        if (type !== "IHDR" || length !== 13) return;
        width = v.getUint32(offset + 8);
        height = v.getUint32(offset + 12);
        seenHeader = true;
      } else if (type === "IHDR") return;
      if (type === "IDAT") seenData = true;
      offset += 12 + length;
      if (type === "IEND")
        return length === 0 &&
          offset === b.length &&
          seenData &&
          dimension(width) &&
          dimension(height)
          ? { mimeType: "image/png", width, height }
          : undefined;
    }
    return;
  }
  if (b[0] !== 255 || b[1] !== 216 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217) return;
  let offset = 2,
    width = 0,
    height = 0,
    orientation: number | undefined;
  while (offset + 4 <= b.length) {
    if (b[offset++] !== 255) return;
    while (b[offset] === 255) offset++;
    const marker = b[offset++];
    if (marker === 217) break;
    if (marker === 218) break;
    if (marker === 0 || marker === 216) return;
    const length = v.getUint16(offset);
    if (length < 2 || offset + length > b.length) return;
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) return;
      height = v.getUint16(offset + 3);
      width = v.getUint16(offset + 5);
    }
    if (
      marker === 225 &&
      length >= 16 &&
      String.fromCharCode(...b.subarray(offset + 2, offset + 8)) === "Exif\0\0"
    ) {
      const tiff = offset + 8,
        le = b[tiff] === 73 && b[tiff + 1] === 73;
      if (!le && !(b[tiff] === 77 && b[tiff + 1] === 77)) return;
      try {
        const end = offset + length,
          ifd = tiff + v.getUint32(tiff + 4, le);
        if (ifd + 2 > end) return;
        const count = v.getUint16(ifd, le);
        if (count > 1024 || ifd + 2 + count * 12 > end) return;
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 274) {
            if (v.getUint16(e + 2, le) !== 3 || v.getUint32(e + 4, le) !== 1) return;
            orientation = v.getUint16(e + 8, le);
          }
        }
      } catch {
        return;
      }
    }
    offset += length;
  }
  return dimension(width) && dimension(height)
    ? {
        mimeType: "image/jpeg",
        width,
        height,
        ...(orientation === undefined ? {} : { orientation }),
      }
    : undefined;
}
export function decodeFrameBase64(data: unknown): Uint8Array | undefined {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    return;
  try {
    const binary = atob(data);
    if (btoa(binary) !== data) return;
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return;
  }
}
export function findOfficialCuaFrameContentPair(content: unknown) {
  if (!Array.isArray(content)) return;
  const images = content
    .map((b, i) => (record(b) && b.type === "image" ? i : -1))
    .filter((i) => i >= 0);
  const refs = content
    .map((b, i) => (parseOfficialCuaImageRef(b) !== undefined ? i : -1))
    .filter((i) => i >= 0);
  if (images.length !== 1 || refs.length !== 1 || refs[0] !== images[0] + 1) return;
  const imageIndex = images[0],
    imageRefIndex = refs[0],
    image = content[imageIndex],
    imageRef = content[imageRefIndex];
  if (!parseOfficialCuaImageRef(imageRef)) return;
  return { image, imageRef, imageIndex, imageRefIndex };
}
export interface OfficialCuaFrameAttestation {
  kind: string;
  frameId: string;
  mediaType: string;
  width: number;
  height: number;
  sha256: string;
}
export function attestOfficialCuaFrameContent(
  content: unknown,
  expectedKind?: string,
): OfficialCuaFrameAttestation | undefined {
  if (expectedKind !== undefined && expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION)
    return;
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return;
  const ref = parseOfficialCuaImageRef(pair.imageRef)!;
  const dataUrl = pair.image.dataUrl,
    mime = pair.image.mediaType;
  if (
    typeof dataUrl !== "string" ||
    !["image/png", "image/jpeg"].includes(mime) ||
    !dataUrl.startsWith(`data:${mime};base64,`)
  )
    return;
  const bytes = decodeFrameBase64(dataUrl.slice(`data:${mime};base64,`.length));
  if (!bytes) return;
  const raster = readRasterEnvelopeIdentity(bytes);
  if (
    !raster ||
    raster.mimeType !== mime ||
    raster.width !== ref.width ||
    raster.height !== ref.height ||
    (raster.orientation !== undefined && raster.orientation !== 1)
  )
    return;
  return {
    kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    ...ref,
    mediaType: mime,
    sha256: sha256Hex(bytes),
  };
}
