import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSelfHostStaticHandler } from "../src/adapters/staticFiles.js";

let server: Server;
let baseUrl: string;
let root: string;
const dirs: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "relay-static-"));
  dirs.push(root);
  writeFileSync(join(root, "index.html"), "<html>remote-v4</html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc12345.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "top-secret");
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
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("静态托管", () => {
  it("/remote/v4 与 /remote/v4/ 返回 index.html（no-cache）", async () => {
    for (const path of ["/remote/v4", "/remote/v4/"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("remote-v4");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("hash 资源命中并以 immutable 缓存头返回", async () => {
    const response = await fetch(`${baseUrl}/remote/v4/assets/app-abc12345.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log(1)");
  });

  it("拒绝路径穿越（编码与明文 ../ 均根外 404）", async () => {
    const paths = [
      "/remote/v4/../secret.txt",
      "/remote/v4/%2e%2e/secret.txt",
      "/remote/v4/%2E%2E%2Fsecret.txt",
      "/remote/v4/..%2f..%2fetc/passwd",
      "/remote/v4/assets/../../secret.txt",
    ];
    for (const path of paths) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("缺失文件 404；非前缀路径与非 GET 未处理", async () => {
    expect((await fetch(`${baseUrl}/remote/v4/missing.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/other`)).status).toBe(404);
    const post = await fetch(`${baseUrl}/remote/v4`, { method: "POST" });
    expect(post.status).toBe(404); // handler 返回 false，外层 404
  });

  it("目录存在但缺 index.html（或目录不存在）时根路径 404 且进程不崩", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "relay-static-empty-"));
    dirs.push(emptyRoot);
    const handler = createSelfHostStaticHandler({ rootDir: emptyRoot });
    const isolated = createServer((request, response) => {
      void handler(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    isolated.listen(0, "127.0.0.1");
    await once(isolated, "listening");
    const url = `http://127.0.0.1:${(isolated.address() as { port: number }).port}/remote/v4`;
    try {
      expect((await fetch(url)).status).toBe(404); // 不再 200 + ENOENT 崩进程
    } finally {
      isolated.closeAllConnections();
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
  });
});
