import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("电脑控制权限状态（候选）", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => {
      const state = window as any;
      state.__testActions.setLocale("zh-CN");
      let fiber = document.querySelector("[data-testid]") as any;
      fiber = fiber[Object.keys(fiber).find((key) => key.startsWith("__reactFiber"))!];
      const accessors = new Set<any>();
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.cuaPermissionService ? value : fiber.memoizedProps?.services;
        if (services?.cuaPermissionService) accessors.add(services);
        fiber = fiber.return;
      }
      if (!accessors.size) throw new Error("Missing CUA permission service");
      state.__cuaPermissionMode = "unavailable";
      state.__cuaPermissionProbeRequested = false;
      state.__cuaPermissionRestorers = [];
      for (const services of accessors) {
        const original = services.cuaPermissionService;
        // RPC Proxy 的 get 会忽略实例上的方法赋值；替换 accessor 才能注入确定的故障场景。
        services.cuaPermissionService = new Proxy(original, {
          get(target, prop) {
            if (prop !== "getStatus") return Reflect.get(target, prop);
            return async (_path: string, _identity: string, options: any) => {
              state.__cuaPermissionProbeRequested ||= options?.includeFunctionalProbes === true;
              if (state.__cuaPermissionMode === "reject") throw new Error("E2E permission RPC fault");
              if (state.__cuaPermissionMode === "granted")
                return {
                  grantOwner: "ZCode Computer Use",
                  accessibility: "granted",
                  screenRecording: "granted",
                };
              return { available: false, reason: "E2E Helper unavailable" };
            };
          },
        });
        state.__cuaPermissionRestorers.push(() => {
          services.cuaPermissionService = original;
        });
      }
      window.dispatchEvent(new Event("focus"));
    });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "computerUse"));
    const enabled = $('[role="switch"][aria-label="启用电脑控制"]');
    await enabled.waitForDisplayed();
    await browser.waitUntil(() => enabled.isEnabled());
    if ((await enabled.getAttribute("aria-checked")) !== "true") await enabled.click();
  });

  after(async () => {
    await browser.execute(() => {
      const state = window as any;
      for (const restore of state.__cuaPermissionRestorers ?? []) restore();
      delete state.__cuaPermissionRestorers;
      delete state.__cuaPermissionMode;
      delete state.__cuaPermissionProbeRequested;
    });
    await clearAppData();
  });

  it("CU-58：不可用和查询异常结束等待，重试恢复真实授权结果", async function () {
    this.timeout(60_000);
    const page = $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
    await browser.waitUntil(async () => (await page.getText()).includes("无法检查电脑控制权限"), {
      timeout: 20_000,
    });
    expect(await page.getText()).not.toContain("已授权，正在验证");
    await browser.execute(() => {
      (window as any).__cuaPermissionMode = "reject";
    });
    await page.$("button=重新检查").click();
    await browser.waitUntil(async () => !(await page.$("button=重新检查").isEnabled()));
    await browser.waitUntil(async () => await page.$("button=重新检查").isEnabled(), {
      timeout: 20_000,
    });
    expect(await page.getText()).toContain("无法检查电脑控制权限");
    await browser.execute(() => {
      (window as any).__cuaPermissionMode = "granted";
    });
    await page.$("button=重新检查").click();
    await browser.waitUntil(async () => !(await page.getText()).includes("无法检查电脑控制权限"), {
      timeout: 20_000,
    });
    expect((await page.getText()).match(/已授权/g)?.length).toBe(2);
    expect(await browser.execute(() => (window as any).__cuaPermissionProbeRequested)).toBe(false);
  });
});
