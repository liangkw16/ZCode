import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";

export interface SelfHostStaticHandlerOptions {
  rootDir: string;
  urlPrefix?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function createSelfHostStaticHandler(options: SelfHostStaticHandlerOptions) {
  const prefix = options.urlPrefix ?? "/remote/v4";
  const rootDir = resolvePath(options.rootDir);
  // Bugfix：文件流错误（目录缺失/被删、EACCES）若不接管，createReadStream 的 ENOENT 会成为
  // 未处理异常直接打死进程；统一先校验存在、再监听流错误降级 404。
  const streamFile = (target: string, response: ServerResponse): boolean => {
    const stream = createReadStream(target);
    stream.on("error", () => {
      if (!response.headersSent) response.writeHead(404);
      response.destroy();
    });
    stream.pipe(response);
    return true;
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    response.on("error", () => {});
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === prefix || url.pathname === `${prefix}/`) {
      const entry = join(rootDir, "index.html");
      if (!(await existsFile(entry))) return response.writeHead(404).end(), true;
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[".html"]!,
        "Cache-Control": "no-cache",
      });
      if (request.method === "HEAD") return response.end(), true;
      return streamFile(entry, response);
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return response.writeHead(400).end(), true;
    }
    if (decoded.includes("\0")) return response.writeHead(404).end(), true;
    // Bugfix：decodeURIComponent 后再 resolve + 前缀校验，堵住 %2e%2e 编码穿越；
    // 解析结果必须仍位于 rootDir 内，否则一律 404，不读取任何根外文件。
    const target = resolvePath(join(rootDir, decoded));
    if (target !== rootDir && !target.startsWith(rootDir + sep)) {
      return response.writeHead(404).end(), true;
    }
    if (!(await existsFile(target))) return response.writeHead(404).end(), true;
    const contentType = MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    // Vite hash 资源形如 app-abc12345.js（连字符分隔）；点分隔（xxx.abc12345.js）一并兼容。
    const immutable = /[-.][0-9a-f]{8,}\.(js|css|woff2|png|svg)$/i.test(target);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (request.method === "HEAD") return response.end(), true;
    return streamFile(target, response);
  };
}
