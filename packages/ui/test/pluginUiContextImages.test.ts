import { beforeEach, describe, expect, it } from "vitest";
import {
  resetPluginUiContextImagesForTest,
  syncPluginUiContextImages,
} from "@/plugin-ui/adapters/usePluginUiContextImages.js";
import type { PluginUiModelContext } from "@/plugin-ui/domain/pluginUiModelContext.js";

function makePort() {
  const added: string[][] = [];
  const removed: string[] = [];
  let seq = 0;
  return {
    added,
    removed,
    port: {
      scopeKey: "scope-1",
      addAttachmentFiles: (files: File[]) => {
        const ids = files.map(() => `att-${++seq}`);
        added.push(ids);
        return ids;
      },
      removeAttachment: (id: string) => {
        removed.push(id);
      },
    },
  };
}

function context(images = 1): PluginUiModelContext {
  return {
    id: "ctx-1",
    sessionId: "s1",
    pluginId: "demo",
    toolCallId: "tc",
    text: "context",
    ...(images
      ? {
          images: Array.from({ length: images }, () => ({
            mimeType: "image/png",
            dataBase64: Buffer.from("fake").toString("base64"),
          })),
        }
      : {}),
  };
}

describe("plugin ui context images", () => {
  beforeEach(() => {
    resetPluginUiContextImagesForTest();
  });

  it("re-syncing the same contexts after a remount does not add duplicate attachments", () => {
    // 上游同步审查 P2 回归：上下文与附件都跨卸载存活，映射也必须跨卸载存续；
    // 旧行为（组件 useRef）在重挂载后对同一上下文重复 addAttachmentFiles。
    const { added, removed, port } = makePort();
    const ctx = context(1);
    syncPluginUiContextImages([ctx], port);
    expect(added).toHaveLength(1);
    // 模拟 Composer 卸载后重新挂载：新的同步调用、同一上下文对象。
    syncPluginUiContextImages([ctx], port);
    expect(added).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it("replaces attachments when the same context id pushes a new object", () => {
    const { added, removed, port } = makePort();
    syncPluginUiContextImages([context(1)], port);
    const updated = context(2);
    syncPluginUiContextImages([updated], port);
    expect(added).toHaveLength(2);
    expect(removed).toEqual(["att-1"]);
  });

  it("removes attachments when the context disappears from the list", () => {
    const { added, removed, port } = makePort();
    syncPluginUiContextImages([context(1)], port);
    syncPluginUiContextImages([], port);
    expect(added).toHaveLength(1);
    expect(removed).toEqual(["att-1"]);
  });

  it("keeps each composer scope's attachments separate in split screen", () => {
    // 修复回归：映射原先按上下文 id 全局共享。分屏下 A 为一条上下文附加了图片，B 同步空列表时
    // 会把这条映射清掉，而 B 的 removeAttachment 只作用于 B 的附件作用域；之后 A 再移除该上下文时
    // 已找不到要撤的附件，图片留在 A 的附件里随下一条消息发出。
    const a = makePort();
    const b = makePort();
    b.port.scopeKey = "scope-2";
    const ctx = context(1);
    syncPluginUiContextImages([ctx], a.port);
    syncPluginUiContextImages([], b.port);
    expect(a.added).toHaveLength(1);
    expect(b.added).toHaveLength(0);
    // B 同步空列表碰不到 A 的附件；它的 removeAttachment 也只作用于 B 的作用域。
    expect(a.removed).toEqual([]);
    expect(b.removed).toEqual([]);
    // 同一条上下文在两个作用域里各自附加；A 移除时只撤 A 的附件。
    syncPluginUiContextImages([ctx], b.port);
    expect(b.added).toHaveLength(1);
    syncPluginUiContextImages([], a.port);
    expect(a.removed).toEqual(["att-1"]);
    expect(b.removed).toEqual([]);
    syncPluginUiContextImages([], b.port);
    expect(b.removed).toEqual(["att-1"]);
  });
});
