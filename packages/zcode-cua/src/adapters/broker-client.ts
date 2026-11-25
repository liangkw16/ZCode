import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { IPC_VERSION, MAX_MESSAGE_BYTES, CONTROL_METHODS } from "../contract/manifest.js";
import type { BrokerPort } from "../contract.js";

export class NativeBrokerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.details = details;
  }
}
interface Auth {
  authenticated: boolean;
  serverApiVersion?: number;
  kcode?: {
    generation: string;
    capability: string;
    cleanupFence: boolean;
    pixelsOnly?: boolean;
    pid?: number;
    cancellationEpoch?: number;
  };
}
interface Operation {
  capability: string;
  generation: string;
  session: string;
  epoch: number;
  operationId: string;
}
interface ExchangeOptions {
  timeoutMs: number;
  operation?: Operation;
  beforeDispatch?: (auth: Auth) => void;
  dispatched?: () => void;
  afterDrain?: AbortSignal;
  session?: string;
  role?: "tool" | "presentation";
}
function exchange<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  options: ExchangeOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let authenticated = false;
    let done = false;
    const finish = (error?: unknown, result?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.afterDrain?.removeEventListener("abort", onDrain);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    const onDrain = () => finish(options.afterDrain?.reason);
    options.afterDrain?.addEventListener("abort", onDrain, { once: true });
    const timer = setTimeout(
      () => finish(new NativeBrokerError("timeout", "CUA broker request deadline exceeded")),
      options.timeoutMs,
    );
    socket.once("error", (error) =>
      finish(
        new NativeBrokerError("broker_unavailable", "CUA broker connection failed", {
          connection_code: (error as NodeJS.ErrnoException).code,
        }),
      ),
    );
    socket.once("close", () =>
      finish(new NativeBrokerError("broker_unavailable", "CUA broker closed before replying")),
    );
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: 0,
          method: "authenticate",
          params: {
            clientApiVersion: IPC_VERSION,
            extensions: ["kcode-cleanup-v1"],
            ...(options.session ? { session_id: options.session } : {}),
            ...(options.role ? { role: options.role } : {}),
          },
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        finish(new NativeBrokerError("invalid_response", "CUA response exceeds byte limit"));
        return;
      }
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        let response: {
          id: number;
          ok: boolean;
          result: unknown;
          error?: { code?: string; message?: string; details?: Record<string, unknown> };
        };
        try {
          response = JSON.parse(buffer.slice(0, i));
        } catch {
          finish(new NativeBrokerError("invalid_response", "CUA response is not valid JSON"));
          return;
        }
        buffer = buffer.slice(i + 1);
        // 修复原因：JSON 合法不代表是响应对象（"null" 会解析成 null），直接取 .id 会在 data
        // 事件回调里抛 TypeError；它不在 Promise 的捕获范围内，会冒泡成 Host 进程的未捕获异常。
        if (response === null || typeof response !== "object" || Array.isArray(response)) {
          finish(new NativeBrokerError("invalid_response", "CUA response is not an object"));
          return;
        }
        if (response.id !== (authenticated ? 1 : 0) || typeof response.ok !== "boolean") {
          finish(new NativeBrokerError("invalid_response", "CUA response identity mismatch"));
          return;
        }
        if (!response.ok) {
          finish(
            new NativeBrokerError(
              response.error?.code ?? "internal",
              response.error?.message ?? "CUA request failed",
              response.error?.details,
            ),
          );
          return;
        }
        if (!authenticated) {
          const auth = response.result as Auth;
          if (
            auth?.authenticated !== true ||
            (auth.serverApiVersion !== undefined && auth.serverApiVersion !== IPC_VERSION)
          ) {
            finish(
              new NativeBrokerError("version_mismatch", "CUA authentication or protocol mismatch"),
            );
            return;
          }
          try {
            options.beforeDispatch?.(auth);
          } catch (error) {
            finish(error);
            return;
          }
          authenticated = true;
          const nativeParams = { ...params };
          // 只在响应本次握手的 Helper 支持时发送。旧 v3 Helper 仍接收原参数。
          if (method === "capture_app" && auth.kcode?.pixelsOnly !== true)
            delete nativeParams.pixels_only;
          const payload = JSON.stringify({
            id: 1,
            method,
            params: {
              ...nativeParams,
              ...(options.operation ? { kcode_operation: options.operation } : {}),
            },
          });
          if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) {
            finish(new NativeBrokerError("invalid_request", "CUA request exceeds byte limit"));
            return;
          }
          options.dispatched?.();
          socket.write(payload + "\n");
        } else {
          finish(undefined, response.result as T);
          return;
        }
      }
    });
  });
}
const OBSERVATIONS = new Set([
  "broker_info",
  "controller_status",
  "permission_status",
  "request_access",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  "is_focus_steal_prevented",
  "pip_is_running",
]);
const INPUT_RECOVERY_REASONS = new Set([
  "input_recovery_focus_required",
  "input_recovery_release_uncertain",
  "input_recovery_target_unverified",
]);
const needsObservation = () => new NativeBrokerError(
  "stale_state", "Helper recovery requires a fresh observation before input",
  { action_sent: false, dispatch_status: "not_sent" },
);
// 修复原因：长按最长 30 秒，原生在松开后才回包；沿用固定的请求 deadline 时，客户端会先超时并
// 取消已经派发的按键。请求 deadline 在原有预算之上加上按住时长；调用方即时取消不受影响。
function holdSeconds(params: unknown): number {
  const duration = (params as { duration?: unknown } | null)?.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? duration
    : 0;
}
export function createBrokerClient(options: {
  socketPath: string;
  timeoutMs?: number;
  role?: "tool" | "presentation";
}): BrokerPort {
  let generation: string | undefined;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const frozenSessions = new Map<string, number | undefined>();
  const observationFences = new Map<string, { pending: boolean }>();
  const fenceObservation = (session: string) => observationFences.set(session, { pending: true });
  let helperPid: number | undefined;
  const processEnded = (pid: number | undefined) => {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const sessionEpochs = new Map<string, number>();
  async function call<T>(
    method: string,
    params: Record<string, unknown> = {},
    callOptions: {
      signal?: AbortSignal;
      session?: string;
      epoch?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const control = [...CONTROL_METHODS, "controller_stop", "cancel_input_holds"].includes(method);
    const session = callOptions.session;
    const mutation = !OBSERVATIONS.has(method) && !control;
    if (closed) throw new NativeBrokerError("broker_unavailable", "CUA client is closed");
    if (callOptions.signal?.aborted)
      throw new NativeBrokerError("cancelled", "CUA request cancelled before dispatch", {
        action_sent: false,
        dispatch_status: "not_sent",
      });
    if (callOptions.session && frozenSessions.has(callOptions.session)) {
      if (processEnded(frozenSessions.get(callOptions.session))) {
        frozenSessions.delete(callOptions.session);
        fenceObservation(callOptions.session);
      } else if (mutation)
        throw new NativeBrokerError(
          "broker_unavailable",
          "Native cleanup could not be confirmed; mutation is frozen",
          { action_sent: false, dispatch_status: "not_sent" },
        );
    }
    if (session && mutation && observationFences.get(session)?.pending) throw needsObservation();
    const generationAtStart = generation;
    let observationFence: ReturnType<typeof observationFences.get>;
    const local = new AbortController();
    controllers.add(local);
    const abortLocal = () => local.abort();
    callOptions.signal?.addEventListener("abort", abortLocal, { once: true });
    const drained = new AbortController();
    let operation: Operation | undefined;
    let sent = false;
    let cleanup: Promise<void> | undefined;
    const cancel = () => {
      if (!sent || !operation || cleanup) return;
      // 中断只能在原生清理回执后结束；关闭 socket 并不能证明 AX/输入已停止。
      const pendingOperation = operation;
      const pendingPid = helperPid;
      if (session) fenceObservation(session);
      cleanup = (async () => {
        const deadline = Date.now() + 8000;
        let controlMethod = "operation_cancel";
        let result: { cleanup_complete?: boolean; epoch?: number; dispatch_status?: string } = {};
        for (;;) {
          if (processEnded(pendingPid)) {
            // 进程退出只证明旧 Helper 停止执行，窗口的 up 可能要由下一代恢复。
            throw new NativeBrokerError(
              "helper_exited",
              "Helper exited before scoped input release was confirmed",
            );
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new NativeBrokerError(
              "cleanup_incomplete",
              "Native cleanup exceeded its recovery deadline",
            );
          try {
            result = await exchange(
              options.socketPath,
              controlMethod,
              { operation_id: pendingOperation.operationId },
              {
                operation: pendingOperation,
                session: pendingOperation.session,
                role: options.role,
                timeoutMs: Math.min(controlMethod === "operation_cancel" ? 3500 : 500, remaining),
                beforeDispatch(auth) {
                  if (auth.kcode?.generation !== pendingOperation.generation)
                    throw new NativeBrokerError(
                      "generation_changed",
                      "Helper changed while cleanup was pending",
                    );
                },
              },
            );
            if (session && generation === pendingOperation.generation) {
              fenceObservation(session);
              if (typeof result.epoch === "number")
                sessionEpochs.set(session, Math.max(sessionEpochs.get(session) ?? 0, result.epoch));
            }
            if (result.cleanup_complete === true) break;
          } catch (error) {
            if (
              !(error instanceof NativeBrokerError) ||
              !["broker_unavailable", "timeout", "generation_changed"].includes(error.code)
            )
              throw error;
          }
          controlMethod = "operation_status";
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
          );
        }
        drained.abort(
          new NativeBrokerError("cancelled", "CUA operation cancelled after native cleanup", {
            action_sent: result.dispatch_status !== "not_sent",
            dispatch_status: result.dispatch_status ?? "possibly_sent",
            cleanup_complete: true,
          }),
        );
      })().catch((error) => {
        if (callOptions.session) frozenSessions.set(callOptions.session, pendingPid);
        throw new NativeBrokerError("cleanup_incomplete", "Native cleanup could not be confirmed", {
          action_sent: sent,
          dispatch_status: sent ? "possibly_sent" : "not_sent",
          cause_code: error instanceof NativeBrokerError ? error.code : "internal",
        });
      });
      // Observe immediately; the original exchange can still be waiting on its deadline.
      void cleanup.catch(() => {});
    };
    local.signal.addEventListener("abort", cancel);
    try {
      const result = await exchange<T>(options.socketPath, method, params, {
        timeoutMs:
          (callOptions.timeoutMs ?? options.timeoutMs ?? 12000) + holdSeconds(params) * 1000,
        afterDrain: drained.signal,
        session: callOptions.session,
        role: options.role,
        beforeDispatch(auth) {
          const nextGeneration = auth.kcode?.generation;
          // 并发握手的旧响应不能把已观察到的 generation 改回去。
          if (generation !== generationAtStart && nextGeneration !== generation) throw needsObservation();
          if (generation !== undefined && generation !== nextGeneration) {
            for (const knownSession of sessionEpochs.keys()) fenceObservation(knownSession);
            if (session) fenceObservation(session);
            sessionEpochs.clear();
          }
          generation = nextGeneration;
          helperPid = auth.kcode?.pid;
          if (session) {
            if (!auth.kcode?.cleanupFence)
              throw new NativeBrokerError("version_mismatch", "Helper lacks negotiated cleanup fence");
            const floor = auth.kcode?.cancellationEpoch;
            const known = sessionEpochs.get(session);
            const epoch = typeof floor === "number" && Number.isSafeInteger(floor) && floor >= 0
              ? Math.max(known ?? 0, floor) : known ?? 0;
            sessionEpochs.set(session, epoch);
            if (known !== undefined && epoch > known) fenceObservation(session);
            observationFence = observationFences.get(session);
            if (mutation && observationFence?.pending) throw needsObservation();
            operation = {
              capability: auth.kcode.capability,
              generation: auth.kcode.generation,
              session,
              epoch: Math.max(callOptions.epoch ?? 0, epoch),
              operationId: randomUUID(),
            };
          }
          if (local.signal.aborted)
            throw new NativeBrokerError("cancelled", "CUA request cancelled before dispatch");
        },
        get operation() {
          return operation;
        },
        dispatched() {
          sent = true;
        },
      });
      if (local.signal.aborted) {
        await cleanup;
        throw new NativeBrokerError("cancelled", "CUA operation cancelled after cleanup", {
          action_sent: !OBSERVATIONS.has(method),
          dispatch_status: OBSERVATIONS.has(method) ? "not_sent" : "possibly_sent",
        });
      }
      if (session && method === "capture_app") {
        // 一个 session 的新观察仅能解除派发该观察时的那道栅栏。
        if (operation?.generation !== generation || operation?.epoch !== sessionEpochs.get(session) ||
            observationFence !== observationFences.get(session)) throw needsObservation();
        const capture = result as { screenshot?: { data?: string }; screenshot_blank?: boolean } | null;
        const hasPixels = params.include_screenshot === true &&
          !!capture?.screenshot?.data && !capture.screenshot_blank;
        // 隐藏的 getApp 绑定和无图的纯截图没有观察内容，不能在恢复后解锁写入。
        if (observationFence && (params.tree_shown_to_model !== false || hasPixels))
          observationFence.pending = false;
      }
      return result;
    } catch (error) {
      if (session && mutation && operation?.generation === generation &&
          error instanceof NativeBrokerError && error.code === "action_unavailable" &&
          error.details.dispatch_status === "not_sent" && typeof error.details.reason_code === "string" &&
          INPUT_RECOVERY_REASONS.has(error.details.reason_code)) fenceObservation(session);
      // Helper 已明确拒绝入队时，没有待取消的操作。满额时取消还会尝试登记新栅栏。
      const refusedBeforeDispatch = error instanceof NativeBrokerError &&
        error.details.dispatch_status === "not_sent" && error.details.action_sent === false;
      if (
        !control &&
        sent &&
        operation &&
        !refusedBeforeDispatch &&
        (local.signal.aborted ||
          (error instanceof NativeBrokerError &&
            ["timeout", "broker_unavailable"].includes(error.code)))
      )
        cancel();
      if (cleanup) await cleanup;
      if (
        error instanceof NativeBrokerError &&
        sent &&
        !OBSERVATIONS.has(method) &&
        ["timeout", "broker_unavailable", "invalid_response"].includes(error.code) &&
        !("dispatch_status" in error.details)
      )
        throw new NativeBrokerError(error.code, error.message, {
          ...error.details,
          action_sent: true,
          dispatch_status: "possibly_sent",
        });
      throw error;
    } finally {
      local.signal.removeEventListener("abort", cancel);
      callOptions.signal?.removeEventListener("abort", abortLocal);
      controllers.delete(local);
    }
  }
  return {
    get generation() {
      return generation;
    },
    epoch(session: string) {
      return sessionEpochs.get(session) ?? 0;
    },
    call<T>(
      method: string,
      params?: Record<string, unknown>,
      callOptions?: { signal?: AbortSignal; session?: string; epoch?: number },
    ) {
      const promise = (async () => {
        if (!["session_release", "controller_stop", "cancel_input_holds"].includes(method))
          return call<T>(method, params, callOptions);
        const deadline = Date.now() + 8000;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new NativeBrokerError(
              "cleanup_incomplete",
              "Session release did not drain native work",
            );
          const result = await call<{ cleanup_complete?: boolean; epoch?: number }>(
            method,
            params,
            {
              ...callOptions,
              timeoutMs: Math.min(3500, remaining),
            },
          );
          if (callOptions?.session && typeof result.epoch === "number")
            sessionEpochs.set(callOptions.session, result.epoch);
          if (result.cleanup_complete === true) {
            if (callOptions?.session) fenceObservation(callOptions.session);
            return result as T;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();
      active.add(promise);
      void promise.finally(() => active.delete(promise)).catch(() => {});
      return promise;
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(active);
    },
  };
}
