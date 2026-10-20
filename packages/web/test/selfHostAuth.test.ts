import { describe, expect, it, vi } from "vitest";
import {
  createSelfHostAuth,
  isSelfHostRemoteBuild,
  readSelfHostKey,
} from "../src/web-remote-control/adapters/selfHostAuth.js";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("isSelfHostRemoteBuild", () => {
  it("注入任意非空值即启用；缺省/空白为 false", () => {
    expect(isSelfHostRemoteBuild({ VITE_ZCODE_REMOTE_SELF_HOSTED: "1" })).toBe(true);
    expect(isSelfHostRemoteBuild({})).toBe(false);
    expect(isSelfHostRemoteBuild({ VITE_ZCODE_REMOTE_SELF_HOSTED: "  " })).toBe(false);
  });
});

describe("readSelfHostKey", () => {
  it("从 #k= 解析并持久化；缺省回落 storage；全无则 null", () => {
    const storage = memoryStorage();
    expect(readSelfHostKey({ hash: "#k=abc123", storage })).toBe("abc123");
    expect(storage.getItem("zcode-self-host-key")).toBe("abc123");
    expect(readSelfHostKey({ hash: "#sid=x&k=def456", storage })).toBe("def456");
    expect(
      readSelfHostKey({ hash: "", storage: memoryStorage({ "zcode-self-host-key": "saved" }) }),
    ).toBe("saved");
    expect(readSelfHostKey({ hash: "", storage: memoryStorage() })).toBeNull();
    expect(readSelfHostKey({ hash: "#other=1", storage: memoryStorage() })).toBeNull();
  });
});

describe("createSelfHostAuth", () => {
  it("有密钥：JWT 即密钥并显示固定账号", () => {
    const auth = createSelfHostAuth("key-1", () => {});
    expect(auth.getZCodeJwtToken()).toBe("key-1");
    expect(auth.getActiveAccount()).toEqual({ displayName: "Self-host", provider: "zai" });
  });

  it("无密钥：JWT 为 null（entry 落 login 视图，由 main.tsx 拦截为失败页）", () => {
    const auth = createSelfHostAuth(null, () => {});
    expect(auth.getZCodeJwtToken()).toBeNull();
    expect(auth.getActiveAccount()).toBeNull();
  });

  it("startLogin/logout 落 failure，不引导 OAuth", () => {
    const onFailure = vi.fn();
    const auth = createSelfHostAuth("key-1", onFailure);
    auth.startLogin({ appReturnTo: "https://x/remote/v4" });
    expect(onFailure).toHaveBeenCalledWith({ reason: "relay-unavailable" });
    void auth.logout();
    expect(onFailure).toHaveBeenCalledTimes(2);
  });
});

describe("entry 集成", () => {
  it("无密钥时入口产出 login 视图 kind（自托管模式下 main.tsx 将其拦截为失败页）", async () => {
    const views: string[] = [];
    const entry = new WebRemoteControlEntry({
      auth: createSelfHostAuth(null, () => {}),
      token: async () => "t",
      connect: () => {},
      onView: (view) => views.push(view.kind),
      getHref: () => "https://ecs.example.com/remote/v4?app_version=3.16.1&sid=s&mid=m",
      devices: async () => [],
      replaceHref: () => {},
      storage: memoryStorage(),
      locale: "en-US",
      subscribeVisible: () => () => {},
    });
    await entry.start();
    expect(views).toEqual(["login"]);
  });

  it("有密钥且有 sid 时入口直接进入连接（token 收到密钥作为 jwt）", async () => {
    let tokenJwt = "";
    const entry = new WebRemoteControlEntry({
      auth: createSelfHostAuth("key-1", () => {}),
      token: async (jwt) => {
        tokenJwt = jwt;
        throw new Error("stop-here");
      },
      connect: (connection) => {
        // 模拟 transport 首个动作：申请一次性 token（token 端抛错终止后续流程即可）。
        void connection.getToken(new AbortController().signal).catch(() => {});
      },
      onView: () => {},
      getHref: () => "https://ecs.example.com/remote/v4?app_version=3.16.1&sid=s&mid=m",
      devices: async () => [],
      replaceHref: () => {},
      storage: memoryStorage(),
      locale: "en-US",
      subscribeVisible: () => () => {},
    });
    entry.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tokenJwt).toBe("key-1");
  });
});
