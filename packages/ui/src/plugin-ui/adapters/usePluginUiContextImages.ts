import { useEffect, useRef } from "react";
import type { PluginUiModelContext } from "../domain/pluginUiModelContext.js";
import { buildPluginUiImageFileName } from "../domain/pluginUiImageBlocks.js";

export interface PluginUiContextImagesPort {
  addAttachmentFiles(files: File[]): string[];
  removeAttachment(id: string): void;
}

function decodeBase64(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return buffer;
}

/**
 * 把插件上下文里的 image 块物化成 composer 图片附件（与粘贴截图同一条上传链路）。
 * 每条上下文的附件 id 记在这里：同一实例再次 updateModelContext（同 id、新对象）或用户移除该上下文时，
 * 旧附件一并撤掉；发送后附件由 composer 自己按冻结 id 清理，这里的撤销对已清理的 id 是 no-op。
 */
// Bug 修复（上游同步审查 2026-11-04）：上下文列表随 pluginUiModelContextEvents 的模块级
// store 跨 Composer 卸载存活，附件也由 composerAttachmentUploadStore 跨卸载保留；映射若
// 只放组件 useRef，重新挂载后映射为空、`existing?.context === context` 失效，同一上下文的
// 图片会被再次 addAttachmentFiles（重复上传/发送/占用附件名额）。映射提升为模块级，与上下文
// store 同生命周期；发送或清空上下文时由清理路径连带撤销附件（对已清理 id 为 no-op）。
const materialized = new Map<
  string,
  { context: PluginUiModelContext; ids: string[] }
>();

/** 上下文 → 附件的同步核心；独立导出以便单测模拟"重挂载后再次同步"（映射在模块级存续）。 */
export function syncPluginUiContextImages(
  contexts: readonly PluginUiModelContext[],
  port: PluginUiContextImagesPort,
): void {
  const seen = new Set<string>();
  for (const context of contexts) {
    seen.add(context.id);
    const existing = materialized.get(context.id);
    if (existing?.context === context) continue;
    if (existing) {
      for (const id of existing.ids) port.removeAttachment(id);
      materialized.delete(context.id);
    }
    const images = context.images ?? [];
    if (images.length === 0) continue;
    const files = images.map(
      (image, index) =>
        new File(
          [decodeBase64(image.dataBase64)],
          buildPluginUiImageFileName(context.pluginId, index, image.mimeType),
          {
            type: image.mimeType,
          },
        ),
    );
    materialized.set(context.id, {
      context,
      ids: port.addAttachmentFiles(files),
    });
  }
  for (const [id, entry] of materialized) {
    if (seen.has(id)) continue;
    for (const attachmentId of entry.ids) port.removeAttachment(attachmentId);
    materialized.delete(id);
  }
}

/** 仅测试复位：模块级映射在用例间需要隔离（沿用仓库 *ForTest 导出惯例）。 */
export function resetPluginUiContextImagesForTest(): void {
  materialized.clear();
}

export function usePluginUiContextImages(
  contexts: readonly PluginUiModelContext[],
  port: PluginUiContextImagesPort,
): void {
  const portRef = useRef(port);
  portRef.current = port;
  useEffect(() => {
    syncPluginUiContextImages(contexts, portRef.current);
  }, [contexts]);
}
