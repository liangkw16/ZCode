import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseWebRemoteControlRelayV2OutgoingMessage,
  WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

export interface SelfHostRelayWsGatewayOptions {
  store: SelfHostRelayStore;
  now?: () => number;
  /**
   * 现任 terminal 活跃窗口（默认 12s，须短于客户端 15s 握手超时）：窗口内新 terminal
   * 排队等待接管而非立即拒绝；现任沉默超过窗口才允许按官方语义替换。
   */
  terminalOwnerStaleMs?: number;
}

interface RelayConnection {
  role: WebRemoteControlRelayV2Role;
  terminalSid: string;
  deviceSid: string | null;
  ownerRef: unknown;
  socket: WebSocket;
  /** 最近一条消息到达时间：现任 terminal 活跃判定依据（正常心跳 4-6s 一次 query）。 */
  lastSeenAt: number;
}

/** 现任 terminal 沉默超过该窗口才允许新 terminal 接管（spec 追记三 §3.1，与官方"新替旧"的有意分叉）。 */
const DEFAULT_TERMINAL_OWNER_STALE_MS = 12_000;

export function attachSelfHostRelayWsGateway(
  server: Server,
  options: SelfHostRelayWsGatewayOptions,
): { close(): Promise<void> } {
  const now = options.now ?? Date.now;
  const store = options.store;
  const terminalOwnerStaleMs = options.terminalOwnerStaleMs ?? DEFAULT_TERMINAL_OWNER_STALE_MS;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const connections = new Map<unknown, RelayConnection>();

  const send = (connection: RelayConnection, message: WebRemoteControlRelayV2IncomingMessage): void => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) }));
    }
  };

  const peerOf = (connection: RelayConnection): RelayConnection | undefined => {
    if (!connection.deviceSid) return undefined;
    const otherRole: WebRemoteControlRelayV2Role = connection.role === "device" ? "terminal" : "device";
    const owner = store.getOwner(connection.deviceSid, otherRole);
    return owner ? connections.get(owner.owner) : undefined;
  };

  server.on("upgrade", (request, socket, head) => {
    // Bugfix：畸形升级 URL（如 GET //[）会让 new URL 抛 ERR_INVALID_URL 并打死进程；
    // 鉴权前任何解析失败都只关闭当前 socket。
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    const role = store.consumeToken(token, now());
    if (url.pathname !== WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH || !role) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const connection: RelayConnection = {
        role,
        terminalSid: role === "terminal" ? `t_${randomUUID()}` : "",
        deviceSid: null,
        ownerRef: {},
        socket: ws,
        lastSeenAt: now(),
      };
      connections.set(connection.ownerRef, connection);
      ws.on("error", () => ws.terminate());
      ws.on("message", (data, isBinary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        connection.lastSeenAt = now();
        let message: ReturnType<typeof parseWebRemoteControlRelayV2OutgoingMessage> = null;
        // Bugfix：深嵌套 JSON（约 5000 层）会让 zod 递归校验爆栈抛 RangeError；
        // 校验异常一律按非法消息处理，只关当前连接，不能打死进程。
        try {
          const parsedValue = JSON.parse(data.toString());
          message = isBinary ? null : parseWebRemoteControlRelayV2OutgoingMessage(parsedValue);
        } catch {
          message = null;
        }
        if (!message) {
          send(connection, { type: "error", code: "WRONG_PARAM" });
          ws.close();
          return;
        }
        if (message.type === "auth_init") {
          if (connection.deviceSid) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          // 认证完成块：claim（设备不存在 → AUTH_FAILED）+ 踢旧 + 配对推送 + auth_ack。
          const deviceSidToClaim = message.device_sid;
          const metaToClaim = message.meta ?? {};
          const completeAuthInit = () => {
            const claimed = store.claimOwnership(
              deviceSidToClaim,
              connection.role,
              metaToClaim,
              connection.ownerRef,
            );
            if (!claimed) {
              send(connection, { type: "error", code: "AUTH_FAILED" });
              ws.close();
              return;
            }
            const kickedConnection = claimed.kicked ? connections.get(claimed.kicked) : undefined;
            if (kickedConnection) {
              send(kickedConnection, { type: "error", code: "KICKED" });
              kickedConnection.socket.close();
            }
            connection.deviceSid = deviceSidToClaim;
            const peer = peerOf(connection);
            const pairStatus = peer ? "matched" : "waiting";
            if (peer) {
              // 契约：认证即配对时，对端收 pair_status_ack(matched)；terminal_sid 推送 ACK 为空。
              send(peer, { type: "pair_status_ack", pair_status: "matched", terminal_sid: "" });
            }
            send(connection, {
              type: "auth_ack",
              device_sid: deviceSidToClaim,
              terminal_sid: connection.terminalSid,
              pair_status: pairStatus,
            });
          };
          // 现任优先独占（spec 追记三 §3.1）：terminal 接入且现任 terminal 活跃时**排队等待**
          // 而非立即拒绝——半开连接的合法重连（网络切换）在窗口内静默等待，现任沉默到期后
          // 原子复核并接管，全程不产生 KICKED，不会被客户端冲突终态误杀（codex-review P1）。
          // 等满窗口现任仍活跃（确为并存页面）才回 KICKED：客户端 60s 内第二次 KICKED 进
          // 会话冲突终态页停止重试，互踢战争终止。被删除的 SID 不参与排队，保持 AUTH_FAILED
          // 契约（codex-review P3）。device 角色不受影响：桌面重启必须无条件收回 device 位。
          if (
            connection.role === "terminal" &&
            // 契约方法数受架构上限约束：设备存在性经 listDevices 组合判断（单用户表极小）。
            store.listDevices(now()).some((d) => d.device_sid === message.device_sid)
          ) {
            const incumbentOwner = store.getOwner(message.device_sid, "terminal");
            const incumbent = incumbentOwner ? connections.get(incumbentOwner.owner) : undefined;
            const silentMs = incumbent ? now() - incumbent.lastSeenAt : Infinity;
            if (silentMs < terminalOwnerStaleMs) {
              const takeoverTimer = setTimeout(
                () => {
                  if (connection.deviceSid || ws.readyState !== WebSocket.OPEN) return;
                  const ownerNow = store.getOwner(message.device_sid, "terminal");
                  const incumbentNow = ownerNow ? connections.get(ownerNow.owner) : undefined;
                  const silentNow = incumbentNow ? now() - incumbentNow.lastSeenAt : Infinity;
                  if (silentNow < terminalOwnerStaleMs) {
                    send(connection, { type: "error", code: "KICKED" });
                    ws.close();
                    return;
                  }
                  completeAuthInit();
                },
                terminalOwnerStaleMs - silentMs + 50,
              );
              // 排队定时器不得阻止进程优雅退出（SIGTERM 最长等待即窗口时长）。
              takeoverTimer.unref?.();
              return;
            }
          }
          completeAuthInit();
          return;
        }
        if (!connection.deviceSid) {
          send(connection, { type: "error", code: "AUTH_FAILED" });
          ws.close();
          return;
        }
        if (message.type === "pair_status_query") {
          const peer = peerOf(connection);
          send(connection, {
            type: "pair_status_ack",
            pair_status: peer ? "matched" : "waiting",
            terminal_sid: peer?.terminalSid ?? "",
          });
          return;
        }
        const peer = peerOf(connection);
        if (peer) send(peer, { type: "data", payload: message.payload });
        else send(connection, { type: "error", code: "INTERNAL" });
      });
      ws.on("close", () => {
        connections.delete(connection.ownerRef);
        if (!connection.deviceSid) return;
        // 按引用身份释放：被 KICKED 替换后的迟到 close 不能拆新 owner。
        const released = store.releaseOwnership(
          connection.deviceSid,
          connection.role,
          connection.ownerRef,
        );
        if (!released) return;
        const peer = peerOf(connection);
        if (peer) {
          send(peer, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
          if (connection.role === "device") {
            send(peer, { type: "error", code: "DEVICE_OFFLINE" });
            peer.socket.close();
          }
        }
      });
    });
  });
  return {
    // Bugfix：server.closeAllConnections() 不关闭已升级的 WS 连接；优雅退出必须先终止
    // 全部 WS 并等待释放，否则 server.close() 在有在线连接时永远挂起，持久化冲刷执行不到。
    close: async () => {
      for (const connection of connections.values()) connection.socket.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    },
  };
}
