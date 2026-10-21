import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseWebRemoteControlRelayV2OutgoingMessage,
  WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";
import type { WebRemoteControlRelayV2Meta } from "@zcode/shared/web-remote-relay";
import type { SelfHostRelayStore } from "../contract.js";

/** ws 网关独占的 terminal 集合端口；由 RelayStore 一并实现。 */
export interface SelfHostRelayTerminalStore {
  /** 设备不存在返回 null；同 terminalId 替换旧 owner（kicked），不同 id 共存。 */
  claimTerminal(
    deviceSid: string,
    terminalId: string,
    meta: WebRemoteControlRelayV2Meta,
    owner: unknown,
  ): { kicked: unknown | null; terminalIds: string[] } | null;
  /** 只在 owner 引用一致时移除；返回剩余 id 列表（按插入顺序）。 */
  releaseTerminal(
    deviceSid: string,
    terminalId: string,
    owner: unknown,
  ): { released: boolean; terminalIds: string[] };
  getTerminalOwner(
    deviceSid: string,
    terminalId: string,
  ): { owner: unknown; meta: WebRemoteControlRelayV2Meta } | undefined;
  listTerminalIds(deviceSid: string): string[];
}

export interface SelfHostRelayWsGatewayOptions {
  store: SelfHostRelayStore & SelfHostRelayTerminalStore;
  now?: () => number;
  /** 单设备 terminal 集合上限；超出回 KICKED，防异常客户端无限建 session。 */
  maxTerminals?: number;
}

interface RelayConnection {
  role: WebRemoteControlRelayV2Role;
  terminalSid: string;
  terminalId: string | null;
  deviceSid: string | null;
  ownerRef: unknown;
  socket: WebSocket;
}

