import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_API_KEY_PROVIDER_ITEM,
  TID_LOGIN_API_KEY_PROVIDER_TRIGGER,
  TID_LOGIN_USE_API_KEY_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import { getV4ModelConfig, waitForV4ComposerSelectionReady } from "#e2e/helpers/v4-conversation";

describe("API Key 登录后恢复原 Provider", () => {
  after(clearAppData);

  it("保存 BigModel API Key 后，同一桌面 profile 冷启动直接进入工作区", async function () {
    this.timeout(150_000);
    const settingsPath = join(getE2EAppDataPaths().appDataDir, "setting.json");
    const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf8"));
    expect((await readSettings()).providerFamilyDomain ?? null).toBeNull();

    await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, { timeout: 30_000 });
    await clickTestIdByDom(TID_LOGIN_API_KEY_PROVIDER_TRIGGER);
    await clickTestIdByDom(testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "bigmodel"));
    await setInputValueByTestIdDom(TID_LOGIN_API_KEY_INPUT, "e2e-cold-start-key");
    await clickTestIdByDom(TID_LOGIN_API_KEY_CONTINUE_BUTTON);
    await waitForDefaultWorkspaceReady(30_000);
    await waitForV4ComposerSelectionReady(30_000);
    const configured = await getV4ModelConfig();
    expect(configured.provider).toBeTruthy();
    expect(configured.model).toBeTruthy();

    // 先检查持久化，旧表单只保存 Provider，重启会被缺运行域的门禁挡回欢迎页。
    expect((await readSettings()).providerFamilyDomain).toBe("bigmodel");
    await restartIntoWorkspacePreservingProfile();
    await waitForV4ComposerSelectionReady(30_000);
    expect(await getV4ModelConfig()).toMatchObject({
      provider: configured.provider,
      model: configured.model,
    });
  });
});
