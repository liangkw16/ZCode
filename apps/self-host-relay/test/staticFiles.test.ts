import { createServer, get as httpGet, type IncomingMessage, type Server } from "node:http";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
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

/** 编码协商与预压缩 sidecar（spec 追记三 §3.2）。原生 http 客户端取原始响应，防 fetch 自动解压掩盖错误。 */
interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

describe("静态托管：编码协商与 sidecar", () => {
  let server3: Server;
  let base3: string;
  let root3: string;
  const ORIGINAL_JS = "console.log(" + "'x'.repeat(64)".repeat(20) + ")";

  beforeAll(async () => {
    root3 = mkdtempSync(join(tmpdir(), "relay-static-nego-"));
    dirs.push(root3);
    writeFileSync(join(root3, "index.html"), "<html>nego</html>");
    writeFileSync(join(root3, "index.html.gz"), gzipSync(Buffer.from("<html>nego</html>")));
    mkdirSync(join(root3, "assets"));
    writeFileSync(join(root3, "assets", "index-B_ib1VwN.js"), ORIGINAL_JS);
    writeFileSync(join(root3, "assets", "index-B_ib1VwN.js.br"), brotliCompressSync(Buffer.from(ORIGINAL_JS)));
    writeFileSync(join(root3, "assets", "index-B_ib1VwN.js.gz"), gzipSync(Buffer.from(ORIGINAL_JS)));
    // 只有原文的文件（sidecar 缺失场景）
    writeFileSync(join(root3, "assets", "plain-XYZxyz12.css"), "body{color:red}");
    writeFileSync(join(root3, "img-ABCabc34.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const handler = createSelfHostStaticHandler({ rootDir: root3 });
    server3 = createServer((request, response) => {
      void handler(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    server3.listen(0, "127.0.0.1");
    await once(server3, "listening");
    base3 = `http://127.0.0.1:${(server3.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    server3.closeAllConnections();
    await new Promise<void>((resolve) => server3.close(() => resolve()));
  });

  function rawGet(path: string, acceptEncoding?: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const request =
        acceptEncoding === undefined
          ? httpGet(`${base3}${path}`, (response) => collect(response, resolve))
          : httpGet(
              `${base3}${path}`,
              { headers: { "Accept-Encoding": acceptEncoding } },
              (response) => collect(response, resolve),
            );
      request.on("error", reject);
    });
  }

  function collect(response: IncomingMessage, resolve: (value: RawResponse) => void): void {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () =>
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }),
    );
  }

  it("真实 Vite hash 文件名命中 immutable（既有 hex-only 正则的回归）", async () => {
    const response = await rawGet("/remote/v4/assets/index-B_ib1VwN.js");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("仅 gzip → 返回 .gz；仅 br → 返回 .br；解压后逐字节等于原文", async () => {
    const gz = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", "gzip");
    expect(gz.status).toBe(200);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers["vary"]).toBe("Accept-Encoding");
    expect(gz.body.equals(gzipSync(Buffer.from(ORIGINAL_JS)))).toBe(true);
    expect(gunzipSync(gz.body).toString()).toBe(ORIGINAL_JS);

    const br = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", "br");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.body).toString()).toBe(ORIGINAL_JS);
  });

  it("同权重 gzip,br 优先 br；q 权重生效（br;q=0 → gzip）", async () => {
    const both = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", "gzip, br");
    expect(both.headers["content-encoding"]).toBe("br");
    const noBr = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", "gzip;q=1, br;q=0");
    expect(noBr.headers["content-encoding"]).toBe("gzip");
    const gzipWins = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", "br;q=0.5, gzip;q=1");
    expect(gzipWins.headers["content-encoding"]).toBe("gzip");
  });

  it("通配符 * 视为可用压缩；identity 权重高于压缩时回退原文", async () => {
    const wildcard = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", "*");
    expect(wildcard.headers["content-encoding"]).toBe("br");
    const identityWins = await rawGet(
      "/remote/v4/assets/index-B_ib1VwN.js",
      "br;q=0.5, gzip;q=0.5",
    );
    expect(identityWins.headers["content-encoding"]).toBeUndefined();
    expect(identityWins.body.toString()).toBe(ORIGINAL_JS);
    expect(identityWins.headers["vary"]).toBe("Accept-Encoding");
  });

  it("identity 被禁且无可用压缩表示 → 406", async () => {
    const response = await rawGet(
      "/remote/v4/assets/index-B_ib1VwN.js",
      "identity;q=0, br;q=0, gzip;q=0",
    );
    expect(response.status).toBe(406);
  });

  it("无头/空头保守回退原文（无 Content-Encoding）", async () => {
    for (const header of [undefined, ""]) {
      const response = await rawGet("/remote/v4/assets/index-B_ib1VwN.js", header);
      expect(response.status).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.body.toString()).toBe(ORIGINAL_JS);
    }
  });

  it("sidecar 缺失回退原文；非可协商资源无 Vary", async () => {
    const plain = await rawGet("/remote/v4/assets/plain-XYZxyz12.css", "gzip, br");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe("body{color:red}");
    expect(plain.headers["vary"]).toBe("Accept-Encoding");
    const png = await rawGet("/remote/v4/img-ABCabc34.png", "gzip, br");
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.headers["vary"]).toBeUndefined();
  });

  it("sidecar 文件直接访问一律 404", async () => {
    for (const path of [
      "/remote/v4/assets/index-B_ib1VwN.js.br",
      "/remote/v4/assets/index-B_ib1VwN.js.gz",
      "/remote/v4/index.html.gz",
      "/remote/v4/assets/index-B_ib1VwN.js%2Ebr",
    ]) {
      expect((await rawGet(path)).status, path).toBe(404);
    }
  });

  it("入口 index.html 走同一协商（gzip + no-cache + Vary）", async () => {
    const response = await rawGet("/remote/v4/", "gzip");
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["vary"]).toBe("Accept-Encoding");
    expect(gunzipSync(response.body).toString()).toBe("<html>nego</html>");
  });

  it("HEAD 同选择无正文，Content-Length 为压缩长度", async () => {
    const response = await new Promise<RawResponse>((resolve, reject) => {
      const request = httpGet(
        `${base3}/remote/v4/assets/index-B_ib1VwN.js`,
        { method: "HEAD", headers: { "Accept-Encoding": "gzip" } } as never,
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      request.on("error", reject);
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(Number(response.headers["content-length"])).toBe(
      gzipSync(Buffer.from(ORIGINAL_JS)).length,
    );
    expect(response.body.length).toBe(0);
  });
});
