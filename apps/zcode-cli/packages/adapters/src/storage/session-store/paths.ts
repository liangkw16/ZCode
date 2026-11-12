import { homedir } from "node:os";
import { ZCODE_DATA_DIR_SEGMENT } from "@zcode/contracts";
import { join } from "node:path";

export function getDefaultSessionDbPath(): string {
  return join(homedir(), ZCODE_DATA_DIR_SEGMENT, "cli", "db", "db.sqlite");
}
