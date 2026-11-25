import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

// 规则来源：docs/superpowers/specs/2026-10-20-kcode-full-isolation-design.md §2——
// `join(<home 或 dataBaseDir>, ".zcode", ...)` 的全局派生点必须走 ZCODE_DATA_DIR_SEGMENT；
// `join(<workingDirectory>, ".zcode", ...)` 的工作区派生点保持字面量。
// 此前的 dataDirSegmentSweep.test.ts 只扫 packages/services 下手挑的 18 个文件，CLI 与 desktop
// 的遗漏点（模型落盘、exec 输出、启动语言、凭据密钥等）全部漏检，这里按规则全仓扫描。

const repoRoot = resolve(import.meta.dirname, "../..");

const SCAN_ROOTS = ["packages", "apps/zcode-cli/packages"];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
// 只扫 git 跟踪的源码文件（构建产物不会被扫到）；这里再排除测试、类型声明与文档。
const EXCLUDED_PATH = /(^|\/)(?:dist|node_modules|tests?|e2e|__tests__|fixtures|docs)\//;
const EXCLUDED_FILE = /\.(?:test|spec|d)\.[cm]?[jt]sx?$|\.stories\./;

// 根来源标记。全局根：与 ".zcode" 出现在同一次调用的实参里即为全局派生点；
// 工作区根：项目内状态，字面量是正确写法。判定取离字面量最近的那个。
const GLOBAL_ROOT_SOURCE =
  "homedir\\(\\)|resolveUserHomeDir\\(\\)|resolveBootstrapHomeDir\\(\\)|homePath|homeDir|dataBaseDir|targetBaseDir|ZCODE_HOME|userDataPath";
const WORKSPACE_ROOT_SOURCE =
  "workingDirectory|workspacePath|workspaceRoot|workspace|cwd|projectRoot|gitRoot|repositoryRoot";
const GLOBAL_ROOT_TOKEN = new RegExp(GLOBAL_ROOT_SOURCE, "g");
const ROOT_TOKEN = new RegExp(`(?:${GLOBAL_ROOT_SOURCE})|(?:${WORKSPACE_ROOT_SOURCE})`, "g");
// `.zcode` 作为路径段紧跟在引号或反引号之后；以及句子里嵌入的 "~/…" 家目录路径（提示文案、模板串）。
const ZCODE_LITERAL = /["'`]\.zcode(["'`/])|["'`]~\/\.zcode|~\/\.zcode(?=[/\s"'`）)（(:：])/g;

/**
 * 去掉注释但保持字符串与行列位置不变，避免注释里提到的 ".zcode" 被当成代码。
 * 按行扫描：单双引号状态不跨行（JSX 文本里的撇号不会把后面的整段代码带偏），
 * 只有模板字符串的反引号状态跨行保留。
 */
export function stripComments(source) {
  const lines = source.split("\n");
  let inBlock = false;
  let inTemplate = false;
  const stripped = lines.map((line) => {
    let output = "";
    let quote = null;
    let previousSignificant = "";
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (inBlock) {
        if (char === "*" && next === "/") {
          inBlock = false;
          output += "  ";
          index += 1;
        } else output += " ";
        continue;
      }
      if (inTemplate) {
        // 模板字符串续行：原文保留，只找结束的反引号。
        output += char;
        if (char === "\\") {
          output += next ?? "";
          index += 1;
        } else if (char === "`") inTemplate = false;
        continue;
      }
      if (quote === null) {
        if (char === "/" && next === "/") {
          // 行注释：整段换成空格，保持长度与行列位置不变。
          output += " ".repeat(line.length - index);
          break;
        }
        if (char === "/" && next === "*") {
          inBlock = true;
          output += "  ";
          index += 1;
          continue;
        }
        if (char === "/" && !/[\w)\]'"`$]/.test(previousSignificant)) {
          // 正则字面量：跳到未转义的结束斜杠，字符类里的斜杠不算结束。
          let regexClass = false;
          output += char;
          while (index + 1 < line.length) {
            const regexChar = line[index + 1];
            output += regexChar;
            index += 1;
            if (regexChar === "\\") {
              output += line[index + 1] ?? "";
              index += 1;
            } else if (regexChar === "[") regexClass = true;
            else if (regexChar === "]") regexClass = false;
            else if (regexChar === "/" && !regexClass) break;
          }
          previousSignificant = "/";
          continue;
        }
        if (char === "'" || char === '"' || char === "`") quote = char;
      } else {
        if (char === "\\") {
          output += char + (next ?? "");
          index += 1;
          continue;
        }
        if (char === quote) quote = null;
      }
      if (!/\s/.test(char)) previousSignificant = char;
      output += char;
    }
    inTemplate = quote === "`";
    return output;
  });
  return stripped.join("\n");
}

/**
 * 取字面量所在的上下文：先找包住它的最内层括号。
 * 调用括号 `(` → 这次调用里位于字面量之前的实参（根通常就是前一个实参）；
 * 数组括号 `[` → 这个数组字面量本身（路径段常量）；其余 → 到最近一个分隔符为止。
 */
