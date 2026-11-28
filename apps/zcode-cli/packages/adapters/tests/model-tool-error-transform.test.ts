import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { ModelInputMessage } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "../src/model/index.js";

describe("AI SDK model tool result error transform", () => {
  it("maps provider-neutral failed tool results to AI SDK error output", () => {
    const toolCallId = "call_failed_tool";
    const messages = toAiSdkMessages([
      {
        role: "tool",
        content: "Command was aborted before completion",
        isError: true,
        toolCallId,
        toolName: "Bash",
      },
    ]);

    expect((messages[0] as any).content[0]).toEqual({
      type: "tool-result",
      toolCallId,
      toolName: "Bash",
      output: {
        type: "error-text",
        value: "Command was aborted before completion",
      },
    });
  });

  it("keeps reminders folded into a failed tool result in the error text", () => {
    // core 把提醒以空行接在失败结果的字符串后面；error-text 必须原样带上，不能只留错误本身。
    const folded = "command failed\n\n<system-reminder>\nTODO_AFTER_ERROR\n</system-reminder>";
    const messages = toAiSdkMessages([
      {
        role: "tool",
        content: folded,
        isError: true,
        toolCallId: "call_folded_error",
        toolName: "Bash",
      },
    ]);

    expect((messages[0] as any).content[0].output).toEqual({ type: "error-text", value: folded });
  });

  describe.each(["anthropic", "openai", "openai-compatible"] as const)(
    "%s Unicode",
    (providerKind) => {
      it.each([
        { structured: false, isError: false },
        { structured: true, isError: false },
        { structured: false, isError: true },
        { structured: true, isError: true },
      ])("repairs tool text without rewriting history: %j", ({ structured, isError }) => {
        const original = "完整 emoji 🌍；截断高位 \ud83c…；孤立低位 \udf0d";
        const expected = "完整 emoji 🌍；截断高位 �…；孤立低位 �";
        const history: ModelInputMessage[] = [
          {
            role: "tool",
            content: structured ? [{ type: "text", text: original }] : original,
            isError,
            toolCallId: "call_unicode",
            toolName: "mcp__node_repl__js",
          },
        ];
        const before = structuredClone(history);
        const messages = toAiSdkMessages(history, { providerKind });
        const output = (messages[0] as any).content[0].output;

        expect(output).toEqual(
          isError
            ? { type: "error-text", value: expected }
            : structured && providerKind !== "openai-compatible"
              ? { type: "content", value: [{ type: "text", text: expected }] }
              : { type: "text", value: expected },
        );
        expect(history).toEqual(before);
      });
    },
  );

  it("resends old tool history with UTF-8 encodable Anthropic wire text", async () => {
    const toolCallId = "call_old_ax";
    const original = "You can even use emoji. \ud83c… 🌍";
    const history: ModelInputMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: toolCallId, input: {}, name: "mcp__node_repl__js" }],
      },
      { role: "tool", content: original, toolCallId, toolName: "mcp__node_repl__js" },
    ];
    const wireTexts: string[] = [];
    const provider = createAnthropic({
      apiKey: "fake-key",
      baseURL: "https://api.example.test",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const text = body.messages[1].content[0].content as string;
        wireTexts.push(text);
        return new Response(
          JSON.stringify(
            text.isWellFormed()
              ? {
                  id: "msg_unicode",
                  type: "message",
                  role: "assistant",
                  model: "anthropic-model",
                  content: [{ type: "text", text: "Recovered" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                }
              : { error: { type: "api_error", message: "surrogates not allowed" } },
          ),
          {
            status: text.isWellFormed() ? 200 : 500,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await generateText({
        messages: toAiSdkMessages(history),
        model: provider("anthropic-model"),
        maxRetries: 0,
      });
      expect(result.text).toBe("Recovered");
    }
    expect(wireTexts).toEqual(["You can even use emoji. �… 🌍", "You can even use emoji. �… 🌍"]);
    expect(history[1]!.content).toBe(original);
  });

  it("serializes failed tool results as Anthropic is_error tool_result blocks", async () => {
    let requestBody: any;
    const provider = createAnthropic({
      apiKey: "fake-key",
      baseURL: "https://api.example.test",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ error: { message: "wire capture", type: "invalid_request_error" } }),
          {
            headers: { "content-type": "application/json" },
            status: 400,
          },
        );
      },
    });
    const toolCallId = "call_malformed_ask";
    const validationContent = [
      "<tool_use_error>InputValidationError: AskUserQuestion failed due to the following issue:",
      "The required parameter `questions` is missing</tool_use_error>",
    ].join("\n");
    const messages = toAiSdkMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            input: {},
            name: "AskUserQuestion",
          },
        ],
      },
      {
        role: "tool",
        content: validationContent,
        isError: true,
        toolCallId,
        toolName: "AskUserQuestion",
      },
    ]);

    await expect(
      generateText({
        messages,
        model: provider("anthropic-model"),
      }),
    ).rejects.toBeDefined();

    expect(requestBody.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            id: toolCallId,
            input: {},
            name: "AskUserQuestion",
            type: "tool_use",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            content: validationContent,
            is_error: true,
            tool_use_id: toolCallId,
            type: "tool_result",
          },
        ],
      },
    ]);
  });
});
