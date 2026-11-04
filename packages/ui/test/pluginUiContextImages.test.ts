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
});
