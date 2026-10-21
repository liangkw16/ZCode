import type { RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制 manager 承担外部 relay app payload 路由与 workspace bridge 编排。 */
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlExternalQrUrl,
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  type ZCodeEndpointUrls,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlAuthStateChange,
  type WebRemoteControlContext,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlMobileTaskViewUpdatePayload,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRpcTransportPayload,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceTarget,
  type RemoteUsageRemoteKind,
  type TelemetryEventPayload,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportOptions,
  type WebRemoteControlDeviceTransportState,
  createWebRemoteControlV2Http,
  type WebRemoteControlLogin,
} from "#src/main/web-remote-relay/index.js";
import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/index.js";

import type { WebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";

interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

interface WorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(
    payload: WebRemoteControlAppPayload,
    targetTerminalId?: string,
  ): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload, targetTerminalId?: string): number;
  dispose(): void;
}

interface WebRemoteControlStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartAuthorization {
  token: string;
  expiresAt: number;
  windowId: number;
  workspaceKey: string;
  remoteSessionId?: string;
}

const WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS = 30_000;

interface WindowControlLifecycle {
  controller: AbortController;
  identity?: { userId: string; endpointOrigin: string };
}

// legacy 兼容 session 的 map 键：wire identifier 强制非空白，空串不会与真实 terminal_id 冲突。
// 不用 "default" 这类字面值——它在 schema 上是合法 terminal_id，会被对账逻辑误删。
const LEGACY_TERMINAL_SESSION_KEY = "";

/** 每个 terminal（页面）独立的会话状态：bridge、缓冲与视图。 */
interface TerminalSession {
  terminalId: string;
  currentBridge?: WorkspaceBridgeRuntime;
  bridgeOpen?: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    intentKey: string;
    hostRequestId: string;
    preparingProject: boolean;
    promise: Promise<WebRemoteControlExternalWorkspaceBridge>;
  };
  pendingBridgeInvalidation?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "bridge-degraded" }
  >;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileTaskView?: NonNullable<WebRemoteControlStatus["mobileTaskView"]>;
  mobileTaskViewEpoch?: string;
  mobileTaskViewSeq?: number;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  lastActivityAt: number;
  detachedAt?: number;
  detachTimer?: ReturnType<typeof setTimeout>;
  workspaceListSignature?: string;
}

