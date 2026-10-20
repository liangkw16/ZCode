import { afterEach, describe, expect, it, vi } from "vitest";

async function importFresh(rel: string) {
  vi.resetModules();
  return await import(rel);
}

describe("CLI 数据目录 segment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("define 注入 .kcode 时透出；未注入回落 .zcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    expect((await importFresh("../src/dataDirSegment.js")).ZCODE_DATA_DIR_SEGMENT).toBe(".kcode");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    expect((await importFresh("../src/dataDirSegment.js")).ZCODE_DATA_DIR_SEGMENT).toBe(".zcode");
  });

  it("saved-workflow 全局目录前缀跟随 segment", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    const { SAVED_WORKFLOW_GLOBAL_DIR } = await importFresh("../src/tools/saved-workflow.js");
    expect(SAVED_WORKFLOW_GLOBAL_DIR).toBe(".kcode/workflows");
  });
});
