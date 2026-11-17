import {
  containsImageRefAuthority,
  findOfficialCuaFrameContentPair,
  parseOfficialCuaImageRef,
  decodeFrameBase64,
  readRasterEnvelopeIdentity,
  sha256Hex,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  record,
  exact,
} from "../domain/frame.js";
type RecordValue = Record<string, any>;
export async function preserveOfficialCuaFrameResult<
  T extends { content?: unknown; isError?: boolean },
>(result: T, options?: any): Promise<T> {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const hasRef =
    containsImageRefAuthority(blocks) ||
    containsImageRefAuthority((result as RecordValue).structuredContent);
  if (!hasRef) return result;
  const reject = () =>
    ({
      content: [
        {
          type: "text",
          text: "Official computer-use frame failed integrity validation. Request a fresh screenshot.",
        },
      ],
      isError: true,
    }) as unknown as T;
  const pair = findOfficialCuaFrameContentPair(blocks);
  if (!pair || containsImageRefAuthority((result as RecordValue).structuredContent))
    return reject();
  const ref = parseOfficialCuaImageRef(pair.imageRef)!;
  const image = pair.image;
  const bytes = decodeFrameBase64(image.data);
  if (!bytes) return reject();
  const raster = readRasterEnvelopeIdentity(bytes),
    meta = (result as RecordValue)._meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  if (
    !raster ||
    !record(meta) ||
    !exact(meta, ["version", "frame_id", "width", "height", "media_type", "sha256"]) ||
    meta.version !== 1 ||
    meta.frame_id !== ref.frameId ||
    meta.width !== ref.width ||
    meta.height !== ref.height ||
    meta.media_type !== image.mimeType ||
    raster.mimeType !== image.mimeType ||
    raster.width !== ref.width ||
    raster.height !== ref.height ||
    (raster.orientation !== undefined && raster.orientation !== 1) ||
    meta.sha256 !== sha256Hex(bytes) ||
    !options?.imageProcessorPort?.resizeToFit
  )
    return reject();
  try {
    const processed = await options.imageProcessorPort.resizeToFit(
      { data: bytes, mediaType: image.mimeType, maxDimension: 4096 },
      { signal: options.signal },
    );
    const output = processed?.data;
    if (
      processed.resized !== false ||
      processed.width !== ref.width ||
      processed.height !== ref.height ||
      processed.originalWidth !== ref.width ||
      processed.originalHeight !== ref.height ||
      !(output instanceof Uint8Array) ||
      output.length !== bytes.length ||
      output.some((b: number, i: number) => b !== bytes[i])
    )
      return reject();
    return result;
  } catch {
    return reject();
  }
}
