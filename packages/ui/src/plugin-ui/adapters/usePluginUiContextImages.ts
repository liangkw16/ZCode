import { useEffect, useRef, useState } from "react";
import type { PluginUiModelContext } from "../domain/pluginUiModelContext.js";
import { buildPluginUiImageFileName } from "../domain/pluginUiImageBlocks.js";

export interface ContextImageAttachmentsPort {
  addAttachmentFiles(files: File[]): string[];
  removeAttachment(id: string): void;
}

/**
 * 撤附件的语义按调用方区分，插件上下文保持原有行为：
 * - removeStrategy "current"：撤销时用当下的 removeAttachment（第三方插件上下文原语义：切会话后在新 scope 上撤，
 *   旧会话的附件留在旧 scope，切回仍在）；"attached"：用附加那一刻的 removeAttachment（网页元素 chip：
 *   切会话时把旧 scope 里的截图一并撤掉，切回时随条目重新附加一张）。
 */
export interface ContextImageAttachmentsOptions<T> {
  toFiles: (context: T) => File[];
  removeStrategy: "current" | "attached";
}

interface MaterializedContext<T> {
  context: T;
  ids: string[];
  /** 附加那一刻的 removeAttachment（removeStrategy "attached" 时用） */
  remove: (id: string) => void;
}

/**
 * 把上下文条目带的图片物化成 composer 图片附件（与粘贴截图同一条预上传链路），插件上下文与网页元素 chip 共用。
 * 每条上下文的附件 id 记在这里：同 id 的新对象（再次 updateModelContext / chip 覆盖）或条目被移除时，
 * 旧附件一并撤掉；发送后附件由 composer 自己按冻结 id 清理，这里的撤销对已清理的 id 是 no-op。
 * 附件满额时 addAttachmentFiles 自己提示并返回 []，条目照常只带文字。
 */
export function useContextImageAttachments<T extends { id: string }>(
  contexts: readonly T[],
  port: ContextImageAttachmentsPort,
  options: ContextImageAttachmentsOptions<T>,
): ReadonlySet<string> {
  const materialized = useRef(new Map<string, MaterializedContext<T>>());
  /** 这里管着的附件 id：调用方可以据此只在条目上展示（如网页元素引用不在附件行重复出缩略图） */
  const [managedIds, setManagedIds] = useState<ReadonlySet<string>>(() => new Set());
  const portRef = useRef(port);
  portRef.current = port;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    const { toFiles, removeStrategy } = optionsRef.current;
    const release = (entry: MaterializedContext<T>) => {
      const remove =
        removeStrategy === "attached" ? entry.remove : portRef.current.removeAttachment;
      for (const id of entry.ids) {
        remove(id);
      }
    };
    const seen = new Set<string>();
    for (const context of contexts) {
      seen.add(context.id);
      const existing = materialized.current.get(context.id);
      if (existing?.context === context) continue;
      if (existing) {
        release(existing);
        materialized.current.delete(context.id);
      }
      const files = toFiles(context);
      if (files.length === 0) continue;
      materialized.current.set(context.id, {
        context,
        ids: portRef.current.addAttachmentFiles(files),
        remove: portRef.current.removeAttachment,
      });
    }
    for (const [id, entry] of materialized.current) {
      if (seen.has(id)) continue;
      release(entry);
      materialized.current.delete(id);
    }
    const ids = new Set([...materialized.current.values()].flatMap((entry) => entry.ids));
    setManagedIds((current) =>
      current.size === ids.size && [...ids].every((id) => current.has(id)) ? current : ids,
    );
  }, [contexts]);
  // Bugfix（!3450 CR-01）：映射只活在这个 ref 里。composer 卸载（关分屏等）再挂回同一会话时映射是空的，
  // 条目还在就会再加一张截图；之后删条目只撤新的那张，旧截图留在附件里随下一轮发出去。
  // "attached" 的附件归这里管，卸载时一并撤掉、清空映射，重挂按条目重新附加，始终一张。
  // "current"（第三方插件）维持原语义不动。
  useEffect(() => {
    const entries = materialized.current;
    return () => {
      if (optionsRef.current.removeStrategy !== "attached") return;
      for (const entry of entries.values()) {
        for (const id of entry.ids) entry.remove(id);
      }
      entries.clear();
    };
  }, []);
  return managedIds;
}

