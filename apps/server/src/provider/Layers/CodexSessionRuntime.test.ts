import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  type CodexThreadItem,
  buildTurnStartParams,
  describeMcpElicitation,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeCodexGoalRequests,
  makeMemoryConsolidationNotificationFilter,
  mergeCollabPromptRecords,
  reconcileHistoricalCollabPromptLinks,
  openCodexThread,
  readCollabPromptLinks,
  readCollabPromptForAgent,
  readCollabPromptLinksFromItems,
  readHistoricalCollabPromptLinks,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("makeCodexGoalRequests", () => {
  it.effect("targets the active provider thread with native Goal methods", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const goal = {
        threadId: "provider-thread-42",
        objective: "Ship Goal controls",
        status: "active" as const,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1_777_000_000,
        updatedAt: 1_777_000_000,
      };
      const client = {
        request: <M extends CodexRpc.ClientRequestMethod>(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          const response = method === "thread/goal/clear" ? { cleared: true } : { goal };
          return Effect.succeed(response as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const requests = makeCodexGoalRequests(client, Effect.succeed("provider-thread-42"));

      yield* requests.setGoal({ objective: "Steer Goal", status: "paused", tokenBudget: 42 });
      yield* requests.clearGoal;

      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/goal/set",
          payload: {
            threadId: "provider-thread-42",
            objective: "Steer Goal",
            status: "paused",
            tokenBudget: 42,
          },
        },
        { method: "thread/goal/clear", payload: { threadId: "provider-thread-42" } },
      ]);
    }),
  );
});

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

