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
const TERMINAL_OWNER_STALE_MS = 15_000;

export function attachSelfHostRelayWsGateway(
  server: Server,
  options: SelfHostRelayWsGatewayOptions,
): { close(): Promise<void> } {
  const now = options.now ?? Date.now;
  const store = options.store;
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
          // 现任优先独占（spec 追记三 §3.1）：terminal 接入时若现任 terminal 活跃（15s 内有
          // 消息），拒绝新连接（回 KICKED——客户端 60s 内第二次 KICKED 会进会话冲突终态页停止
          // 重试，双页互踢战争终止）；现任沉默 >=15s（半开/锁屏/关页）才按官方语义替换接管。
          // 检查与 claim 在同一同步回调内完成，并发 auth_init 不会同时通过。device 角色不受
          // 影响：桌面重启必须无条件收回 device 位。
          if (connection.role === "terminal") {
            const incumbentOwner = store.getOwner(message.device_sid, "terminal");
            const incumbent = incumbentOwner ? connections.get(incumbentOwner.owner) : undefined;
            if (incumbent && now() - incumbent.lastSeenAt < TERMINAL_OWNER_STALE_MS) {
              send(connection, { type: "error", code: "KICKED" });
              ws.close();
              return;
            }
          }
          const claimed = store.claimOwnership(
            message.device_sid,
            connection.role,
            message.meta ?? {},
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
          connection.deviceSid = message.device_sid;
          const peer = peerOf(connection);
          const pairStatus = peer ? "matched" : "waiting";
          if (peer) {
            // 契约：认证即配对时，对端收 pair_status_ack(matched)；terminal_sid 推送 ACK 为空。
            send(peer, { type: "pair_status_ack", pair_status: "matched", terminal_sid: "" });
          }
          send(connection, {
            type: "auth_ack",
            device_sid: message.device_sid,
            terminal_sid: connection.terminalSid,
            pair_status: pairStatus,
          });
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
