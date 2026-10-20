import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseWebRemoteControlRelayV2HttpRequest,
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
} from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

export interface SelfHostRelayHttpRouterOptions {
  store: SelfHostRelayStore;
  secret: string;
  now?: () => number;
}

const REMOTE_PREFIX = "/api/v1/remote";
const RATE_LIMIT_PER_MINUTE = 1200;

function bearerOf(authorization: string | undefined): string | null {
  return authorization?.match(/^Bearer (.+)$/i)?.[1] ?? null;
}

function reply(
  response: ServerResponse,
  status: number,
  data?: unknown,
  code = status === 200 ? 0 : status,
  msg = "",
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code, msg, ...(data === undefined ? {} : { data }) }));
}

function createRateLimiter(now: () => number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const nowMs = now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= nowMs) buckets.delete(key);
    }
    const bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= nowMs) {
      buckets.set(ip, { count: 1, resetAt: nowMs + 60_000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT_PER_MINUTE;
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  } catch {
    // Bugfix：客户端中断请求体（ECONNRESET）会从流读取抛出；吞掉并按非法 body 处理，
    // 否则未处理 rejection 会让整个 relay 进程退出（攻击者可反复打断服务）。
    return null;
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}

export function createSelfHostRelayHttpRouter(options: SelfHostRelayHttpRouterOptions) {
  const now = options.now ?? Date.now;
  const allowRequest = createRateLimiter(now);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    // 客户端中途断开时 socket 两侧都可能抛错；吞掉并以 destroy 收尾，保证进程存活。
    request.on("error", () => {});
    response.on("error", () => {});
    try {
      return await route(request, response);
    } catch {
      if (!response.headersSent) {
        try {
          reply(response, 500);
        } catch {
          // 响应已不可写（socket 已销毁），无需处理。
        }
      }
      response.destroy();
      return true;
    }
  };
  async function route(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(REMOTE_PREFIX)) return false;
    const ip = request.socket.remoteAddress ?? "unknown";
    if (!allowRequest(ip)) {
      reply(response, 429);
      return true;
    }
    const bearer = bearerOf(request.headers.authorization);
    if (!bearer) {
      reply(response, 401);
      return true;
    }
    const isSecret = bearer === options.secret;
    const method = request.method ?? "GET";
    const body = await readBody(request);

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.token.path && method === "POST") {
      response.setHeader("Cache-Control", "no-store");
      const parsed = parseWebRemoteControlRelayV2HttpRequest("token", body);
      if (!parsed) {
        reply(response, 400, undefined, 3001, "parameter error");
        return true;
      }
      // 密钥只保护敏感能力：terminal token 可连桌面必须持密钥；device token 任意 bearer。
      if (parsed.role === "terminal" && !isSecret) {
        reply(response, 401);
        return true;
      }
      const token = randomBytes(16).toString("base64url");
      options.store.issueToken(parsed.role, token, now());
      reply(response, 200, { token, expires_in: 60 });
      return true;
    }

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.register.path && method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("register", body);
      if (!parsed) {
        reply(response, 400, undefined, 3001, "parameter error");
        return true;
      }
      const record = options.store.registerDevice(parsed.device_mid, now());
      reply(response, 200, {
        device_sid: record.deviceSid,
        device_mid: parsed.device_mid,
        online: false,
        created_at: record.createdAt,
        meta: {},
      });
      return true;
    }

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.list.path && method === "GET") {
      // 列表泄露 SID（terminal 可凭 SID 配对），必须持密钥。
      if (!isSecret) {
        reply(response, 401);
        return true;
      }
      reply(response, 200, options.store.listDevices(now()));
      return true;
    }

    if (url.pathname === WEB_REMOTE_CONTROL_RELAY_V2_HTTP.delete.path && method === "POST") {
      const parsed = parseWebRemoteControlRelayV2HttpRequest("delete", body);
      if (!parsed) {
        reply(response, 400, undefined, 3001, "parameter error");
        return true;
      }
      const result = options.store.deleteDevice(parsed.device_sid);
      if (result === "device-online") {
        reply(response, 400, undefined, 3005, "wrong status");
        return true;
      }
      reply(response, 200);
      return true;
    }

    reply(response, 404);
    return true;
  }
}