interface WindowControlRuntime {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  deviceSid: string;
  deviceMid: string;
  connectUrl: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  hasObservedSendReadyForPairing: boolean;
  transportState?: WebRemoteControlDeviceTransportState;
  /** 跨页共享的"最近手机视图"偏好；当前各页视图在 session 上。 */
  mobileViewState?: WebRemoteControlMobileViewState;
  terminalSessions: Map<string, TerminalSession>;
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlManagerDependencies {
  getEndpointUrls?: () => Promise<ZCodeEndpointUrls> | ZCodeEndpointUrls;
  // kcode 自托管：以"将要嵌入的最终手机页 URL"为参取回 relay 密钥（null/缺省 = 官方行为）。
  // 入参传最终 URL，让门控在 index 侧校验 origin，避免 env 覆盖后密钥泄往其它域。
  getSelfHostQrKey?: (mobileRemoteControlUrl: string) => string | null | Promise<string | null>;
  relayWsUrl: string;
  mobileRemoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  getLogin(): Promise<WebRemoteControlLogin | undefined>;
  deviceStorage: WebRemoteControlDeviceStorage;
  startupRestoreStorageProvider: {
    load(): Promise<WebRemoteControlStartupRestoreContext | undefined>;
    save(context: WebRemoteControlStartupRestoreContext): Promise<void>;
    clear(): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  prepareProjectWorkspace?: (
    windowId: number,
    project: HostProjectWorkspaceNavigationInput,
    requestId: string,
  ) => Promise<HostPreparedProjectWorkspace>;
  cancelProjectPreparation?: (windowId: number, requestId: string) => void;
  reportRemoteUsageEvent?: (windowId: number, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

// Bugfix: 外部 relay 首次鉴权会受边缘层冷启动和网络抖动影响，实测可能略超 15s。
// 这里等待到 30s，避免在 device 已经快进入 waiting_terminal 时过早销毁可用连接。
const EXTERNAL_RELAY_QR_READY_TIMEOUT_MS = 30_000;
const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;

function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error("远程 workspace bridge 缺少 workspaceIdentity 或 remoteSessionId。");
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      capabilities: { windowProjectDirectory: true },
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  const runtimes = new Map<number, WindowControlRuntime>();
  // 身份绑定与取消令牌覆盖首次启动到连接释放的整个生命周期，不缓存 JWT。
  const windowLifecycles = new Map<number, WindowControlLifecycle>();
  const authRequiredWindows = new Set<number>();
  let registrationQueue: Promise<unknown> = Promise.resolve();
  const startAuthorizations = new Map<string, WebRemoteControlStartAuthorization>();
  const availableWorkspacesByWindowId = new Map<number, WebRemoteControlWorkspaceTarget[]>();

  function reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // 埋点是旁路能力，任何异常都不能改变远控配对和 bridge 的业务结果。
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  function resolveRemoteKind(
    target: WebRemoteControlWorkspaceTarget,
    acquired?: WebRemoteControlHostAttachmentHandle,
  ): RemoteUsageRemoteKind | undefined {
    if (target.kind !== "remote") {
      return undefined;
    }
    return (
      acquired?.remoteKind ??
      (target.workspaceIdentity
        ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
        : undefined)
    );
  }

  function resolveRuntimeWorkspaceDimensions(runtime: WindowControlRuntime): {
    workspaceKind: "local" | "remote";
    remoteKind?: RemoteUsageRemoteKind;
  } {
    const remoteKind = runtime.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
      : undefined;
    return {
      workspaceKind:
        runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
      remoteKind,
    };
  }
  let startupRestoreClaimed = false;
  let lifecycleRevision = 0;
  let authNotificationRevision = 0;

  function createTransport(options: WebRemoteControlDeviceTransportOptions) {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  function clearStartAuthorizationsForWindow(windowId: number): void {
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.windowId === windowId) {
        startAuthorizations.delete(token);
      }
    }
  }

  function authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization {
    const now = Date.now();
    // 同一窗口只保留最近一次 IPC dispatch 对应的内部票据，避免旧请求与新 workspace 上下文并存。
    clearStartAuthorizationsForWindow(windowId);
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.expiresAt <= now) {
        startAuthorizations.delete(token);
      }
    }

    const authorization: WebRemoteControlStartAuthorization = {
      token: randomUUID(),
      expiresAt: now + WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
      windowId,
      workspaceKey: resolveWebRemoteControlWorkspaceKey(context),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
    startAuthorizations.set(authorization.token, authorization);
    return authorization;
  }

  function consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void {
    const stored = startAuthorizations.get(authorization.token);
    startAuthorizations.delete(authorization.token);
    if (!stored || stored !== authorization) {
      throw new Error("Web remote control authorization is invalid or already used");
    }
    if (stored.expiresAt <= Date.now()) {
      throw new Error("Web remote control authorization expired");
    }
    if (
      stored.windowId !== windowId ||
      stored.workspaceKey !== resolveWebRemoteControlWorkspaceKey(context) ||
      stored.remoteSessionId !== context.remoteSessionId
    ) {
      throw new Error("Web remote control authorization target mismatch");
    }
  }

  function disposeRuntimeBridgeResources(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): void {
    clearMobileTaskView(runtime, session);
    const bridge = session.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // MessagePortProtocol 已经关闭时 dispose 失败不影响主流程。
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    session.currentBridge = undefined;
  }

  function isCurrentBridgeRuntime(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return (
      runtimes.get(runtime.windowId) === runtime &&
      runtime.terminalSessions.get(session.terminalId) === session &&
      session.currentBridge === bridge
    );
  }

  function degradeBridgeAfterRawFault(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    reasonCode: string,
  ): void {
    const bridge = session.currentBridge;
    if (!bridge || !isCurrentBridgeRuntime(runtime, session, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control] raw relay bridge degraded", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    session.pendingBridgeInvalidation = {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix：checksum/oversize/future ACK 等 fault 不能伪装成 frame gap；
      // app control 只传通用恢复原因，typed reasonCode 留在上面的安全日志。
      reason: "rpc-transport-fault",
    };
    // Bug 原因：degraded 后 raw 两端都已禁止继续转发，保留旧 attachment 只会泄漏
    // scoped subscription。物理 Host/Agent 不受影响，只释放手机短生命周期 attachment。
    disposeRuntimeBridgeResources(runtime, session);
    sendPendingBridgeInvalidation(runtime, session);
  }

  function createTerminalSession(terminalId: string): TerminalSession {
    return {
      terminalId,
      pendingOutboundPayloads: [],
      lastActivityAt: Date.now(),
    };
  }

  function getOrCreateTerminalSession(
    runtime: WindowControlRuntime,
    terminalId?: string,
  ): TerminalSession {
    const id = terminalId ?? LEGACY_TERMINAL_SESSION_KEY;
    let session = runtime.terminalSessions.get(id);
    if (!session) {
      session = createTerminalSession(id);
      runtime.terminalSessions.set(id, session);
      if (runtime.transportState === "paired") {
        session.mobileTaskViewEpoch = randomUUID();
        session.mobileTaskViewSeq = -1;
      }
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  function getStatusProjection(runtime: WindowControlRuntime): TerminalSession | undefined {
    let latest: TerminalSession | undefined;
    for (const session of runtime.terminalSessions.values()) {
      if (session.detachedAt !== undefined) continue;
      if (!latest || session.lastActivityAt > latest.lastActivityAt) latest = session;
    }
    if (latest) return latest;
    for (const session of runtime.terminalSessions.values()) {
      if (!latest || session.lastActivityAt > latest.lastActivityAt) latest = session;
    }
    return latest;
  }

  function disposeTerminalSession(runtime: WindowControlRuntime, session: TerminalSession): void {
    if (runtime.terminalSessions.get(session.terminalId) !== session) return;
    cancelBridgeOpen(runtime, session);
    disposeRuntimeBridgeResources(runtime, session);
    if (session.pendingOutboundPayloadTimer) {
      clearTimeout(session.pendingOutboundPayloadTimer);
      session.pendingOutboundPayloadTimer = undefined;
    }
    session.pendingOutboundPayloads.length = 0;
    runtime.terminalSessions.delete(session.terminalId);
    emitRuntimeStatus(runtime);
  }

  // Task 8 会补全集合对账与宽限期；本实现保证单 terminal 行为与旧 runtime 完全一致。
  function reconcileTerminalIds(runtime: WindowControlRuntime, terminalIds: string[]): void {
    void runtime;
    void terminalIds;
  }

  function clearPendingOutboundPayloadTimer(session: TerminalSession): void {
    if (!session.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(session.pendingOutboundPayloadTimer);
    session.pendingOutboundPayloadTimer = undefined;
  }

  function clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  function buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus {
    const target = getRuntimeStatusTarget(runtime);
    const projected = getStatusProjection(runtime);
    return {
      status: runtime.status,
      sessionId: runtime.deviceSid,
      windowControlSessionId: runtime.deviceSid,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      mobileTaskView: projected?.mobileTaskView ?? null,
      mobileDeviceInfo: projected?.mobileDeviceInfo,
      qrUrl: runtime.qrUrl,
      connectUrl: runtime.connectUrl,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: projected?.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
    };
  }

  function emitRuntimeStatus(runtime: WindowControlRuntime): void {
    if (runtimes.get(runtime.windowId) !== runtime) return;
    dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
  }

  function clearMobileTaskView(runtime: WindowControlRuntime, session: TerminalSession): void {
    if (!session.mobileTaskView) return;
    session.mobileTaskView = undefined;
    emitRuntimeStatus(runtime);
  }

  function requestMobileTaskView(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): void {
    if (runtime.transportState !== "paired" || !session.mobileTaskViewEpoch) return;
    sendAppPayload(
      runtime,
      {
        zcode_type: "mobile-task-view-request",
        epoch: session.mobileTaskViewEpoch,
      },
      session,
    );
  }

  function emitIdleStatus(windowId: number): void {
    dependencies.onStatusChanged?.(windowId, { status: "idle" });
  }

  function scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (runtimes.get(runtime.windowId) !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  function schedulePendingOutboundPayloadTimeout(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): void {
    if (session.pendingOutboundPayloadTimer || session.pendingOutboundPayloads.length === 0) {
      return;
    }
    session.pendingOutboundPayloadTimer = setTimeout(() => {
      session.pendingOutboundPayloadTimer = undefined;
      const droppedCount = session.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        terminalId: session.terminalId,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
    session: TerminalSession,
  ): WebRemoteControlPayloadSendResult {
    // legacy session（官方 relay）发送时不带 target；真实 terminal_id 才定向。
    const target =
      session.terminalId === LEGACY_TERMINAL_SESSION_KEY ? undefined : session.terminalId;
    if (runtime.transport.sendPayloadResult) {
      return runtime.transport.sendPayloadResult(payload, target);
    }
    return runtime.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  function sendPendingBridgeInvalidation(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): void {
    const payload = session.pendingBridgeInvalidation;
    if (!payload) return;
    const result = sendPayloadToTransport(runtime, payload, session);
    if (result.kind === "oversize") {
      dependencies.logger.error("[web-remote-control] bridge invalidation is oversized", {
        bridgeSessionId: payload.bridgeSessionId,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
    }
    // unavailable 时保持 latch；sent 后也保留，直到手机用新 bridge identity 发起 open。
  }

  function bufferOutboundPayload(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (session.pendingOutboundPayloads.length >= 50) {
      const droppedCount = session.pendingOutboundPayloads.length + 1;
      session.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(session);
      dependencies.logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        terminalId: session.terminalId,
        droppedCount,
      });
      return;
    }
    session.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime, session);
  }

  function flushPendingOutboundPayloads(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): void {
    while (session.pendingOutboundPayloads.length > 0) {
      const payload = session.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload, session);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime, session);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix：永久 oversize 不能伪装成临时不可发送后反复进入 50 项 buffer。
        dependencies.logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      session.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(session);
  }

  function sendAppPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
    session?: TerminalSession,
  ): void {
    if (session) {
      sendAppPayloadToSession(runtime, payload, session);
      return;
    }
    // 未指定 session 的窗口级广播：每个 session 各复制一份（无 session 时落 legacy）。
    if (runtime.terminalSessions.size === 0) {
      sendAppPayloadToSession(runtime, payload, getOrCreateTerminalSession(runtime));
      return;
    }
    for (const target of runtime.terminalSessions.values()) {
      sendAppPayloadToSession(runtime, payload, target);
    }
  }

  function sendAppPayloadToSession(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
    session: TerminalSession,
  ): void {
    if (session.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, session, payload);
      flushPendingOutboundPayloads(runtime, session);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload, session);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: relay suspect 窗口内 sendPayload 会返回 false。
    // desktop 发出的响应/RPC 帧不能静默丢弃，先短暂缓冲，等 paired 恢复后再 flush。
    bufferOutboundPayload(runtime, session, payload);
  }

  function preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    if (runtime.status === "error" && runtime.failure?.reason === failure.reason) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    for (const session of [...runtime.terminalSessions.values()]) {
      disposeTerminalSession(runtime, session);
    }
    clearMobileDisconnectGraceTimer(runtime);
    runtime.transport.dispose();
    runtime.status = "error";
    runtime.mobileConnected = false;
    runtime.error = failure.message;
    runtime.failure = failure;
    runtimes.set(windowId, runtime);
    dependencies.logger.warn(
      `[web-remote-control] runtime closed window=${windowId} session=${runtime.deviceSid} reason=${reason} failure=${failure.reason} message=${failure.message ?? "<none>"}`,
    );
    emitRuntimeStatus(runtime);
  }

  async function stopWindowRuntime(windowId: number, reason: string): Promise<void> {
    windowLifecycles.get(windowId)?.controller.abort();
    windowLifecycles.delete(windowId);
    const runtime = runtimes.get(windowId);
    if (!runtime) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    runtimes.delete(windowId);
    for (const session of [...runtime.terminalSessions.values()]) {
      disposeTerminalSession(runtime, session);
    }
    clearMobileDisconnectGraceTimer(runtime);
    runtime.transport.dispose();
    dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, reason);

    dependencies.logger.info(
      `[web-remote-control] stopped window=${windowId} session=${runtime.deviceSid} reason=${reason}`,
    );
    emitIdleStatus(windowId);
  }

  function requireAuthentication(windowId: number): void {
    void stopWindowRuntime(windowId, "auth-required");
    authRequiredWindows.add(windowId);
    startupRestoreClaimed = false;
    dependencies.onStatusChanged?.(windowId, { status: "auth-required" });
  }

  function getSessionWorkspaceTarget(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): WebRemoteControlWorkspaceTarget {
    const bridge = session.currentBridge;
    if (bridge) {
      return {
        workspacePath: bridge.workspacePath,
        workspaceIdentity: bridge.workspaceIdentity,
        remoteSessionId: bridge.remoteSessionId,
        label: getPathLabel(bridge.workspacePath),
        kind: bridge.kind,
      };
    }

    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getRuntimeStatusTarget(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget {
    // Bugfix: 手机端可以在同一个远控会话里切到窗口内的其他 workspace。
    // 之前 getStatus() 复用了当前 bridge 目标，导致桌面弹层按启动 workspace 轮询时误判为“不是同一会话”，
    // 再次打开弹层会重启远控并把手机端踢成离线。状态接口保持窗口远控会话的原始目标，
    // 手机当前 workspace 仍通过 mobileViewState / workspace list 表达。
    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getAvailableWorkspaces(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): WebRemoteControlWorkspaceTarget[] {
    const workspaceByKey = new Map<string, WebRemoteControlWorkspaceTarget>();

    for (const workspace of availableWorkspacesByWindowId.get(runtime.windowId) ?? []) {
      // Bugfix: 手机端 workspace 列表需要和桌面端一致展示已断开的 SSH 项目。
      // 这里仅保留列表项；真正创建 bridge 时仍会校验 remoteSessionId，避免未连接项目被直接打开聊天。
      workspaceByKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
    }

    const currentTarget = getSessionWorkspaceTarget(runtime, session);
    if (isBridgeableRemoteTarget(currentTarget)) {
      const currentKey = resolveWebRemoteControlWorkspaceKey(currentTarget);
      if (!workspaceByKey.has(currentKey)) {
        workspaceByKey.set(currentKey, currentTarget);
      }
    }

    return [...workspaceByKey.values()];
  }

  function getRuntimeInitialViewState(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): WebRemoteControlMobileViewState | undefined {
    const activeTarget = getSessionWorkspaceTarget(runtime, session);
    if (!runtime.initialTaskId || !isBridgeableRemoteTarget(activeTarget)) {
      return undefined;
    }

    return {
      activeWorkspaceKey: resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId: runtime.initialTaskId,
      updatedAt: Date.now(),
    };
  }

  function buildBootstrapResult(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): WebRemoteControlWindowBootstrapResult {
    return {
      windowControlSessionId: runtime.deviceSid,
      desktopAppVersion: dependencies.appVersion,
      workspaces: getAvailableWorkspaces(runtime, session),
      initialViewState: getRuntimeInitialViewState(runtime, session),
      mobileViewState: session.mobileViewState ?? runtime.mobileViewState,
      mobileTaskViewEpoch: session.mobileTaskViewEpoch,
    };
  }

  function buildWorkspaceListResult(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): WebRemoteControlWorkspaceListResult {
    const activeTarget = getSessionWorkspaceTarget(runtime, session);
    const initialViewState = getRuntimeInitialViewState(runtime, session);
    return {
      workspaces: getAvailableWorkspaces(runtime, session),
      activeWorkspaceKey:
        session.mobileViewState?.activeWorkspaceKey ??
        runtime.mobileViewState?.activeWorkspaceKey ??
        initialViewState?.activeWorkspaceKey ??
        resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId:
        session.mobileViewState?.activeTaskId ??
        session.currentBridge?.initialTaskId ??
        runtime.mobileViewState?.activeTaskId ??
        initialViewState?.activeTaskId,
    };
  }

  function buildWorkspaceListPushSignature(result: WebRemoteControlWorkspaceListResult): string {
    const workspaceSignatureEntries = result.workspaces
      .map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        return JSON.stringify([
          workspaceKey,
          workspace.kind,
          workspace.connectionState ?? "connected",
          workspace.remoteSessionId ?? "",
          // Bugfix：连接状态不只包含枚举值；同一 disconnected 状态下错误原因也会变化，
          // 手机 workspace card 直接展示 lastConnectionError，必须触发新快照。
          workspace.lastConnectionError ?? "",
        ]);
      })
      .sort();

    // Bugfix：title / connection error 是任意用户可见字符串，不能再用控制字符拼接 tuple；
    // 否则字段值本身包含分隔符时不同快照可能得到相同签名。JSON tuple 保持字段边界且仍忽略数组顺序。
    return JSON.stringify(workspaceSignatureEntries);
  }

  function pushWorkspaceListUpdated(runtime: WindowControlRuntime): void {
    if (runtime.terminalSessions.size === 0) {
      // 单 terminal/官方 relay：尚未收到任何 terminal payload 时也要推送（与旧行为一致）。
      pushWorkspaceListUpdatedForSession(runtime, getOrCreateTerminalSession(runtime));
      return;
    }
    for (const session of runtime.terminalSessions.values()) {
      pushWorkspaceListUpdatedForSession(runtime, session);
    }
  }

  function pushWorkspaceListUpdatedForSession(
    runtime: WindowControlRuntime,
    session: TerminalSession,
  ): void {
    const result = buildWorkspaceListResult(runtime, session);
    const signature = buildWorkspaceListPushSignature(result);
    if (session.workspaceListSignature === signature) {
      return;
    }

    session.workspaceListSignature = signature;
    sendAppPayload(
      runtime,
      {
        zcode_type: "workspace-list-updated",
        result,
      },
      session,
    );
  }

  async function respondToPlatformRequest(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed window=${runtime.windowId} session=${runtime.deviceSid} method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response, session);
  }

  function cancelBridgeOpen(runtime: WindowControlRuntime, session: TerminalSession): void {
    const pending = session.bridgeOpen;
    session.bridgeOpen = undefined;
    if (pending?.preparingProject)
      dependencies.cancelProjectPreparation?.(runtime.windowId, pending.hostRequestId);
  }

  function createWorkspaceBridge(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const intentKey = JSON.stringify([
      request.workspaceKey,
      request.taskId ?? null,
      request.project?.projectId,
      request.project?.hostId,
      request.project?.draftId,
      request.taskHostId,
      request.fileTreeTaskId,
    ]);
    const previous = session.bridgeOpen;
    if (
      previous?.bridgeSessionId === request.bridgeSessionId &&
      previous.bridgeGeneration === request.bridgeGeneration
    ) {
      if (previous.intentKey !== intentKey)
        return Promise.reject(new Error("Workspace bridge identity cannot change intent."));
      if (
        session.currentBridge?.degraded ||
        (session.pendingBridgeInvalidation?.bridgeSessionId === request.bridgeSessionId &&
          session.pendingBridgeInvalidation.bridgeGeneration === request.bridgeGeneration)
      )
        return Promise.reject(new Error("Degraded workspace bridge requires a new identity."));
      return previous.promise;
    }
    cancelBridgeOpen(runtime, session);
    // 同一 transport identity 的重试复用整次 admission；新导航立即使旧异步结果失效。
    const pending: TerminalSession["bridgeOpen"] = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      intentKey,
      hostRequestId: randomUUID(),
      preparingProject: Boolean(request.project || request.taskHostId),
      promise: undefined as never,
    };
    session.bridgeOpen = pending;
    pending.promise = buildWorkspaceBridge(runtime, session, request, pending);
    return pending.promise;
  }

  async function buildWorkspaceBridge(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
    pending: NonNullable<TerminalSession["bridgeOpen"]>,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    let target: WebRemoteControlWorkspaceTarget | undefined;
    const intent: HostProjectWorkspaceNavigationInput | undefined =
      request.project ??
      ((request.fileTreeTaskId || request.taskId) && request.taskHostId
        ? {
            hostId: request.taskHostId,
            task: {
              taskId: (request.fileTreeTaskId ?? request.taskId)!,
              workspaceKey: request.workspaceKey,
            },
          }
        : undefined);
    if (intent) {
      if ((request.project && request.taskId) || !dependencies.prepareProjectWorkspace)
        throw new Error("Project navigation is unavailable.");
      try {
        const prepared = await dependencies.prepareProjectWorkspace(
          runtime.windowId,
          intent,
          pending.hostRequestId,
        );
        target = {
          workspacePath: prepared.workspacePath,
          workspaceIdentity: prepared.workspaceIdentity,
          remoteSessionId: prepared.remote?.remoteSessionId,
          kind: prepared.remote ? "remote" : "local",
          label: prepared.workspacePath,
          ...(prepared.remote ? { connectionState: "connected" as const } : {}),
        };
      } finally {
        pending.preparingProject = false;
      }
    } else {
      target = getAvailableWorkspaces(runtime, session).find(
        (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
      );
    }
    if (
      runtimes.get(runtime.windowId) !== runtime ||
      runtime.terminalSessions.get(session.terminalId) !== session ||
      session.bridgeOpen !== pending
    )
      throw new Error("Workspace bridge request was superseded.");
    if (!target) {
      throw new Error("目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。");
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    const invalidation = session.pendingBridgeInvalidation;
    if (
      invalidation?.bridgeSessionId === request.bridgeSessionId &&
      invalidation.bridgeGeneration === request.bridgeGeneration
    ) {
      throw new Error("Degraded workspace bridge must be rebuilt with a new transport identity.");
    }
    // 收到新 identity 的 open 已证明手机消费了 invalidation；后续失败由显式 bridge-error
    // 和 Web 侧有界 retry 收口，不再重复旧 generation 的 degraded 通知。
    session.pendingBridgeInvalidation = undefined;

    disposeRuntimeBridgeResources(runtime, session);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    emitRuntimeStatus(runtime);

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    session.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${runtime.windowId} session=${runtime.deviceSid} terminal=${session.terminalId} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      acquired = await dependencies.attachWorkspaceHost(runtime.windowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      if (
        !isCurrentBridgeRuntime(runtime, session, bridgeRuntime) ||
        session.bridgeOpen !== pending
      ) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(
            frame,
            session.terminalId === LEGACY_TERMINAL_SESSION_KEY
              ? undefined
              : session.terminalId,
          ) ?? measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(runtime, payload, session);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix：raw adapter 是唯一 replay owner；main 不再把 rpc-frame 放进普通 50 项 buffer。
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, session, fault.reasonCode);
      });
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, session, bridgeRuntime) || bridgeRuntime.degraded)
          return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, session, bridgeRuntime) || bridgeRuntime.degraded)
          return;
        hostProtocol.sendFlowState("drained");
      });

      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      if (isCurrentBridgeRuntime(runtime, session, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime, session);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, session, request);
      sendAppPayload(
        runtime,
        {
          zcode_type: "workspace-bridge-ready",
          requestId: request.requestId,
          bridgeSessionId: request.bridgeSessionId,
          ...(request.bridgeGeneration !== undefined
            ? { bridgeGeneration: request.bridgeGeneration }
            : {}),
          ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
          bridge,
        },
        session,
      );
      const currentBridge = session.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready 必须先进入 ordinary app transport，才允许 queued raw frames 开闸。
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed window=${runtime.windowId} session=${runtime.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      }, session);
    }
  }

  async function respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      await dependencies.reconnectWorkspace(runtime.windowId, request.workspaceKey);
      sendAppPayload(
        runtime,
        {
          zcode_type: "workspace-reconnect-response",
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: true,
        },
        session,
      );
    } catch (error) {
      sendAppPayload(
        runtime,
        {
          zcode_type: "workspace-reconnect-response",
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        session,
      );
    }
  }

  function applyMobileViewStateUpdate(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void {
    session.mobileViewState = viewState;
    runtime.mobileViewState = viewState;
    if (deviceInfo) {
      session.mobileDeviceInfo = deviceInfo;
    }
    session.lastActivityAt = Date.now();
  }

  function applyMobileTaskViewUpdate(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    payload: WebRemoteControlMobileTaskViewUpdatePayload,
  ): void {
    const bridge = session.currentBridge;
    const view = payload.view;
    // 导航缓存、断线宽限和旧 bridge 回包都不能证明当前查看；只接收本代配对的完整地址。
    if (
      runtime.transportState !== "paired" ||
      payload.epoch !== session.mobileTaskViewEpoch ||
      payload.seq <= (session.mobileTaskViewSeq ?? -1) ||
      !bridge?.readyAnnounced ||
      bridge.degraded ||
      payload.bridgeSessionId !== bridge.bridgeSessionId ||
      payload.bridgeGeneration !== bridge.bridgeGeneration ||
      (view &&
        (view.workspacePath !== bridge.workspacePath ||
          resolveWebRemoteControlWorkspaceKey(view) !== bridge.workspaceKey))
    )
      return;
    session.mobileTaskViewSeq = payload.seq;
    // legacy 身份不能反查 Source；读与 CAS 必须携带所属 bridge 的可信 session，不能接受 Web 自报。
    const trustedView = view
      ? {
          ...view,
          ...(bridge.kind === "remote" ? { remoteSessionId: bridge.remoteSessionId } : {}),
        }
      : undefined;
    const previous = session.mobileTaskView;
    if (
      previous?.taskId === trustedView?.taskId &&
      previous?.workspacePath === trustedView?.workspacePath &&
      previous?.workspaceIdentity === trustedView?.workspaceIdentity &&
      previous?.remoteSessionId === trustedView?.remoteSessionId
    )
      return;
    session.mobileTaskView = trustedView;
    emitRuntimeStatus(runtime);
  }

  function routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    routeRawTransportCandidate(runtime, session, frame);
  }

  function routeRawTransportCandidate(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    payload: unknown,
  ): boolean {
    const bridge = session.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  function logMobileDiagnostic(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      window: runtime.windowId,
      session: runtime.deviceSid,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      pairStatus: payload.pairStatus,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  function routePayload(
    runtime: WindowControlRuntime,
    session: TerminalSession,
    payload: WebRemoteControlAppPayload,
  ): void {
    switch (payload.zcode_type) {
      case "bootstrap-request":
        sendAppPayload(
          runtime,
          {
            zcode_type: "bootstrap-response",
            requestId: payload.requestId,
            success: true,
            result: buildBootstrapResult(runtime, session),
          },
          session,
        );
        break;
      case "workspace-list-request":
        sendAppPayload(
          runtime,
          {
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: true,
            result: buildWorkspaceListResult(runtime, session),
          },
          session,
        );
        break;
      case "platform-request":
        void respondToPlatformRequest(runtime, session, payload);
        break;
      case "mobile-view-state-update":
        applyMobileViewStateUpdate(runtime, session, payload.viewState, payload.deviceInfo);
        break;
      case "mobile-task-view-update":
        applyMobileTaskViewUpdate(runtime, session, payload);
        break;
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(runtime, session, payload);
        break;
      case "workspace-reconnect-request":
        void respondToWorkspaceReconnectRequest(runtime, session, payload);
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRpcTransportPayload(runtime, session, payload);
        break;
      case "telemetry-report":
        // 手机已在创建边界构造事件；Main 只转发，不维护会话事实或干预 replayable 链路。
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, session, payload);
        break;
      default:
        break;
    }
  }

  function mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    // 瞬时查看不能沿用连接弹窗的断线宽限；恢复必须由新 epoch 下的可见页面重新声明。
    if (state !== "paired") {
      for (const session of runtime.terminalSessions.values()) {
        session.mobileTaskViewEpoch = undefined;
        session.mobileTaskViewSeq = undefined;
        clearMobileTaskView(runtime, session);
      }
    } else if (previousTransportState !== "paired") {
      for (const session of runtime.terminalSessions.values()) {
        session.mobileTaskViewEpoch = randomUUID();
        session.mobileTaskViewSeq = -1;
      }
    }
    if (state !== "paired") {
      runtime.hasObservedSendReadyForPairing = false;
    }
    if (state === "waiting_terminal" || state === "paired") {
      runtime.error = undefined;
      runtime.failure = undefined;
    }
    if (state === "connecting" || state === "authenticating") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话的 relay 短抖会先经历 connecting/authenticating。
        // 旧逻辑把 dialog 立刻切成“启动中”，用户会误以为远控重新启动；这里在宽限期内保持 active。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "starting";
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "waiting_terminal") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话恢复时 relay 可能短暂回 waiting。
        // 旧逻辑会把 dialog 从 active 拉回“等待手机匹配”；这里先防抖，超时仍未 paired 再降级。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      emitRuntimeStatus(runtime);
      // Bugfix: 普通断线重连重新 paired 时 transport 不一定触发 onSendReady。
      // 这里在状态恢复为可发送后主动 flush，避免重连窗口内缓冲的响应/RPC 帧超时丢弃。
      for (const session of runtime.terminalSessions.values()) {
        flushPendingOutboundPayloads(runtime, session);
        sendPendingBridgeInvalidation(runtime, session);
        if (previousTransportState !== "paired") requestMobileTaskView(runtime, session);
      }
      return;
    }
    if (state === "kicked") {
      if (previousTransportState !== "kicked") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      preserveWindowRuntimeFailure(
        runtime.windowId,
        runtime,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      if (previousTransportState !== "error") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      runtime.status = "error";
      emitRuntimeStatus(runtime);
    }
  }

  function createQrUrl(
    deviceSid: string,
    mobileRemoteControlUrl: string,
    selfHostKey: string | null,
  ): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: mobileRemoteControlUrl,
      deviceSid,
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
      selfHostKey,
    });
  }

  return {
    authorizeStart,
    async startAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.start(windowId, context);
    },
    async start(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      clearStartAuthorizationsForWindow(windowId);
      dependencies.featureGate.assertEnabled();
      startupRestoreClaimed = true;
      const stopped = stopWindowRuntime(windowId, "restart");
      const controller = new AbortController();
      const lifecycle: WindowControlLifecycle = { controller };
      windowLifecycles.set(windowId, lifecycle);
      const signal = controller.signal;
      const assertActive = () => signal.throwIfAborted();
      try {
        await stopped;
        const readAuthContext = async () => {
          for (;;) {
            const revision = authNotificationRevision;
            const endpointUrls = await dependencies.getEndpointUrls?.();
            const login = await dependencies.getLogin();
            assertActive();
            // 首次读取尚未绑定身份时也可能发生换号，不能把旧读取绑定到新登录之后。
            if (revision === authNotificationRevision) return { endpointUrls, login };
          }
        };
        const { endpointUrls, login } = await readAuthContext();
        const relayWsUrl = endpointUrls?.relayWsUrl ?? dependencies.relayWsUrl;
        const mobileRemoteControlUrl =
          endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;
        // 门控（最终 URL origin）在依赖侧完成后在此折叠成值：onStateChange 是同步回调，不能 await。
        const selfHostQrKey = dependencies.getSelfHostQrKey
          ? ((await dependencies.getSelfHostQrKey(mobileRemoteControlUrl)) ?? null)
          : null;
        const endpointOrigin = new URL(endpointUrls?.origin ?? mobileRemoteControlUrl).origin;
        assertActive();
        if (!login?.jwt || !login.userId) {
          requireAuthentication(windowId);
          throw new WebRemoteControlV2ConnectionError("auth-required");
        }
        lifecycle.identity = { userId: login.userId, endpointOrigin };
        authRequiredWindows.delete(windowId);
        await dependencies.deviceStorage.clearLegacy();
        assertActive();
        const http = createWebRemoteControlV2Http(endpointOrigin);
        const currentLogin = async () => {
          const current = await dependencies.getLogin();
          const endpoint = await dependencies.getEndpointUrls?.();
          assertActive();
          if (
            !current?.jwt ||
            current.userId !== login.userId ||
            (endpoint && endpoint.origin !== endpointOrigin)
          ) {
            throw new WebRemoteControlV2ConnectionError("auth-required");
          }
          return current;
        };
        const register = (force: boolean, transportSignal: AbortSignal) => {
          const registrationSignal = AbortSignal.any([signal, transportSignal]);
          // 同一 manager 串行读取/更新身份，避免多窗口首次启动各自覆盖持久化 SID。
          const operation = registrationQueue.then(async () => {
            const current = await currentLogin();
            const stored = await dependencies.deviceStorage.load();
            registrationSignal.throwIfAborted();
            if (
              !force &&
              stored?.userId === current.userId &&
              stored.endpointOrigin === endpointOrigin
            )
              return stored.deviceSid;
            if (stored?.endpointOrigin === endpointOrigin) {
              try {
                await http.delete(stored.deviceSid, current.jwt, registrationSignal);
              } catch {
                dependencies.logger.warn("[web-remote-control] V2 old device cleanup failed");
              }
            }
            registrationSignal.throwIfAborted();
            const deviceSid = await http.register(
              dependencies.deviceMid,
              current.jwt,
              registrationSignal,
            );
            await currentLogin();
            registrationSignal.throwIfAborted();
            try {
              await dependencies.deviceStorage.save({
                deviceSid,
                userId: current.userId,
                endpointOrigin,
              });
            } catch (error) {
              // 保存失败不是网络故障；裸错误会让 transport 每次退避都注册新 SID，留下孤儿设备。
              // 新 SID 尚未建连，先尽力撤销远端注册，再以不可重试错误结束本次启动。
              dependencies.logger.error(
                "[web-remote-control] V2 device identity persistence failed",
                error,
              );
              try {
                await http.delete(deviceSid, current.jwt, registrationSignal);
              } catch {
                dependencies.logger.warn("[web-remote-control] V2 new device cleanup failed");
              }
              throw new WebRemoteControlV2ConnectionError("relay-unavailable");
            }
            registrationSignal.throwIfAborted();
            dependencies.logger.info("[web-remote-control] V2 device registered");
            return deviceSid;
          });
          registrationQueue = operation.catch(() => {});
          return operation;
        };
        let deviceSid = "";
        let runtime: WindowControlRuntime;
        let readySettled = false;
        let persistEnabled: Promise<void> | undefined;
        const readyPromise = new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve();
          };
          const aborted = () => finish(new Error("Web remote control start cancelled"));
          signal.addEventListener("abort", aborted, { once: true });
          const timeout = setTimeout(
            () =>
              finish(
                new Error("External relay device did not reach QR-ready state before timeout."),
              ),
            EXTERNAL_RELAY_QR_READY_TIMEOUT_MS,
          );
          const transport = createTransport({
            relayWsUrl,
            deviceMid: dependencies.deviceMid,
            meta: {
              platform: process.platform,
              version: dependencies.appVersion,
              name: dependencies.deviceName,
            },
            getToken: async (transportSignal) => {
              const current = await currentLogin();
              const token = await http.token(
                current.jwt,
                AbortSignal.any([signal, transportSignal]),
              );
              await currentLogin();
              dependencies.logger.info("[web-remote-control] V2 device token acquired");
              return token;
            },
            resolveDeviceSid: async (transportSignal, forceRegistration) => {
              deviceSid = await register(forceRegistration, transportSignal);
              if (runtimes.get(windowId) === runtime) {
                runtime.deviceSid = deviceSid;
                runtime.qrUrl = runtime.connectUrl = "";
              }
              return deviceSid;
            },
            logger: dependencies.logger,
            onStateChange: (state) => {
              if (runtimes.get(windowId) !== runtime) return;
              if (state === "waiting_terminal" || state === "paired") {
                runtime.qrUrl = runtime.connectUrl = createQrUrl(
                  deviceSid,
                  mobileRemoteControlUrl,
                  selfHostQrKey,
                );
              }
              mapTransportState(runtime, state);
              if (state === "waiting_terminal" || state === "paired") {
                // 首个调用超时不撤销后台恢复；首次真正 ready 时仍须保存启用意图。
                persistEnabled ??= dependencies.startupRestoreStorageProvider.save({
                  workspacePath: context.workspacePath,
                  workspaceIdentity: context.workspaceIdentity,
                  initialTaskId: context.initialTaskId,
                });
                void persistEnabled.then(
                  () => finish(),
                  (error: unknown) => {
                    finish(error instanceof Error ? error : new Error(String(error)));
                    if (runtimes.get(windowId) === runtime)
                      void stopWindowRuntime(windowId, "startup-restore-persist-failed");
                  },
                );
              }
              if (state === "kicked") finish(new Error("session-conflict"));
            },
            onPayload: (payload, terminalId) =>
              routePayload(runtime, getOrCreateTerminalSession(runtime, terminalId), payload),
            onRawTransportPayload: (payload, terminalId) =>
              routeRawTransportCandidate(
                runtime,
                getOrCreateTerminalSession(runtime, terminalId),
                payload,
              ),
            onRawTransportFault: (reasonCode) => {
              // 入站裸帧超限在解析前无法归属 terminal，按 transport 级故障处理：
              // 所有 session 的 bridge 都标记 degraded，各页面走自己的既有恢复链路。
              for (const session of runtime.terminalSessions.values()) {
                degradeBridgeAfterRawFault(runtime, session, reasonCode);
              }
            },
            onTerminalIdsChange: (terminalIds) => {
              if (runtimes.get(windowId) !== runtime) return;
              reconcileTerminalIds(runtime, terminalIds);
            },
            onSendReady: (event) => {
              for (const session of runtime.terminalSessions.values()) {
                flushPendingOutboundPayloads(runtime, session);
              }
              const isFirstSendReadyForPairing = !runtime.hasObservedSendReadyForPairing;
              runtime.hasObservedSendReadyForPairing = true;
              if (event.kind === "reconnected-socket" || isFirstSendReadyForPairing) {
                // Bug 原因：same-socket 心跳 ACK 每约 10 秒都会触发 send-ready；若每次都补发
                // degraded latch，Web 会反复重建同一恢复 generation，破坏 1s/2s/5s 有界退避。
                for (const session of runtime.terminalSessions.values()) {
                  sendPendingBridgeInvalidation(runtime, session);
                  requestMobileTaskView(runtime, session);
                }
              }
              for (const session of runtime.terminalSessions.values()) {
                const relayProtocol = session.currentBridge?.relayProtocol;
                // 同 bridge 未 ACK 批次仍由 adapter 独占；重连后重放，不刷新 queued age。
                if (relayProtocol && !relayProtocol.isDegraded())
                  relayProtocol.replayUnacknowledged();
              }
            },
            onError: (error) => {
              if (runtimes.get(windowId) !== runtime) return;
              const failure = createFailure(
                error instanceof WebRemoteControlV2ConnectionError
                  ? error.reason
                  : "relay-unavailable",
                error.message,
              );
              finish(error);
              if (failure.reason === "auth-required") requireAuthentication(windowId);
              else preserveWindowRuntimeFailure(windowId, runtime, "v2-auth-failed", failure);
            },
          });
          runtime = {
            windowId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
            remoteSessionId: context.remoteSessionId,
            initialTaskId: context.initialTaskId,
            theme: context.theme,
            status: "starting",
            deviceSid,
            deviceMid: dependencies.deviceMid,
            connectUrl: "",
            qrUrl: "",
            transport,
            mobileConnected: false,
            hasEverPaired: false,
            hasObservedSendReadyForPairing: false,
            terminalSessions: new Map(),
          };
          runtimes.set(windowId, runtime);
          emitRuntimeStatus(runtime);
          transport.start();
        });
        await readyPromise;
        assertActive();
        return {
          status: runtime!.status === "active" ? "active" : "running",
          sessionId: deviceSid,
          windowControlSessionId: deviceSid,
          qrUrl: runtime!.qrUrl,
          connectUrl: runtime!.connectUrl,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          remoteSessionId: context.remoteSessionId,
          initialTaskId: context.initialTaskId,
        };
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          requireAuthentication(windowId);
        }
        throw error;
      }
    },

    async stop(windowId: number): Promise<void> {
      lifecycleRevision += 1;
      authNotificationRevision += 1;
      startupRestoreClaimed = true;
      authRequiredWindows.delete(windowId);
      clearStartAuthorizationsForWindow(windowId);
      // Bugfix: 清除自动恢复设置需要写磁盘，失败时不能阻止用户关闭当前远控连接。
      // 先释放 transport 和 attachment，再把持久化错误返回 UI，保证本次运行立即停止。
      await stopWindowRuntime(windowId, "manual-stop");
      await dependencies.startupRestoreStorageProvider.clear();
    },

    async suspend(windowId: number, reason: string): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, reason);
    },

    async notifyAuthStateChanged(
      windowId: number,
      change: WebRemoteControlAuthStateChange,
    ): Promise<void> {
      const revision = ++authNotificationRevision;
      if (change.state === "signed-in") {
        const login = await dependencies.getLogin();
        const endpointUrls = await dependencies.getEndpointUrls?.();
        if (revision !== authNotificationRevision) return;
        if (!login?.jwt || !login.userId) {
          requireAuthentication(windowId);
          return;
        }
        const endpointOrigin = new URL(endpointUrls?.origin ?? dependencies.mobileRemoteControlUrl)
          .origin;
        const staleWindows = [...windowLifecycles].filter(
          ([, lifecycle]) =>
            lifecycle.identity &&
            (lifecycle.identity.userId !== login.userId ||
              lifecycle.identity.endpointOrigin !== endpointOrigin),
        );
        if (staleWindows.length > 0) {
          lifecycleRevision += 1;
          startupRestoreClaimed = false;
          // 先同步撤销所有旧代再等待；已认证 socket 不会重新验证 JWT，不能只等下一次取 token。
          await Promise.all(
            staleWindows.map(([id]) => {
              clearStartAuthorizationsForWindow(id);
              return stopWindowRuntime(id, "auth-identity-changed");
            }),
          );
          if (revision !== authNotificationRevision) return;
        }
        for (const id of authRequiredWindows)
          dependencies.onStatusChanged?.(id, { status: "idle" });
        authRequiredWindows.clear();
        for (const [candidateWindowId, contexts] of availableWorkspacesByWindowId) {
          if (await this.restorePreviouslyEnabled(candidateWindowId, contexts)) break;
          if (revision !== authNotificationRevision) return;
        }
        return;
      }
      lifecycleRevision += 1;
      startupRestoreClaimed = false;
      const windowIds = new Set([
        windowId,
        ...availableWorkspacesByWindowId.keys(),
        ...runtimes.keys(),
        ...windowLifecycles.keys(),
      ]);
      // 先同步撤销所有窗口的启动/连接，再等待调用方；登出不能被慢 HTTP 写回复活。
      for (const id of windowIds) {
        clearStartAuthorizationsForWindow(id);
        requireAuthentication(id);
      }
    },

    async restorePreviouslyEnabled(
      windowId: number,
      candidates: Array<WebRemoteControlContext & { label?: string }>,
    ): Promise<boolean> {
      // 修复原因：候选快照与 syncAvailableWorkspaces 共用同一份 WorkspaceTarget 表，label 是必填展示字段；
      // 生产调用方传入完整目标，只有仅携带 context 的调用需要回退到路径，不能写入缺 label 的列表项。
      availableWorkspacesByWindowId.set(
        windowId,
        candidates.map((candidate) => ({
          ...candidate,
          label: candidate.label ?? candidate.workspacePath,
          kind: candidate.workspaceIdentity || candidate.remoteSessionId ? "remote" : "local",
        })),
      );
      // 401/登出后只有登录通知能解除门禁，workspace 同步不能重试失效 JWT。
      if (startupRestoreClaimed || runtimes.has(windowId) || authRequiredWindows.has(windowId))
        return false;
      const revision = lifecycleRevision;
      const persistedContext = await dependencies.startupRestoreStorageProvider
        .load()
        .catch((error) => {
          dependencies.logger.warn(
            "[web-remote-control] load startup restore context failed",
            error,
          );
          return undefined;
        });
      if (revision !== lifecycleRevision || startupRestoreClaimed || !persistedContext) {
        return false;
      }

      const persistedWorkspaceKey = resolveWebRemoteControlWorkspaceKey(persistedContext);
      // 磁盘读取期间可能发生 tab 关闭或远端重连，只能消费最新完整快照。
      const currentContext = availableWorkspacesByWindowId
        .get(windowId)
        ?.find(
          (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === persistedWorkspaceKey,
        );
      if (
        !currentContext ||
        (currentContext.kind === "remote" && !currentContext.remoteSessionId)
      ) {
        return false;
      }

      startupRestoreClaimed = true;
      dependencies.logger.info(
        `[web-remote-control] restoring previous enabled state window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
      );
      try {
        await this.start(windowId, {
          workspacePath: currentContext.workspacePath,
          workspaceIdentity: currentContext.workspaceIdentity,
          remoteSessionId: currentContext.remoteSessionId,
          initialTaskId: persistedContext.initialTaskId,
        });
        return true;
      } catch (error) {
        if (revision === lifecycleRevision) startupRestoreClaimed = false;
        dependencies.logger.warn(
          "[web-remote-control] restore previous enabled state failed",
          error,
        );
        return false;
      }
    },

    getStatus(windowId: number): WebRemoteControlStatus {
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      if (authRequiredWindows.has(windowId)) return { status: "auth-required" };
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return { status: "idle" };
      }

      return buildRuntimeStatus(runtime);
    },

    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      availableWorkspacesByWindowId.set(windowId, workspaces);
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      pushWorkspaceListUpdated(runtime);
    },

    async replaceRemoteSession(event: {
      previousSessionId: string;
      sessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<void> {
      for (const [windowId, runtime] of runtimes) {
        const runtimeMatches = runtime.remoteSessionId === event.previousSessionId;
        const availableWorkspaces = availableWorkspacesByWindowId.get(windowId);
        if (availableWorkspaces) {
          availableWorkspacesByWindowId.set(
            windowId,
            availableWorkspaces.map((workspace) =>
              workspace.remoteSessionId === event.previousSessionId &&
              workspace.workspacePath === event.workspacePath &&
              workspace.workspaceIdentity === event.workspaceIdentity
                ? { ...workspace, remoteSessionId: event.sessionId, connectionState: "connected" }
                : workspace,
            ),
          );
        }
        if (runtimeMatches) runtime.remoteSessionId = event.sessionId;
        let anyBridgeMatched = false;
        for (const session of runtime.terminalSessions.values()) {
          const bridge = session.currentBridge;
          const bridgeMatches =
            bridge?.remoteSessionId === event.previousSessionId &&
            bridge.workspacePath === event.workspacePath &&
            bridge.workspaceIdentity === event.workspaceIdentity;
          if (!bridgeMatches || !bridge) continue;
          anyBridgeMatched = true;

          // Bug 原因：过去 Main 复用相同 bridge identity 重建 acknowledged protocol，
          // 新协议的 seq 从 1 开始，手机 assembler 却仍等待 N+1，新帧会被当成旧 duplicate
          // 静默丢弃。这里只发非终态 degraded，由 Web 已有恢复流程以新 identity 主动重建。
          bridge.degraded = true;
          session.pendingBridgeInvalidation = {
            zcode_type: "bridge-degraded",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration === undefined
              ? {}
              : { bridgeGeneration: bridge.bridgeGeneration }),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            reason: "source-session-replaced",
          };
          disposeRuntimeBridgeResources(runtime, session);
          sendPendingBridgeInvalidation(runtime, session);
        }
        if (anyBridgeMatched || runtimeMatches || availableWorkspaces) {
          pushWorkspaceListUpdated(runtime);
        }
      }
    },

    async disposeWindow(windowId: number): Promise<void> {
      lifecycleRevision += 1;
      authRequiredWindows.delete(windowId);
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, "window-disposed");
      availableWorkspacesByWindowId.delete(windowId);
    },

    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      for (const [windowId, runtime] of runtimes) {
        const runtimeUsesRemoteSession = runtime.remoteSessionId === remoteSessionId;
        let anyBridgeUsesRemoteSession = false;
        for (const session of runtime.terminalSessions.values()) {
          const bridge = session.currentBridge;
          if (bridge?.remoteSessionId !== remoteSessionId) continue;
          anyBridgeUsesRemoteSession = true;

          // Bugfix: 远程 workspace session 只是某个 workspace/bridge 的依赖，不能把它的断开升级成
          // 窗口级 Web 远控 device WS 失败；否则单个远端空闲退出会错误关闭电脑端全局远控入口。
          disposeRuntimeBridgeResources(runtime, session);
          sendAppPayload(
            runtime,
            {
              zcode_type: "workspace-bridge-error",
              bridgeSessionId: bridge.bridgeSessionId,
              ...(bridge.bridgeGeneration !== undefined
                ? { bridgeGeneration: bridge.bridgeGeneration }
                : {}),
              ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
              requestId: `remote-session-closed:${remoteSessionId}`,
              reason: failure.reason,
              error: failure.message ?? failure.reason,
            },
            session,
          );
        }
        if (!anyBridgeUsesRemoteSession && !runtimeUsesRemoteSession) {
          continue;
        }
        if (runtimeUsesRemoteSession) {
          runtime.remoteSessionId = undefined;
        }
        // workspace 生命周期不能复活因401或KICKED终止的设备连接。
        if (runtime.status !== "error") {
          runtime.status = runtime.mobileConnected ? "active" : "running";
          runtime.error = undefined;
          runtime.failure = undefined;
        }
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
      }
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}
