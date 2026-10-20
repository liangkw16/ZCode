import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bugfix 回归：客户端中断下载时 pipe 不关源流（fd 泄漏）。vi.mock 提升后对模块注册表生效，
// staticFiles.ts 内的 createReadStream 也走 fake；其余 fs 导出保持真实实现。
const fakeStream = new PassThrough();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(() => fakeStream) };
});

import { createSelfHostStaticHandler } from "../src/adapters/staticFiles.js";

let root: string;
let server: Server;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "relay-static-fd-"));
  writeFileSync(join(root, "index.html"), "<html>x</html>");
  const handler = createSelfHostStaticHandler({ rootDir: root });
  server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("下载中断的流生命周期", () => {
  it("客户端中断后源流被销毁（不泄漏 fd）", async () => {
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/remote/v4`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    fakeStream.write("x".repeat(64));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fakeStream.destroyed).toBe(true);
  });
});