export function attachSelfHostRelayWsGateway(
  server: Server,
  options: SelfHostRelayWsGatewayOptions,
): { close(): Promise<void> } {
  const now = options.now ?? Date.now;
  const store = options.store;
  const maxTerminals = options.maxTerminals ?? 32;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const connections = new Map<unknown, RelayConnection>();

  const send = (connection: RelayConnection, message: WebRemoteControlRelayV2IncomingMessage): void => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify({ ...message, server_ts: Math.floor(now() / 1000) }));
    }
  };

  const deviceConnectionOf = (deviceSid: string): RelayConnection | undefined => {
    const slot = store.getDeviceOwner(deviceSid);
    return slot ? connections.get(slot.owner) : undefined;
  };

  const terminalConnectionsOf = (deviceSid: string): RelayConnection[] => {
    const result: RelayConnection[] = [];
    for (const terminalId of store.listTerminalIds(deviceSid)) {
      const slot = store.getTerminalOwner(deviceSid, terminalId);
      const connection = slot ? connections.get(slot.owner) : undefined;
      if (connection) result.push(connection);
    }
    return result;
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
        terminalId: null,
        deviceSid: null,
        ownerRef: {},
        socket: ws,
      };
      connections.set(connection.ownerRef, connection);
      ws.on("error", () => ws.terminate());
      ws.on("message", (data, isBinary) => {
        if (ws.readyState !== WebSocket.OPEN) return;
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
          if (connection.deviceSid || connection.terminalId) {
            send(connection, { type: "error", code: "WRONG_PARAM" });
            ws.close();
            return;
          }
          if (connection.role === "terminal") {
            const terminalId = (message.terminal_id ?? connection.terminalSid).trim();
            if (
              !store.getTerminalOwner(message.device_sid, terminalId) &&
              store.listTerminalIds(message.device_sid).length >= maxTerminals
            ) {
              // 复用 KICKED 的"有限重连后终止"客户端路径，避免异常客户端无限占资源。
              console.warn("[self-host-relay] terminal limit reached, rejecting", {
                deviceSid: message.device_sid,
                maxTerminals,
              });
              send(connection, { type: "error", code: "KICKED" });
              ws.close();
              return;
            }
            const claimed = store.claimTerminal(
              message.device_sid,
              terminalId,
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
            connection.terminalId = terminalId;
            const device = deviceConnectionOf(message.device_sid);
            const pairStatus = device ? "matched" : "waiting";
            // 兼容开关：仅当 terminal 自己携带 terminal_id 时才回显该字段。
            // 旧 web 的 strict schema 会拒绝未知字段，无条件回显会让旧页面认证超时重连。
            send(connection, {
              type: "auth_ack",
              device_sid: message.device_sid,
              terminal_sid: connection.terminalSid,
              ...(message.terminal_id ? { terminal_id: terminalId } : {}),
              pair_status: pairStatus,
            });
            if (device) {
              send(device, {
                type: "pair_status_ack",
                pair_status: "matched",
                terminal_ids: claimed.terminalIds,
              });
            }
            return;
          }

          const claimed = store.claimDevice(
            message.device_sid,
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
          const terminalIds = store.listTerminalIds(message.device_sid);
          const pairStatus = terminalIds.length > 0 ? "matched" : "waiting";
          send(connection, {
            type: "auth_ack",
            device_sid: message.device_sid,
            terminal_sid: "",
            terminal_ids: terminalIds,
            pair_status: pairStatus,
          });
          if (terminalIds.length > 0) {
            for (const terminal of terminalConnectionsOf(message.device_sid)) {
              send(terminal, { type: "pair_status_ack", pair_status: "matched", terminal_sid: "" });
            }
          }
          return;
        }
        if (!connection.deviceSid) {
          send(connection, { type: "error", code: "AUTH_FAILED" });
          ws.close();
          return;
        }
        if (message.type === "pair_status_query") {
          if (connection.role === "terminal") {
            const device = deviceConnectionOf(connection.deviceSid);
            send(connection, {
              type: "pair_status_ack",
              pair_status: device ? "matched" : "waiting",
              terminal_sid: "",
            });
            return;
          }
          const terminalIds = store.listTerminalIds(connection.deviceSid);
          send(connection, {
            type: "pair_status_ack",
            pair_status: terminalIds.length > 0 ? "matched" : "waiting",
            terminal_sid: "",
            terminal_ids: terminalIds,
          });
          return;
        }
        if (message.type === "data") {
          if (connection.role === "terminal") {
            // target_terminal_id 是 device → relay 专属方向；terminal 发送按契约回 WRONG_PARAM。
            if (message.target_terminal_id) {
              send(connection, { type: "error", code: "WRONG_PARAM" });
              ws.close();
              return;
            }
            const device = deviceConnectionOf(connection.deviceSid);
            if (!device) {
              send(connection, { type: "error", code: "INTERNAL" });
              return;
            }
            send(device, {
              type: "data",
              payload: message.payload,
              from_terminal_id: connection.terminalId ?? "",
            });
            return;
          }
          const targetId = message.target_terminal_id;
          if (targetId) {
            const slot = store.getTerminalOwner(connection.deviceSid, targetId);
            const target = slot ? connections.get(slot.owner) : undefined;
            if (!target) {
              // 过期目标是常态（页面刚断开）：丢弃即可，不能回 INTERNAL 触发 device 重连。
              console.debug("[self-host-relay] dropping data for unknown terminal", { targetId });
              return;
            }
            send(target, { type: "data", payload: message.payload });
            return;
          }
          const terminals = terminalConnectionsOf(connection.deviceSid);
          if (terminals.length === 0) {
            send(connection, { type: "error", code: "INTERNAL" });
            return;
          }
          for (const terminal of terminals) {
            send(terminal, { type: "data", payload: message.payload });
          }
          return;
        }
      });
      ws.on("close", () => {
        connections.delete(connection.ownerRef);
        if (!connection.deviceSid) return;

        if (connection.role === "device") {
          const released = store.releaseDevice(connection.deviceSid, connection.ownerRef);
          if (!released.released) return;
          for (const terminal of released.terminals) {
            const target = connections.get(terminal.owner);
            if (!target) continue;
            send(target, { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "" });
            send(target, { type: "error", code: "DEVICE_OFFLINE" });
            target.socket.close();
          }
          return;
        }

        const released = store.releaseTerminal(
          connection.deviceSid,
          connection.terminalId ?? connection.terminalSid,
          connection.ownerRef,
        );
        if (!released.released) return;
        const device = deviceConnectionOf(connection.deviceSid);
        if (device) {
          send(device, {
            type: "pair_status_ack",
            pair_status: released.terminalIds.length > 0 ? "matched" : "waiting",
            terminal_ids: released.terminalIds,
          });
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