function literalContext(code, literalIndex) {
  let depth = 0;
  for (let index = literalIndex - 1; index >= 0; index -= 1) {
    const char = code[index];
    if (char === ")" || char === "]" || char === "}") depth += 1;
    else if (char === "(" || char === "[" || char === "{") {
      if (depth === 0) {
        if (char === "(") return { kind: "call", text: code.slice(index + 1, literalIndex) };
        if (char === "[") return { kind: "array", text: code.slice(index + 1, literalIndex) };
        break;
      }
      depth -= 1;
    }
  }
  const separator = Math.max(
    code.lastIndexOf(",", literalIndex - 1),
    code.lastIndexOf(";", literalIndex - 1),
  );
  return { kind: "other", text: code.slice(separator + 1, literalIndex) };
}

/** 返回所有仍把全局根和 ".zcode" 拼在一起的位置。 */
export function findGlobalZcodeLiterals(source) {
  const code = stripComments(source);
  const findings = [];
  for (const literal of code.matchAll(new RegExp(ZCODE_LITERAL.source, "g"))) {
    const homePathText = /~\/\.zcode$/.test(literal[0]);
    const context = literalContext(code, literal.index);
    // 数组形态只看作为独立路径段的 ".zcode"（`[".zcode", "worktrees"]`），不含带斜杠的字符串枚举。
    const pathSegmentArray = context.kind === "array" && ["'", '"', "`"].includes(literal[1]);
    const roots = [...context.text.matchAll(ROOT_TOKEN)];
    const nearest = roots.at(-1)?.[0];
    const nearestIsGlobal = Boolean(nearest && GLOBAL_ROOT_TOKEN.test(nearest));
    GLOBAL_ROOT_TOKEN.lastIndex = 0;
    // "~/…" 文案与路径段数组恒为全局；调用实参里以最近的根来源为准。
    if (!homePathText && !pathSegmentArray && !(context.kind === "call" && nearestIsGlobal)) {
      continue;
    }
    findings.push({
      line: code.slice(0, literal.index).split("\n").length,
      snippet: source
        .slice(
          code.lastIndexOf("\n", literal.index) + 1,
          code.indexOf("\n", literal.index) === -1 ? undefined : code.indexOf("\n", literal.index),
        )
        .trim(),
      root: pathSegmentArray ? "[...]" : (nearest ?? "~/"),
    });
  }
  return findings;
}

// 仍然允许硬编码全局 ".zcode" 的位置。每条都必须有理由；对应代码修好后本测试会提醒删掉条目
// （条目存在但已无命中即失败），避免豁免清单腐化。path/prefix 选一个，snippet 可再按行内容收窄。
const ALLOWLIST = [
  {
    prefix: "packages/zcode-server-cli/",
    reason: "server 产品自己的安装与数据根；它只部署在远端机器上，恒为 ZCode。",
  },
  {
    prefix: "packages/server/",
    reason: "远端 server 的部署、上传与引导路径；这些路径落在远端机器上，恒为 ZCode server。",
  },
  {
    prefix: "packages/ui/src/i18n/locales/",
    snippet: /~\/\.zcode(\/server|\/plugins|\s)/,
    reason: "文案描述的是远端设备上的目录（推送配置、安装远端服务、远端插件），恒为 ZCode。",
  },
  {
    path: "packages/desktop/src/main/mcpUserDirectory/index.ts",
    snippet: /workspaceConfigDirSegments/,
    reason: "工作区级 MCP 配置目录段，项目内状态。",
  },
  {
    path: "packages/services/src/commands/commandsService.ts",
    snippet: /workspaceDirectorySegments/,
    reason: "工作区级命令目录段；同处的 userDirectorySegments 已按 segment 给出。",
  },
  {
    path: "apps/zcode-cli/packages/core/src/memory/memory-file-path.ts",
    snippet: /^"\.zcode",$/,
    reason: "工作区路径解析的忽略目录名单（与 node_modules、.git 等并列），不是路径拼接。",
  },
  {
    path: "packages/desktop/src/main/mcpUserDirectory/types.ts",
    snippet: /configDirSegments/,
    reason: "工作区级 MCP 来源描述；用户级段由 index.ts 的 userConfigDirSegments 按 segment 给出。",
  },
  {
    path: "packages/services/src/mcp-sync/mcpSyncService.ts",
    snippet: /workspaceConfigDirSegments/,
    reason: "工作区级 MCP 配置目录段，项目内状态。",
  },
  {
    path: "packages/services/src/runtime-tools/providerRuntimeResolver.ts",
    reason:
      "本机 Source Server 的 agents 资源根（~/.zcode/server）；该运行时是否随产品隔离尚未决定。",
  },
  {
    path: "apps/zcode-cli/packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs",
    reason: "旧会话恢复脚本默认读写 ~/.zcode 下的库；kcode 下这个技能的语义尚未决定。",
  },
  {
    path: "apps/zcode-cli/packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/restore-conversation.mjs",
    reason: "同 scan-legacy-sessions.mjs。",
  },
  {
    path: "apps/zcode-cli/packages/zcode-cua-plugin/scripts/sync-cache.mjs",
    reason: "开发脚本：把本包同步进本机 CLI 插件缓存，不进入产品运行时。",
  },
  {
    path: "packages/desktop/src/host/remotePromptAttachments.ts",
    reason: "SSH 远端工作区里的路径；远端机器上运行的恒为 ZCode server。",
  },
];

