export * from "./contract/manifest.js";
export type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  ComputerUseRuntimeOptions,
  ComputerUseRuntimeExecuteInput,
} from "../index.js";
export interface NativeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  kcode?: {
    capability: string;
    generation: string;
    session: string;
    epoch: number;
    operationId: string;
  };
  capability?: string;
  context?: { session: string; epoch: number; generation: string; operationId: string };
}
export interface NativeError {
  code: string;
  message: string;
  dispatchStatus?: string;
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
  close(): Promise<void>;
}
