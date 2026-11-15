// 检查上游请求中是否仍有旧版虚拟余额；仅播种升级兼容场景时使用 legacy 常量。
type Block = Record<string, unknown> & { type?: string };
type Message = { role: string; content: unknown };
type RequestShape = { messages: Message[]; system?: unknown };

export const LEGACY_TOTAL_TOKENS_LINE = "<total_tokens>15000000 tokens left</total_tokens>";
const TAG = /<total_tokens>(\d+) tokens left<\/total_tokens>/g;

export interface TotalTokensReminder {
  message: number;
  role: string;
  container: string;
  value: number;
  text: string;
}

/** 消息 content 统一成块数组：字符串视为一个文本块。 */
export function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** 列出 messages 里的每个预算提醒；tool_result 内的块逐个列出。chat completions 的 system 在 messages[0]，不算。 */
export function totalTokensReminders(requestJson: unknown): TotalTokensReminder[] {
  const request = requestJson as RequestShape;
  const skipFirst = request.system === undefined && request.messages[0]?.role === "system";
  return request.messages.flatMap((message, index) => {
    if (skipFirst && index === 0) return [];
    return blocksOf(message.content).flatMap((block) => {
      const container = block.type === "tool_result" ? "tool_result" : message.role;
      const texts =
        block.type === "tool_result"
          ? blocksOf(block.content).map((inner) => String(inner.text ?? ""))
          : [String(block.text ?? "")];
      return texts.flatMap((text) =>
        [...text.matchAll(TAG)].map((match) => ({
          message: index,
          role: message.role,
          container,
          value: Number(match[1]),
          text,
        })),
      );
    });
  });
}
