import type { CallBrokerMethodArgs, HelperHealth, ProbeHelperHealthOptions } from "./broker.d.ts";
import type { CuaPermissionStatusQueryReport } from "./broker-server.d.ts";

export declare function callBrokerMethod<T = unknown>(args: CallBrokerMethodArgs): Promise<T>;
export declare function probeHelperHealth(
  socketPath: string,
  options?: ProbeHelperHealthOptions,
): Promise<HelperHealth>;
/**
 * 启动同一 bundle 的短命进程读取 AX/录屏 preflight；不持控制 lease、不抓屏、不请求授权。
 * 常驻进程的录屏 preflight 在系统撤销授权后可能仍是旧值。失败或非法响应抛错，调用方按 unknown 处理。
 */
export declare function readFreshHelperPermissions(options: {
  appPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CuaPermissionStatusQueryReport>;