function decodeBase64(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function pluginUiContextImageFiles(context: PluginUiModelContext): File[] {
  return (context.images ?? []).map(
    (image, index) =>
      new File(
        [decodeBase64(image.dataBase64)],
        buildPluginUiImageFileName(context.pluginId, index, image.mimeType),
        { type: image.mimeType },
      ),
  );
}

/**
 * 把插件上下文里的 image 块物化成 composer 图片附件（与粘贴截图同一条上传链路）。
 * 每条上下文的附件 id 记在这里：同一实例再次 updateModelContext（同 id、新对象）或用户移除该上下文时，
 * 旧附件一并撤掉；发送后附件由 composer 自己按冻结 id 清理，这里的撤销对已清理的 id 是 no-op。
 */
// Bug 修复（上游同步审查 2026-11-04，v3.18 同步保留）：上下文列表随 pluginUiModelContextEvents 的
// 模块级 store 跨 Composer 卸载存活，附件也由 composerAttachmentUploadStore 跨卸载保留；上游
// v3.18 的通用 useContextImageAttachments 仍用组件级 useRef 映射且 "current" 策略卸载不清理，
// 重挂载后同一上下文的图片会被再次 addAttachmentFiles（重复上传/发送/占用附件名额）。插件路径
// 维持我们的模块级映射（与上下文 store 同生命周期）；网页元素 chip 走上游通用 hook（卸载撤、重挂补）。
//
// 修复原因：这张映射原先按上下文 id 全局共享。分屏下 A 为一条上下文附加了图片，B 同步空列表时
// 会把这条映射清掉，而 B 的 removeAttachment 只作用于 B 的附件作用域；之后 A 再移除该上下文时
// 已找不到要撤的附件 id，图片留在 A 的附件里随下一条消息发出。现在按 composer 的附件作用域
// （workspace + 会话，与附件 store 同一个 key）各存一张表，每个 composer 只同步和清理自己的条目。
interface MaterializedPluginContext {
  context: PluginUiModelContext;
  ids: string[];
}
const materializedByScope = new Map<string, Map<string, MaterializedPluginContext>>();

export interface PluginContextImagePort extends ContextImageAttachmentsPort {
  /** composer 的附件作用域 key（workspace + 会话）。 */
  scopeKey: string;
}

/** 上下文 → 附件的同步核心；独立导出以便单测模拟"重挂载后再次同步"（映射在模块级存续）。 */
export function syncPluginUiContextImages(
  contexts: readonly PluginUiModelContext[],
  port: PluginContextImagePort,
): void {
  let materialized = materializedByScope.get(port.scopeKey);
  if (!materialized) {
    materialized = new Map();
    materializedByScope.set(port.scopeKey, materialized);
  }
  const seen = new Set<string>();
  for (const context of contexts) {
    seen.add(context.id);
    const existing = materialized.get(context.id);
    if (existing?.context === context) continue;
    if (existing) {
      for (const id of existing.ids) port.removeAttachment(id);
      materialized.delete(context.id);
    }
    const files = pluginUiContextImageFiles(context);
    if (files.length === 0) continue;
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
  materializedByScope.clear();
}

/** 插件上下文里的 image 块 → 本条上下文名下的图片附件，随下一回合发送。 */
export function usePluginUiContextImages(
  contexts: readonly PluginUiModelContext[],
  port: PluginContextImagePort,
): void {
  const portRef = useRef(port);
  portRef.current = port;
  useEffect(() => {
    syncPluginUiContextImages(contexts, portRef.current);
  }, [contexts]);
}
