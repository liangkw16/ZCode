import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const runtimeDirectory = (env: Record<string, string | undefined> = process.env) =>
  env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "zcode-cua")
    : `/tmp/zcode-cua-${process.getuid?.() ?? "nouid"}`;
export function resolveBrokerSocketPath(
  options: { dir?: string; env?: Record<string, string | undefined> } = {},
) {
  const env = options.env ?? process.env;
  return (
    env.ZCODE_CUA_PERMISSION_BROKER_SOCKET ||
    join(options.dir ?? runtimeDirectory(env), "kcode-broker.sock")
  );
}
export function mintBrokerSocketPath(options: { dir?: string } = {}) {
  return join(options.dir ?? tmpdir(), `kcode-cua-broker-${randomUUID()}.sock`);
}