function allowlistEntry(file, snippet) {
  return ALLOWLIST.find(
    (entry) =>
      (entry.path === file || (entry.prefix && file.startsWith(entry.prefix))) &&
      (!entry.snippet || entry.snippet.test(snippet)),
  );
}

test("findGlobalZcodeLiterals 只命中全局根与 .zcode 拼在一起的位置", () => {
  const lines = (source) => findGlobalZcodeLiterals(source).map((finding) => finding.line);

  assert.deepEqual(lines('const a = join(homedir(), ".zcode", "cli");'), [1]);
  // 跨行的同一次调用。
  assert.deepEqual(lines('const a = join(\n  homedir(),\n  ".zcode",\n  "v2",\n);'), [3]);
  // 用户级走 segment、项目级保留字面量；".zcode-beta" 是别的产品目录。
  assert.deepEqual(
    lines(
      'const b = join(homedir(), ZCODE_DATA_DIR_SEGMENT, "cli", ".zcode-beta");\njoin(ws, ".zcode/x")',
    ),
    [],
  );
  // 工作区派生点：合法字面量，即使同一条语句的另一个分支用了 homedir()。
  assert.deepEqual(
    lines(
      'return scope === "project"\n  ? join(deps.workingDirectory, ".zcode", "workflows", name)\n  : join(homedir(), ZCODE_DATA_DIR_SEGMENT, "workflows", name);',
    ),
    [],
  );
  // 上一条语句的 home 取值与这条工作区字面量互不相干。
  assert.deepEqual(lines('const home = homedir();\nconst p = join(base, ".zcode", "skills");'), []);
  // 同一对象里相邻字段的 homedir() 不算这个字面量的根。
  assert.deepEqual(
    lines(
      '{\n  directory: join(homedir(), ZCODE_DATA_DIR_SEGMENT, "cli"),\n  archivePrefix: ".zcode/cli/log",\n}',
    ),
    [],
  );
  // 以 home 为参数的派生点、带路径分隔的写法，以及 "~/…" 形式。
  assert.deepEqual(
    lines('function f(homeDir?: string) {\n  return join(homeDir, ".zcode", "v2", "x.json");\n}'),
    [2],
  );
  assert.deepEqual(lines('const c = join(targetBaseDir, ".zcode/v2/credentials.json");'), [1]);
  assert.deepEqual(lines('const d = "~/.zcode/cli/db/db.sqlite";'), [1]);
  assert.deepEqual(lines('const e = "将删除 ~/.zcode/v2（配置、凭据）";'), [1]);
  // 路径段常量数组：拼接点不在同一行，按数组字面量形态判为全局派生点。
  assert.deepEqual(lines('export const ROOT_SEGMENTS = [".zcode", "worktrees"] as const;'), [1]);
  // 注释里提到的 ".zcode" 不算代码；JSX 文本里的撇号不会带偏后面的行。
  assert.deepEqual(
    lines(
      [
        '// 修复原因：原先写死 ".zcode"。',
        'const f = join(homedir(), ZCODE_DATA_DIR_SEGMENT, "v2");',
        '/* join(homeDir, ".zcode") */',
        "export const A = () => <p>don't</p>;",
        "// 说明：本机 ~/.zcode/AGENTS.md",
        'const url = "https://example.test/a"; // 尾注 ~/.zcode',
      ].join("\n"),
    ),
    [],
  );
});

test("全局数据根派生点全部走 ZCODE_DATA_DIR_SEGMENT（豁免清单之外不允许拼 .zcode）", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...SCAN_ROOTS], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(
      (file) =>
        SOURCE_EXTENSION.test(file) && !EXCLUDED_PATH.test(file) && !EXCLUDED_FILE.test(file),
    );

  const violations = [];
  const allowlistHits = new Map();
  for (const file of tracked) {
    for (const finding of findGlobalZcodeLiterals(readFileSync(resolve(repoRoot, file), "utf8"))) {
      const entry = allowlistEntry(file, finding.snippet);
      if (entry) {
        allowlistHits.set(entry, true);
        continue;
      }
      violations.push(`${file}:${finding.line}  [${finding.root}]  ${finding.snippet}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `以下全局派生点仍在拼 ".zcode"，应改走 ZCODE_DATA_DIR_SEGMENT（工作区路径不受限制）：\n${violations.join("\n")}`,
  );

  for (const entry of ALLOWLIST) {
    assert.ok(
      allowlistHits.has(entry),
      `豁免条目已失效：${entry.path ?? entry.prefix} 下已没有对应的全局 ".zcode" 派生点，请从 ALLOWLIST 删除（${entry.reason}）`,
    );
  }
});
