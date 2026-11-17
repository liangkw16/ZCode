import { describe, it, expect } from "vitest";
import { createProductCuaHelperHost } from "../src/adapters/helper-host.js";
describe("Helper lifecycle ownership", () => {
  it("clears a failed start promise so the same host can try a repaired installation", async () => {
    let attempts = 0;
    const host = createProductCuaHelperHost({
      helperInstaller: {
        async ensureInstalled() {
          attempts++;
          throw new Error("fixture installation unavailable");
        },
        async verifyInstalled() {},
      },
    });
    await expect(host.start()).rejects.toThrow("fixture installation unavailable");
    await expect(host.start()).rejects.toThrow("fixture installation unavailable");
    expect(attempts).toBe(2);
    await host.stop();
  });
  it("coalesces simultaneous starts into one installation attempt", async () => {
    let attempts = 0;
    const host = createProductCuaHelperHost({
      helperInstaller: {
        async ensureInstalled() {
          attempts++;
          await Promise.resolve();
          throw new Error("no installation");
        },
        async verifyInstalled() {},
      },
    });
    await Promise.allSettled([host.start(), host.start(), host.start()]);
    expect(attempts).toBe(1);
    await host.stop();
  });
});

it("keeps a live silent socket owner instead of unlinking its transport and launching a second Helper", async () => {
  const { createServer } = await import("node:net");
  const { mkdtemp, mkdir, lstat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "kcua-host-"));
  const runtime = join(dir, "zcode-cua");
  await mkdir(runtime, { mode: 0o700 });
  const path = join(runtime, "kcode-broker.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const host = createProductCuaHelperHost({
    env: { XDG_RUNTIME_DIR: dir },
    helperInstaller: {
      async ensureInstalled() {
        return "/nonexistent/KCode Computer Use.app";
      },
      async verifyInstalled() {},
    },
  });
  try {
    await expect(host.start()).rejects.toMatchObject({ code: "timeout" });
    expect((await lstat(path)).isSocket()).toBe(true);
  } finally {
    await host.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true });
  }
});