describe("readCollabPromptLinks", () => {
  it("keeps first-class prompt data authoritative across later native scans", () => {
    const child = "child-1";
    const native = mergeCollabPromptRecords(
      new Map(),
      [{ receiverThreadId: child, prompt: "Native fallback" }],
      "native",
    );
    const firstClass = mergeCollabPromptRecords(
      native.records,
      [{ receiverThreadId: child, prompt: "  First-class prompt\n" }],
      "first-class",
    );
    const laterNative = mergeCollabPromptRecords(
      firstClass.records,
      [{ receiverThreadId: child, prompt: "Stale native fallback" }],
      "native",
    );

    NodeAssert.deepEqual(laterNative.acceptedLinks, []);
    NodeAssert.deepEqual(laterNative.records.get(child), {
      prompt: "  First-class prompt\n",
      promptId: undefined,
      source: "first-class",
      seenPromptKeys: new Set([
        JSON.stringify([null, "Native fallback"]),
        JSON.stringify([null, "  First-class prompt\n"]),
      ]),
    });
  });

  it("associates the exact native prompt with every receiving child", () => {
    const notification = {
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        completedAtMs: 1,
        item: {
          type: "collabAgentToolCall",
          id: "spawn-1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-1", "child-2"],
          prompt: "Review the exact diff.",
          agentsStates: {},
        },
      },
    } as Parameters<typeof readCollabPromptLinks>[0];

    NodeAssert.deepStrictEqual(readCollabPromptLinks(notification), [
      { receiverThreadId: "child-1", prompt: "Review the exact diff.", promptId: "spawn-1" },
      { receiverThreadId: "child-2", prompt: "Review the exact diff.", promptId: "spawn-1" },
    ]);
  });

  it("recovers launch and follow-up prompts from a resumed thread snapshot", () => {
    const items = [
      {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-1"],
        prompt: "Review the exact diff.",
        agentsStates: {},
      },
      {
        type: "collabAgentToolCall",
        id: "send-1",
        tool: "sendInput",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-1"],
        prompt: "Also inspect the desktop composer.",
        agentsStates: {},
      },
    ] as Parameters<typeof readCollabPromptLinksFromItems>[0];

    NodeAssert.deepStrictEqual(readCollabPromptLinksFromItems(items), [
      { receiverThreadId: "child-1", prompt: "Review the exact diff.", promptId: "spawn-1" },
      {
        receiverThreadId: "child-1",
        prompt: "Also inspect the desktop composer.",
        promptId: "send-1",
      },
    ]);
    NodeAssert.deepStrictEqual(
      readHistoricalCollabPromptLinks({
        turns: [{ items }],
        resumeThreadId: "parent-thread",
        forkThreadId: undefined,
      }),
      [
        { receiverThreadId: "child-1", prompt: "Review the exact diff.", promptId: "spawn-1" },
        {
          receiverThreadId: "child-1",
          prompt: "Also inspect the desktop composer.",
          promptId: "send-1",
        },
      ],
    );
  });

  it("recovers one child's launch prompt from a parent thread snapshot", () => {
    const items = [
      {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-1"],
        prompt: "Inspect the exact mobile behavior.",
        agentsStates: {},
      },
    ] as unknown as ReadonlyArray<CodexThreadItem>;

    NodeAssert.equal(
      readCollabPromptForAgent({
        turns: [{ items }],
        agentThreadId: "child-1",
      }),
      "Inspect the exact mobile behavior.",
    );
    NodeAssert.equal(
      readCollabPromptForAgent({
        turns: [{ items }],
        agentThreadId: "child-2",
      }),
      undefined,
    );
  });

  it("does not import inherited agent prompts into a provider fork", () => {
    const items = [
      {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-1"],
        prompt: "Review the parent thread.",
        agentsStates: {},
      },
    ] as Parameters<typeof readCollabPromptLinksFromItems>[0];

    NodeAssert.deepStrictEqual(
      readHistoricalCollabPromptLinks({
        turns: [{ items }],
        resumeThreadId: undefined,
        forkThreadId: "parent-thread",
      }),
      [],
    );
  });

  it("records later sendInput text as a transcript prompt", () => {
    const notification = {
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        completedAtMs: 2,
        item: {
          type: "collabAgentToolCall",
          id: "send-1",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-1"],
          prompt: "Also inspect the desktop composer.",
          agentsStates: {},
        },
      },
    } as Parameters<typeof readCollabPromptLinks>[0];

    NodeAssert.deepStrictEqual(readCollabPromptLinks(notification), [
      {
        receiverThreadId: "child-1",
        prompt: "Also inspect the desktop composer.",
        promptId: "send-1",
      },
    ]);
  });

  it("retains identical first-class follow-ups with different item ids", () => {
    const first = mergeCollabPromptRecords(
      new Map(),
      [{ receiverThreadId: "child-1", prompt: "Check again.", promptId: "send-1" }],
      "first-class",
    );
    const replay = mergeCollabPromptRecords(
      first.records,
      [{ receiverThreadId: "child-1", prompt: "Check again.", promptId: "send-1" }],
      "first-class",
    );
    const repeated = mergeCollabPromptRecords(
      replay.records,
      [{ receiverThreadId: "child-1", prompt: "Check again.", promptId: "send-2" }],
      "first-class",
    );

    NodeAssert.equal(first.acceptedLinks.length, 1);
    NodeAssert.deepStrictEqual(replay.acceptedLinks, []);
    NodeAssert.deepStrictEqual(repeated.acceptedLinks, [
      { receiverThreadId: "child-1", prompt: "Check again.", promptId: "send-2" },
    ]);
  });

  it("keeps a distinct native launch prompt beside first-class follow-ups", () => {
    NodeAssert.deepStrictEqual(
      reconcileHistoricalCollabPromptLinks(
        [{ receiverThreadId: "child-1", prompt: "Initial review." }],
        [
          {
            receiverThreadId: "child-1",
            prompt: "Follow up.",
            promptId: "send-1",
          },
        ],
      ),
      [
        { receiverThreadId: "child-1", prompt: "Initial review." },
        { receiverThreadId: "child-1", prompt: "Follow up.", promptId: "send-1" },
      ],
    );
  });

  it("keeps encrypted collaboration arguments as prompt linkage", () => {
    const notification = {
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        completedAtMs: 3,
        item: {
          type: "collabAgentToolCall",
          id: "spawn-encrypted",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-1"],
          prompt: `gAAAAA${"x".repeat(90)}`,
          agentsStates: {},
        },
      },
    } as Parameters<typeof readCollabPromptLinks>[0];

    // Ciphertext is the only record that an instruction was sent; clients
    // render it as a placeholder row, never as the parent's words.
    NodeAssert.deepStrictEqual(readCollabPromptLinks(notification), [
      {
        receiverThreadId: "child-1",
        prompt: `gAAAAA${"x".repeat(90)}`,
        promptId: "spawn-encrypted",
      },
    ]);
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: threadId,
      createdAt: 1,
      updatedAt: 1,
      cliVersion: "test",
      cwd: "/tmp/project",
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "cli",
      turns: [],
      status: {
        type: "idle",
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Collaboration Mode: Default/);
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.match(instructions, /^<collaboration_mode># Plan Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, true);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

it("does not redispatch recovered launch and follow-up prompts on every history refresh", () => {
  const links = [
    { receiverThreadId: "child", prompt: "Launch", promptId: "launch" },
    { receiverThreadId: "child", prompt: "Follow up", promptId: "follow-up" },
  ];
  const first = mergeCollabPromptRecords(new Map(), links, "first-class");
  const replay = mergeCollabPromptRecords(first.records, links, "first-class");
  NodeAssert.deepEqual(replay.acceptedLinks, []);
  NodeAssert.equal(replay.records.get("child")?.promptId, "follow-up");
  const next = mergeCollabPromptRecords(
    replay.records,
    [{ ...links[0]!, promptId: "new-dispatch" }],
    "first-class",
  );
  NodeAssert.equal(next.acceptedLinks.length, 1);
});

it.effect("resumes the same provider thread without requesting unsupported turn history", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const response = makeThreadOpenResponse("provider-root");
    const opened = yield* openCodexThread({
      client: {
        request: () => Effect.die("resume must use the transport that preserves excludeTurns"),
        raw: {
          request: (method, payload) => {
            calls.push({ method, payload });
            return Effect.succeed(response);
          },
        },
      },
      threadId: ThreadId.make("t3-thread"),
      runtimeMode: "full-access",
      cwd: "/tmp/project",
      requestedModel: undefined,
      serviceTier: undefined,
      resumeThreadId: "provider-root",
    });
    NodeAssert.equal(opened.thread.id, "provider-root");
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0]?.method, "thread/resume");
    NodeAssert.equal((calls[0]!.payload as { excludeTurns: boolean }).excludeTurns, true);
  }),
);
describe("openCodexThread", () => {
  it.effect("creates a durable provider fork for a side chat", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const forked = makeThreadOpenResponse("forked-thread");
      const client = {
        request: (method: string, payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(forked);
        },
      };

      const opened = yield* openCodexThread({
        client: { ...client, raw: client },
        threadId: ThreadId.make("side-thread"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        forkThreadId: "parent-provider-thread",
      });

      NodeAssert.equal(opened.thread.id, "forked-thread");
      NodeAssert.equal(calls[0]?.method, "thread/fork");
      NodeAssert.deepStrictEqual(calls[0]?.payload, {
        cwd: "/tmp/project",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        model: "gpt-5.3-codex",
        threadId: "parent-provider-thread",
        ephemeral: false,
        excludeTurns: true,
      });
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: (method: string, payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started);
        },
      };

      const opened = yield* openCodexThread({
        client: { ...client, raw: client },
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: (method: string, _payload: unknown) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      };

      const error = yield* openCodexThread({
        client: { ...client, raw: client },
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
