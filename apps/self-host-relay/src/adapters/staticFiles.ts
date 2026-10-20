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

/** 可预压缩协商的文本扩展（spec 追记三 §3.2）；.map/字体/图片不参与。 */
const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".xml"]);

interface FileStat {
  path: string;
  size: number;
}

async function statFile(path: string): Promise<FileStat | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? { path, size: stats.size } : null;
  } catch {
    return null;
  }
}

/**
 * RFC 9110 Accept-Encoding 解析：返回显式 token → q 权重（token 小写，含 "*"）。
 * null 表示无头/空头/全非法——保守按 identity 处理。
 */
function parseAcceptEncoding(raw: string | undefined): Map<string, number> | null {
  const header = Array.isArray(raw) ? raw.join(", ") : raw;
  if (!header || !header.trim()) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [tokenPart, ...params] = part.split(";");
    const token = (tokenPart ?? "").trim().toLowerCase();
    if (!token) continue;
    let weight = 1;
    const qParam = params.find((param) => param.trim().toLowerCase().startsWith("q="));
    if (qParam !== undefined) {
      const parsed = Number.parseFloat(qParam.slice(qParam.indexOf("=") + 1));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) continue; // 非法 part 丢弃
      weight = parsed;
    }
    weights.set(token, weight);
  }
  return weights.size > 0 ? weights : null;
}

interface NegotiatedRepresentation {
  file: FileStat;
  /** 压缩表示的 Content-Encoding；undefined = 原文。 */
  encoding?: "br" | "gzip";
}

/**
 * 编码协商（spec 追记三 §3.2）：可用表示按 q 权重取最高、同权重优先 br；
 * identity 权重不低于最佳压缩表示时回退原文；identity 被禁且无可用压缩表示 → 406。
 * 无 Accept-Encoding 头保守回退原文。
 */
function negotiateRepresentation(
  target: FileStat,
  sidecars: { br: FileStat | null; gzip: FileStat | null },
  acceptEncoding: Map<string, number> | null,
): NegotiatedRepresentation | "not-acceptable" {
  const explicit = acceptEncoding ?? new Map();
  const wildcard = explicit.get("*");
  const identityWeight = explicit.get("identity") ?? wildcard ?? 1;
  let best: { encoding: "br" | "gzip"; weight: number; file: FileStat } | null = null;
  for (const encoding of ["br", "gzip"] as const) {
    const sidecar = sidecars[encoding];
    if (!sidecar) continue;
    const weight = explicit.get(encoding) ?? wildcard ?? 0;
    if (weight <= 0) continue;
    // 同权重优先 br：遍历顺序 br 在前，仅严格大于才替换。
    if (!best || weight > best.weight) best = { encoding, weight, file: sidecar };
  }
  if (best && best.weight >= identityWeight) return { file: best.file, encoding: best.encoding };
  if (identityWeight > 0) return { file: target };
  return "not-acceptable";
}

export function createSelfHostStaticHandler(options: SelfHostStaticHandlerOptions) {
  const prefix = options.urlPrefix ?? "/remote/v4";
  const rootDir = resolvePath(options.rootDir);
  // Bugfix：文件流错误（目录缺失/被删、EACCES）若不接管，createReadStream 的 ENOENT 会成为
  // 未处理异常直接打死进程；统一先校验存在、再监听流错误降级 404。
  const streamFile = (target: string, response: ServerResponse): boolean => {
    const stream = createReadStream(target);
    // Bugfix：客户端中断下载时 pipe 不会关源流（fd 泄漏，反复中断可耗尽句柄）；
    // 响应关闭即销毁源流，流自身错误也降级销毁。
    response.on("close", () => stream.destroy());
    // 立即刷出响应头：文件流在首块前不发送任何字节，否则客户端要等到首个 chunk 才见到 200。
    response.flushHeaders();
    stream.on("error", () => {
      if (!response.headersSent) response.writeHead(404);
      response.destroy();
    });
    stream.pipe(response);
    return true;
  };
  const respondFile = (
    request: IncomingMessage,
    response: ServerResponse,
    representation: NegotiatedRepresentation,
    contentType: string,
    cacheControl: string,
    negotiable: boolean,
  ): boolean => {
    const headers: Record<string, string | number> = {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    };
    // 所有可协商资源（含原文回退）都必须带 Vary：缓存键按 Accept-Encoding 区分表示。
    if (negotiable) headers["Vary"] = "Accept-Encoding";
    if (representation.encoding) {
      headers["Content-Encoding"] = representation.encoding;
      headers["Content-Length"] = representation.file.size;
    }
    response.writeHead(200, headers);
    if (request.method === "HEAD") return response.end(), true;
    return streamFile(representation.file.path, response);
  };
  const negotiateAndServe = async (
    request: IncomingMessage,
    response: ServerResponse,
    target: FileStat,
    contentType: string,
    cacheControl: string,
  ): Promise<boolean> => {
    let representation: NegotiatedRepresentation = { file: target };
    let negotiable = false;
    if (COMPRESSIBLE_EXTENSIONS.has(extname(target.path).toLowerCase())) {
      negotiable = true;
      // sidecar 派生前先确认原文件合法存在；直接请求 .br/.gz 在路径层已 404。
      const [br, gzip] = await Promise.all([
        statFile(`${target.path}.br`),
        statFile(`${target.path}.gz`),
      ]);
      const negotiated = negotiateRepresentation(
        target,
        { br, gzip },
        parseAcceptEncoding(request.headers["accept-encoding"]),
      );
      if (negotiated === "not-acceptable") return response.writeHead(406).end(), true;
      representation = negotiated;
    }
    return respondFile(request, response, representation, contentType, cacheControl, negotiable);
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    response.on("error", () => {});
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === prefix || url.pathname === `${prefix}/`) {
      const entry = await statFile(join(rootDir, "index.html"));
      if (!entry) return response.writeHead(404).end(), true;
      return negotiateAndServe(
        request,
        response,
        entry,
        MIME_TYPES[".html"]!,
        // 入口 HTML 必须可协商但保持 no-cache：发版即生效，压缩不改变更新策略。
        "no-cache",
      );
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return response.writeHead(400).end(), true;
    }
    if (decoded.includes("\0")) return response.writeHead(404).end(), true;
    // 预压缩 sidecar 仅内部使用：直接请求 .br/.gz 一律 404，不暴露压缩资产探测面。
    if (/\.(br|gz)$/i.test(decoded)) return response.writeHead(404).end(), true;
    // Bugfix：decodeURIComponent 后再 resolve + 前缀校验，堵住 %2e%2e 编码穿越；
    // 解析结果必须仍位于 rootDir 内，否则一律 404，不读取任何根外文件。
    const target = await statFile(resolvePath(join(rootDir, decoded)));
    if (!target) return response.writeHead(404).end(), true;
    if (target.path !== rootDir && !target.path.startsWith(rootDir + sep)) {
      return response.writeHead(404).end(), true;
    }
    const contentType = MIME_TYPES[extname(target.path).toLowerCase()] ?? "application/octet-stream";
    // Vite hash 资源形如 index-B_ib1VwN.js（连字符 + base62/下划线 hash）；
    // 点分隔（xxx.abc12345.js）一并兼容。旧正则仅匹配 hex，漏掉真实 Vite 命名（Bugfix）。
    const immutable = /[-.][0-9A-Za-z_-]{8,}\.(js|mjs|css|woff2|png|svg)$/i.test(target.path);
    return negotiateAndServe(
      request,
      response,
      target,
      contentType,
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
  };
}
