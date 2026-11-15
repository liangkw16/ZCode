import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type ModelRequest,
  type PermissionBrokerPort,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AskUserQuestion tool", () => {
  it("projects necessary-decision and authorization boundaries through the tool contract", () => {
    const registry = createToolRegistry();
    registry.register(askUserQuestionToolEntry);
    const description = registry.toContracts()[0]?.description;
    expect(description).toContain("Continue independent work");
    expect(description).toContain("Do not turn optional clarification into a mandatory pause");
    expect(description).toContain("do not create user preferences or authorization");
    expect(description).toContain("Do NOT use this tool to ask");
    expect(description).toContain("Do not ask again for decisions already made");
  });

  it("requests interaction even in yolo mode and returns model-friendly answers", async () => {
    const sessionId = createSessionId("ask-user-question");
    const turnId = createTurnId("ask-user-question");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("ask");
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const input = {
      questions: [
        {
          header: "Library",
          question: "Which date library should we use?",
          options: [
            { label: "date-fns", description: "Small functional helpers" },
            { label: "Luxon", description: "Richer timezone model" },
          ],
        },
        {
          header: "Runtime",
          question: "Which runtime should we target?",
          options: [
            { label: "Node", description: "Target Node.js" },
            { label: "Browser", description: "Target browsers" },
          ],
        },
      ],
    };
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        expect(request.toolName).toBe("AskUserQuestion");
        expect(request.sideEffectScope).toBe("userInteraction");
        return {
          decision: "modify",
          reason: "answered",
          modifiedInput: {
            ...request.input,
            answers: {
              "Which date library should we use?": "date-fns",
            },
          },
        };
      },
    };

    registry.register(askUserQuestionToolEntry);
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "yolo",
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input,
        name: "AskUserQuestion",
      },
      { traceContext },
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      answers: {
        "Which date library should we use?": "date-fns",
      },
    });
    expect(result.modelContent).toContain("answered some questions and skipped 1");
    expect(result.modelContent).toContain('"Which date library should we use?"="date-fns"');
    expect(result.modelContent).toContain("do not create user preferences or authorization");
    expect(result.modelContent).toContain("Continue independent work");
    expect(result.modelContent).toContain("keep necessary unanswered decisions unresolved");
    expect(result.modelContent).toContain("reasonable defaults within the existing authorization");
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
  });

  it("returns an empty answer map without resolving necessary decisions or creating authorization", async () => {
    const sessionId = createSessionId("ask-user-question-auto-resolved");
    const turnId = createTurnId("ask-user-question-auto-resolved");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        return {
          decision: "modify",
          reason: "auto_resolved_without_answer",
          modifiedInput: {
            ...(request.input as Record<string, unknown>),
            answers: {},
          },
        };
      },
    };
    registry.register(askUserQuestionToolEntry);
    const executor = createToolExecutor({
      emitEvent: async () => undefined,
      mode: "yolo",
      permissionBroker,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: createToolCallId("ask-auto-resolved"),
        input: {
          questions: [
            {
              header: "Library",
              question: "Which date library should we use?",
              options: [
                { label: "date-fns", description: "Small functional helpers" },
                { label: "Luxon", description: "Richer timezone model" },
              ],
            },
          ],
        },
        name: "AskUserQuestion",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ answers: {} });
    expect(result.modelContent).toContain("The user did not provide answers");
    expect(result.modelContent).not.toContain("response window ended");
    expect(result.modelContent).toContain("do not create user preferences or authorization");
    expect(result.modelContent).toContain("Continue independent work");
    expect(result.modelContent).toContain("keep necessary unanswered decisions unresolved");
    expect(result.modelContent).toContain("explicitly delegated a decision");
  });

  it.each([false, true])(
    "delivers unanswered decisions and missing-task recovery in the next provider request (MCS=%s)",
    async (supportsMidConversationSystem) => {
      const requests: ModelRequest[] = [];
      const registry = createToolRegistry();
      registry.register(askUserQuestionToolEntry);
      registry.register(taskOutputToolEntry);
      const runtime = createTestAgentRuntime(
        createSessionId(`question-task-handoff-${supportsMidConversationSystem}`),
        { mode: "yolo", modelStreaming: false },
        {
          eventStore: createTestSessionEventStore(),
          toolRegistry: registry,
          permissionBroker: {
            async requestPermission(request) {
              return { decision: "modify", modifiedInput: { ...request.input, answers: {} } };
            },
          },
          modelFactory: createTestModelFactory({
            properties: { supportsMidConversationSystem },
            async generateText(request) {
              requests.push(request);
              return {
                text: requests.length === 1 ? "" : "The decision and prior task remain unresolved.",
                finishReason: requests.length === 1 ? "tool-calls" : "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                ...(requests.length === 1
                  ? {
                      toolCalls: [
                        {
                          id: "ask-decision",
                          name: "AskUserQuestion",
                          input: {
                            questions: [
                              {
                                question: "Which deployment target should we use?",
                                header: "Target",
                                options: [
                                  { label: "Staging", description: "Use the staging environment" },
                                  {
                                    label: "Production",
                                    description: "Use the production environment",
                                  },
                                ],
                              },
                            ],
                          },
                        },
                        {
                          id: "check-prior-task",
                          name: "TaskOutput",
                          input: {
                            task_id: "missing-original-task",
                            block: true,
                            timeout: 600_000,
                          },
                        },
                      ],
                    }
                  : {}),
              };
            },
          }),
        },
      );
      await runtime.executeTurn(
        "Confirm the required target and inspect the prior task; do not deploy yet.",
      );
      expect(requests).toHaveLength(2);
      expect(
        requests[0]?.tools?.find((tool) => tool.name === "AskUserQuestion")?.description,
      ).toContain("Do not turn optional clarification into a mandatory pause");
      const followup = JSON.stringify(requests[1]?.messages);
      expect(followup).toContain("keep necessary unanswered decisions unresolved");
      expect(followup).toContain("Continue independent work");
      expect(followup).toContain("No task found with ID: missing-original-task");
      expect(followup).toContain("Increasing timeout cannot repair a wrong ID");
      expect(followup).not.toContain("use your best judgment for the unanswered");
    },
  );
});
