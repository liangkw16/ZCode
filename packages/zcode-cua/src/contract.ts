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
  close(): Promise<void>;
}
