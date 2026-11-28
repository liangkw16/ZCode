export * from "./manifest.js";
import type { CuaPermissionStatusQueryReport } from "../../broker-server.js";
export type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  ComputerUseRuntimeOptions,
  ComputerUseRuntimeExecuteInput,
} from "../../index.js";
export interface NativeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}
export interface NativeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
export interface NativeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: NativeError;
}
export interface BrokerPort {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      session?: string;
      epoch?: number;
    },
  ): Promise<T>;
  readonly generation: string | undefined;
  epoch(session: string): number;
  close(): Promise<void>;
}
export interface RuntimePorts {
  broker: BrokerPort;
  prepare(): Promise<void>;
  id(): string;
  /**
   * 用同一 bundle 的短命进程重新采样的权限事实。常驻 Helper 进程里的录屏 preflight 在系统撤销
   * 授权后仍可能返回旧的 granted；返回 undefined 或抛出都表示采样失败，按 unknown 处理。
   * 不提供时（注入了现成 socket 的传输）只能沿用常驻进程的快照。
   */
  freshPermissions?(): Promise<CuaPermissionStatusQueryReport | undefined>;
}
