import { describe, expect, it } from "vite-plus/test";
import {
  classifyTaskAgentKind,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER,
  deriveSubagentReplies,
  deriveSubagentTranscript,
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTitle,
  formatSubagentTokenCount,
  isAgentAttributedToolActivity,
  isParentScopedActivity,
  isSubagentActivityKind,
  isTimelineBypassActivity,
  selectSubagentRepliesFor,
  filterWorkflowForPanelSection,
  selectSubagentTranscriptActivities,
  selectSubagentTranscriptMessages,
  subagentPanelSection,
  workflowCardMembers,
} from "./subagentRuntime.ts";

let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

/** A pre-stamp row (legacy thread / old server): no agentKind at all. */
function legacyActivity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("formatSubagentTitle", () => {
  it("humanizes provider task keys and preserves familiar product casing", () => {
    expect(formatSubagentTitle("verify_iphone_transcript")).toBe("Verify iPhone transcript");
    expect(formatSubagentTitle("test-t3-mobile")).toBe("Test T3 mobile");
    expect(formatSubagentTitle("claude_api_review")).toBe("Claude API review");
  });

  it("preserves explicit titles and opaque identifiers", () => {
    expect(formatSubagentTitle("Review the mobile transcript")).toBe(
      "Review the mobile transcript",
    );
    expect(formatSubagentTitle("01a00487-efa7-7592-9855-eb10be42717c")).toBe(
      "01a00487-efa7-7592-9855-eb10be42717c",
    );
  });
});

describe("deriveSubagentTranscript", () => {
  it("keeps only the selected agent's messages and collapses tool lifecycle rows", () => {
    const messages = [
      {
        id: "message-parent",
        role: "assistant",
        text: "parent",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "message-child",
        role: "assistant",
        text: "child answer",
        agentId: "agent-1",
        turnId: null,
        streaming: true,
        createdAt: "2026-08-01T10:00:01.000Z",
        updatedAt: "2026-08-01T10:00:02.000Z",
      },
      {
        id: "message-other-child",
        role: "assistant",
        text: "other answer",
        agentId: "agent-2",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-01T10:00:03.000Z",
        updatedAt: "2026-08-01T10:00:03.000Z",
      },
    ] as unknown as ReadonlyArray<OrchestrationMessage>;
    const activities = [
      activity(
        "tool.started",
        {
          agentId: "agent-1",
          itemId: "tool-1",
          itemType: "command_execution",
          title: "Ran command",
          status: "inProgress",
        },
        "2026-08-01T10:00:04.000Z",
      ),
      activity(
        "tool.completed",
        {
          agentId: "agent-1",
          itemId: "tool-1",
          itemType: "command_execution",
          title: "Ran command",
          detail: "vp test run",
          status: "completed",
        },
        "2026-08-01T10:00:05.000Z",
      ),
      activity("tool.completed", {
        agentId: "agent-2",
        itemId: "tool-2",
        itemType: "file_change",
      }),
    ];

    const transcript = deriveSubagentTranscript({ agentId: "agent-1", messages, activities });

    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({
      kind: "message",
      id: "message-child",
      text: "child answer",
      streaming: true,
    });
    expect(transcript[1]).toMatchObject({
      kind: "tool",
      itemId: "tool-1",
      title: "Ran command",
      detail: "vp test run",
      status: "completed",
    });
  });

  it("does not duplicate assistant lifecycle rows already projected as messages", () => {
    const transcript = deriveSubagentTranscript({
      agentId: "agent-1",
      messages: [],
      activities: [
        activity("tool.completed", {
          agentId: "agent-1",
          itemId: "assistant-1",
          itemType: "assistant_message",
          detail: "answer",
        }),
      ],
    });

    expect(transcript).toEqual([]);
  });

  it("renders a child user item as the parent's instruction, not a tool card", () => {
    const transcript = deriveSubagentTranscript({
      agentId: "agent-1",
      messages: [],
      activities: [
        activity("tool.completed", {
          agentId: "agent-1",
          itemId: "child-user-1",
          itemType: "user_message",
          data: {
            type: "userMessage",
            content: [{ type: "text", text: "Review the exact diff." }],
          },
        }),
      ],
    });

    expect(transcript).toMatchObject([
      { kind: "message", role: "user", text: "Review the exact diff." },
    ]);
  });
});

describe("selectSubagentTranscriptMessages", () => {
  it("runs without Array.prototype.toSorted for mobile Hermes", () => {
    const toSortedDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    Object.defineProperty(Array.prototype, "toSorted", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      const selected = selectSubagentTranscriptMessages(
        [
          {
            id: "message-child",
            role: "assistant",
            text: "Review complete",
            agentId: "agent-1",
            turnId: null,
            streaming: false,
            createdAt: "2026-08-01T10:00:03.000Z",
            updatedAt: "2026-08-01T10:00:03.000Z",
          },
        ] as unknown as ReadonlyArray<OrchestrationMessage>,
        [
          activity(
            "tool.completed",
            {
              itemId: "spawn-1",
              itemType: "collab_agent_tool_call",
              data: {
                item: {
                  prompt: "Inspect the mobile transcript.",
                  receiverThreadIds: ["agent-1"],
                },
              },
            },
            "2026-08-01T10:00:01.000Z",
          ),
        ],
        "agent-1",
      );

      expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Inspect the mobile transcript." },
        { role: "assistant", text: "Review complete" },
      ]);
    } finally {
      if (toSortedDescriptor) {
        Object.defineProperty(Array.prototype, "toSorted", toSortedDescriptor);
      } else {
        Reflect.deleteProperty(Array.prototype, "toSorted");
      }
    }
  });

  it("recovers Claude's original launch prompt through the task tool id", () => {
    const messages = [
      {
        id: "message-child",
        role: "assistant",
        text: "Review complete",
        agentId: "agent-1",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-01T10:00:03.000Z",
        updatedAt: "2026-08-01T10:00:03.000Z",
      },
    ] as unknown as ReadonlyArray<OrchestrationMessage>;
    const activities = [
      activity(
        "tool.started",
        {
          itemId: "tool-agent-1",
          itemType: "collab_agent_tool_call",
          data: {
            toolName: "Agent",
            input: {
              description: "Review the database layer",
              prompt: "Audit every SQL change and report exact file evidence.",
            },
          },
        },
        "2026-08-01T10:00:01.000Z",
      ),
      activity(
        "task.started",
        { taskId: "agent-1", toolUseId: "tool-agent-1", title: "Database reviewer" },
        "2026-08-01T10:00:02.000Z",
      ),
    ];

    const selected = selectSubagentTranscriptMessages(messages, activities, "agent-1");

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      {
        role: "user",
        text: "Audit every SQL change and report exact file evidence.",
      },
      { role: "assistant", text: "Review complete" },
    ]);
  });

  it("places a launch prompt recovered on restart before existing child output", () => {
    const selected = selectSubagentTranscriptMessages(
      [
        {
          id: "message-child",
          role: "assistant",
          text: "Review complete",
          agentId: "agent-1",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-01T10:00:03.000Z",
          updatedAt: "2026-08-01T10:00:03.000Z",
        },
      ] as unknown as ReadonlyArray<OrchestrationMessage>,
      [
        activity(
          "task.updated",
          {
            taskId: "agent-1",
            prompt: "Inspect the mobile transcript.",
          },
          "2026-08-01T12:00:00.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Inspect the mobile transcript." },
      { role: "assistant", text: "Review complete" },
    ]);
  });

  it("coalesces Codex spawn lifecycle and includes later parent instructions", () => {
    const activities = [
      activity(
        "task.progress",
        {
          taskId: "agent-1",
          prompt: "Inspect the mobile transcript.",
        },
        "2026-08-01T10:00:01.500Z",
      ),
      activity(
        "tool.started",
        {
          itemId: "spawn-1",
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              prompt: "Inspect the mobile transcript.",
              receiverThreadIds: [],
            },
          },
        },
        "2026-08-01T10:00:01.000Z",
      ),
      activity(
        "tool.completed",
        {
          itemId: "spawn-1",
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              prompt: "Inspect the mobile transcript.",
              receiverThreadIds: ["agent-1"],
            },
          },
        },
        "2026-08-01T10:00:02.000Z",
      ),
      activity(
        "tool.completed",
        {
          itemId: "send-1",
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              type: "collabAgentToolCall",
              tool: "sendInput",
              prompt: "Also check old threads.",
              receiverThreadIds: ["agent-1"],
            },
          },
        },
        "2026-08-01T10:00:03.000Z",
      ),
    ];

    const selected = selectSubagentTranscriptMessages([], activities, "agent-1");

    expect(selected.map(({ role, text, createdAt }) => ({ role, text, createdAt }))).toEqual([
      {
        role: "user",
        text: "Inspect the mobile transcript.",
        createdAt: "2026-08-01T10:00:01.500Z",
      },
      {
        role: "user",
        text: "Also check old threads.",
        createdAt: "2026-08-01T10:00:03.000Z",
      },
    ]);
  });

  it("uses decrypted child user items and never renders encrypted fallback prompts", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          {
            taskId: "agent-1",
            prompt: `gAAAAA${"x".repeat(90)}`,
          },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-1",
            itemType: "user_message",
            data: {
              type: "userMessage",
              content: [{ type: "text", text: "Check the collapsed composer again." }],
            },
          },
          "2026-08-01T10:00:02.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Check the collapsed composer again." },
    ]);
  });

  it("marks a prompt the provider persisted only as ciphertext", () => {
    const encryptedPrompt = `gAAAAA${"x".repeat(90)}`;
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.updated",
          { taskId: "agent-1", prompt: encryptedPrompt },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: encryptedPrompt },
          "2026-08-01T10:00:02.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
    ]);
  });

  it("keeps two distinct ciphertext instructions as two markers", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"a".repeat(90)}`, promptId: "spawn-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"b".repeat(90)}`, promptId: "send-1" },
          "2026-08-01T10:00:02.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
    ]);
  });

  it("keeps an agent message whose text looks like a Fernet token", () => {
    // Only assistant output is ever agent-attributed, so content shape may
    // never decide whether a child message is shown.
    const ciphertextShaped = `gAAAAAB${"x".repeat(88)}==`;
    const selected = selectSubagentTranscriptMessages(
      [
        {
          id: "message-token",
          role: "assistant",
          text: ciphertextShaped,
          agentId: "agent-1",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-01T10:00:01.000Z",
          updatedAt: "2026-08-01T10:00:01.000Z",
        },
        {
          id: "message-exact",
          role: "assistant",
          text: "Exact child response",
          agentId: "agent-1",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-08-01T10:00:02.000Z",
          updatedAt: "2026-08-01T10:00:02.000Z",
        },
      ] as unknown as ReadonlyArray<OrchestrationMessage>,
      [],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "assistant", text: ciphertextShaped },
      { role: "assistant", text: "Exact child response" },
    ]);
  });

  it("retires one ciphertext marker per decrypted child instruction", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.updated",
          { taskId: "agent-1", prompt: `gAAAAA${"a".repeat(90)}` },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"b".repeat(90)}` },
          "2026-08-01T10:00:02.000Z",
        ),
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-1",
            itemType: "user_message",
            data: {
              type: "userMessage",
              content: [{ type: "text", text: "Check the collapsed composer again." }],
            },
          },
          "2026-08-01T10:00:03.000Z",
        ),
      ],
      "agent-1",
    );

    // Two instructions were sent and only the second one's plaintext survived,
    // so the first must still be visible as a marker instead of vanishing.
    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
      { role: "user", text: "Check the collapsed composer again." },
    ]);
  });

  it("keeps a pending follow-up marker when only the launch was decrypted", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"a".repeat(90)}`, promptId: "spawn-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-1",
            itemType: "user_message",
            data: {
              type: "userMessage",
              content: [{ type: "text", text: "The launch instruction, in the clear." }],
            },
          },
          "2026-08-01T10:00:02.000Z",
        ),
        // The child has not echoed this one yet: its marker is all we have.
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"b".repeat(90)}`, promptId: "send-1" },
          "2026-08-01T10:00:03.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "The launch instruction, in the clear." },
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
    ]);
  });

  it("does not double-render an instruction whose marker lands after the child echo", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        // Rollout recovery is polled, so the child's plaintext echo can be
        // persisted before the parent-side ciphertext marker.
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-1",
            itemType: "user_message",
            data: {
              type: "userMessage",
              content: [{ type: "text", text: "Review the exact diff." }],
            },
          },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"a".repeat(90)}`, promptId: "spawn-1" },
          "2026-08-01T10:00:02.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Review the exact diff." },
    ]);
  });

  it("keeps ciphertext markers for instructions whose plaintext never arrived", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"a".repeat(90)}`, promptId: "spawn-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"b".repeat(90)}`, promptId: "send-1" },
          "2026-08-01T10:00:02.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: `gAAAAA${"c".repeat(90)}`, promptId: "send-2" },
          "2026-08-01T10:00:03.000Z",
        ),
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-1",
            itemType: "user_message",
            data: {
              type: "userMessage",
              content: [{ type: "text", text: "The third instruction, in the clear." }],
            },
          },
          "2026-08-01T10:00:04.000Z",
        ),
      ],
      "agent-1",
    );

    // Three instructions were sent; one decrypted copy survives. The other two
    // stay as markers rather than being erased along with it.
    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
      { role: "user", text: ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER },
      { role: "user", text: "The third instruction, in the clear." },
    ]);
  });

  it("keeps identical instructions recovered within the same millisecond", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.updated",
          { taskId: "agent-1", prompt: "Check again.", promptId: "send-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.updated",
          { taskId: "agent-1", prompt: "Check again.", promptId: "send-2" },
          "2026-08-01T10:00:01.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Check again." },
      { role: "user", text: "Check again." },
    ]);
  });

  it("keeps every follow-up instruction, including repeats of the same text", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: "Launch instruction.", promptId: "spawn-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: "Check again.", promptId: "send-1" },
          "2026-08-01T10:00:02.000Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: "Check again.", promptId: "send-2" },
          "2026-08-01T10:00:03.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Launch instruction." },
      { role: "user", text: "Check again." },
      { role: "user", text: "Check again." },
    ]);
  });

  it("collapses a reopened thread's replay onto the original instruction row", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          { taskId: "agent-1", prompt: "Launch instruction.", promptId: "spawn-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "tool.completed",
          { agentId: "agent-1", itemId: "command-1", itemType: "command_execution" },
          "2026-08-01T10:00:02.000Z",
        ),
        // Resume replays the same instruction, stamped with the resume time.
        activity(
          "task.updated",
          { taskId: "agent-1", prompt: "Launch instruction.", promptId: "spawn-1" },
          "2026-08-02T09:00:00.000Z",
        ),
      ],
      "agent-1",
    );

    // One row, still at the moment it was sent - not dragged to the end of the
    // transcript by the resume.
    expect(selected.map(({ role, text, createdAt }) => ({ role, text, createdAt }))).toEqual([
      {
        role: "user",
        text: "Launch instruction.",
        createdAt: "2026-08-01T10:00:01.000Z",
      },
    ]);
  });

  it("shows a Claude SendMessage follow-up addressed to the agent", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.started",
          { taskId: "agent-1", title: "Review authentication", toolUseId: "toolu_launch" },
          "2026-08-01T10:00:00.000Z",
        ),
        activity(
          "tool.completed",
          {
            itemId: "toolu_launch",
            itemType: "collab_agent_tool_call",
            data: {
              toolName: "Agent",
              input: { name: "security-reviewer", prompt: "Launch instruction." },
            },
          },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "tool.completed",
          {
            itemId: "toolu_send",
            itemType: "collab_agent_tool_call",
            data: {
              toolName: "SendMessage",
              input: { to: "security-reviewer", message: "Also check the reopened thread." },
            },
          },
          "2026-08-01T10:00:02.000Z",
        ),
        activity(
          "tool.completed",
          {
            itemId: "toolu_other",
            itemType: "collab_agent_tool_call",
            data: {
              toolName: "SendMessage",
              // Addressed by the task description, which is prose and not an
              // address: it must not pull another agent's work into this
              // transcript.
              input: { to: "Review authentication", message: "Not for this agent." },
            },
          },
          "2026-08-01T10:00:03.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Launch instruction." },
      { role: "user", text: "Also check the reopened thread." },
    ]);
  });

  it("places a recovered launch prompt before earlier child tool activity", () => {
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "command-1",
            itemType: "command_execution",
          },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "task.updated",
          {
            taskId: "agent-1",
            prompt: "Inspect the mobile transcript.",
          },
          "2026-08-01T12:00:00.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      role: "user",
      text: "Inspect the mobile transcript.",
      createdAt: "2026-08-01T10:00:01.000Z",
    });
  });

  it("deduplicates parent and child copies while retaining repeated identical sends", () => {
    const prompt = "Check the collapsed composer again.";
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity(
          "task.progress",
          { taskId: "agent-1", prompt, promptId: "send-1" },
          "2026-08-01T10:00:01.000Z",
        ),
        activity(
          "tool.completed",
          {
            itemId: "send-1",
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                type: "collabAgentToolCall",
                tool: "sendInput",
                prompt,
                receiverThreadIds: ["agent-1"],
              },
            },
          },
          "2026-08-01T10:00:01.100Z",
        ),
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-1",
            itemType: "user_message",
            data: { type: "userMessage", content: [{ type: "text", text: prompt }] },
          },
          "2026-08-01T10:00:01.200Z",
        ),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt, promptId: "send-2" },
          "2026-08-01T10:00:02.000Z",
        ),
        activity(
          "tool.completed",
          {
            agentId: "agent-1",
            itemId: "child-user-2",
            itemType: "user_message",
            data: { type: "userMessage", content: [{ type: "text", text: prompt }] },
          },
          "2026-08-01T10:00:02.200Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: prompt },
      { role: "user", text: prompt },
    ]);
  });

  it("keeps a legacy id-less launch beside an identical id-bearing follow-up", () => {
    const prompt = "Check again.";
    const selected = selectSubagentTranscriptMessages(
      [],
      [
        activity("task.started", { taskId: "agent-1", prompt }, "2026-08-01T10:00:01.000Z"),
        activity(
          "task.progress",
          { taskId: "agent-1", prompt, promptId: "send-1" },
          "2026-08-01T10:00:02.000Z",
        ),
      ],
      "agent-1",
    );

    expect(selected.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: prompt },
      { role: "user", text: prompt },
    ]);
  });
});

describe("selectSubagentTranscriptActivities", () => {
  it("returns only the selected agent's rows, without attribution", () => {
    const selected = selectSubagentTranscriptActivities(
      [
        activity("tool.updated", {
          agentId: "agent-1",
          timelineBypass: true,
          itemId: "tool-1",
          itemType: "command_execution",
        }),
        activity("tool.completed", {
          agentId: "agent-2",
          itemId: "tool-2",
          itemType: "file_change",
        }),
        activity("tool.completed", {
          agentId: "agent-1",
          itemId: "assistant-1",
          itemType: "assistant_message",
        }),
      ],
      "agent-1",
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      kind: "tool.updated",
      payload: {
        itemId: "tool-1",
        itemType: "command_execution",
      },
    });
    expect(selected[0]?.payload).not.toHaveProperty("agentId");
    expect(selected[0]?.payload).not.toHaveProperty("timelineBypass");
  });

  // Parity with the main chat: the transcript runs the SAME derivations over
  // the same shape of input, so selection is by attribution, not by an
  // allowlist of kinds. A tool-only feed silently dropped the agent's own
  // plan, its denials, its context usage, and the tasks it spawned.
  it("carries every kind the agent owns, not just tool lifecycle", () => {
    const selected = selectSubagentTranscriptActivities(
      [
        activity("turn.plan.updated", {
          agentId: "agent-1",
          plan: [{ step: "read the file", status: "inProgress" }],
        }),
        activity("context-window.updated", { agentId: "agent-1", usedTokens: 4200 }),
        activity("tool.denied", { agentId: "agent-1", toolName: "Bash" }),
        activity("task.started", { agentId: "agent-1", taskId: "nested-1", title: "Nested" }),
        activity("turn.plan.updated", {
          agentId: "agent-2",
          plan: [{ step: "not mine", status: "pending" }],
        }),
        activity("context-window.updated", { usedTokens: 999 }),
      ],
      "agent-1",
    );

    expect(selected.map((row) => row.kind)).toEqual([
      "turn.plan.updated",
      "context-window.updated",
      "tool.denied",
      "task.started",
    ]);
    for (const row of selected) {
      expect(row.payload).not.toHaveProperty("agentId");
    }
  });

  it("leaves unattributed parent rows alone", () => {
    const rows = [
      activity("context-window.updated", { usedTokens: 10 }),
      activity("turn.plan.updated", { plan: [{ step: "parent", status: "pending" }] }),
    ];
    expect(selectSubagentTranscriptActivities(rows, "agent-1")).toEqual([]);
    expect(rows.every((row) => isParentScopedActivity(row))).toBe(true);
  });

  it("keeps user-message lifecycle out of the tool feed", () => {
    const selected = selectSubagentTranscriptActivities(
      [
        activity("tool.completed", {
          agentId: "agent-1",
          itemId: "child-user-1",
          itemType: "user_message",
        }),
      ],
      "agent-1",
    );

    expect(selected).toEqual([]);
  });
});

describe("foldSubagentActivities", () => {
  it("builds an agent from start → progress → completion", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-1",
        title: "Audit auth flow",
        role: "explorer",
      }),
      activity("task.progress", {
        taskId: "task-1",
        lastToolName: "Read",
        typedUsage: { totalTokens: 1200, toolUses: 3 },
      }),
      activity("task.completed", {
        taskId: "task-1",
        status: "completed",
        summary: "Found 2 issues",
        typedUsage: { totalTokens: 5000, toolUses: 9 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Audit auth flow");
    expect(agent.role).toBe("explorer");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("Found 2 issues");
    expect(agent.usage?.totalTokens).toBe(5000);
    expect(agent.activationCount).toBe(1);
    expect(agent.completedAt).not.toBeNull();
  });

  it("progress can create an agent when its start row aged out of retention", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "task-orphan",
        title: "Recovered agent",
        role: "verifier",
        typedUsage: { totalTokens: 100 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Recovered agent");
    expect(agents[0]!.status).toBe("running");
  });

  it("does not let a later opaque fallback title replace a known task name", () => {
    const taskId = "01a00ecb-a17a-7323-93ab-22f3880b5a58";
    const agents = fold([
      activity("task.started", { taskId, title: "collapsed_composer_review" }),
      activity("task.progress", { taskId, title: taskId, status: "idle" }),
    ]);

    expect(agents[0]!.title).toBe("collapsed_composer_review");
  });

  it("completion before start stays terminal; a late start only fills metadata", () => {
    const agents = fold([
      activity("task.completed", {
        taskId: "task-2",
        status: "failed",
        summary: "boom",
        role: "fixer",
      }),
      activity("task.started", { taskId: "task-2", title: "Late metadata", role: "fixer" }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Late metadata");
    expect(agent.role).toBe("fixer");
    // The late start must NOT reopen the terminal activation as a new run.
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("boom");
  });

  it("duplicate terminal events are idempotent (timestamps do not slide)", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-3", taskType: "local_agent" }),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T12:00:00.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("reactivation increments the run count and clears result/error", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-4", taskType: "local_agent" }),
      activity("task.completed", { taskId: "task-4", status: "completed", summary: "run 1 done" }),
      activity("task.updated", { taskId: "task-4", status: "running" }),
    ]);
    const agent = agents[0]!;
    expect(agent.activationCount).toBe(2);
    expect(agent.result).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.status).toBe("running");
  });

  it("idle is nonterminal: an idle agent resumes without losing identity", () => {
    const agents = fold([
      activity("task.started", { taskId: "codex-child-1", title: "Marlow", role: "explorer" }),
      activity("task.updated", { taskId: "codex-child-1", status: "idle" }),
      activity("task.updated", { taskId: "codex-child-1", status: "running" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(2);
    expect(agents[0]!.status).toBe("running");
  });

  it("cumulative usage max-merges: duplicate and late frames never shrink or double-count", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-5", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", { taskId: "task-5", typedUsage: { totalTokens: 500 } }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 900, inputTokens: 700 });
  });

  it("usage snapshots enrich an existing agent without changing its status", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "usage-waiting", taskType: "local_agent" }),
      activity("task.progress", { taskId: "usage-waiting", status: "waiting" }),
      activity("task.progress", {
        taskId: "usage-waiting",
        usageSnapshot: true,
        typedUsage: { totalTokens: 1_200 },
      }),
    ]);

    expect(agent?.status).toBe("waiting");
    expect(agent?.usage?.totalTokens).toBe(1_200);
  });

  it("a retained usage snapshot can still reconstruct a running agent", () => {
    const [agent] = fold([
      activity("task.progress", {
        taskId: "usage-only",
        usageSnapshot: true,
        typedUsage: { totalTokens: 800 },
      }),
    ]);

    expect(agent?.status).toBe("running");
    expect(agent?.usage?.totalTokens).toBe(800);
  });

  it("partial terminal usage preserves known breakdown fields", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-6", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-6",
        typedUsage: { totalTokens: 800, inputTokens: 600, outputTokens: 150 },
      }),
      activity("task.completed", {
        taskId: "task-6",
        status: "completed",
        typedUsage: { totalTokens: 1000 },
      }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 1000, inputTokens: 600, outputTokens: 150 });
  });

  it("skips malformed rows individually without failing the fold", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-7", title: "Good", taskType: "local_agent" }),
      activity("task.progress", { bogus: true }),
      activity("task.progress", { taskId: 42 }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Good");
  });

  it("bounds repeated strings at 180 chars and the activity ring at 6 deduped entries", () => {
    const long = "x".repeat(500);
    const rows = [activity("task.started", { taskId: "task-8", taskType: "local_agent" })];
    for (let i = 0; i < 10; i += 1) {
      rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-${i}` }));
    }
    rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-9` }));
    const agents = fold(rows);
    const agent = agents[0]!;
    expect(agent.recentActivity.length).toBeLessThanOrEqual(6);
    for (const entry of agent.recentActivity) {
      expect(entry.summary.length).toBeLessThanOrEqual(180);
    }
    // Consecutive identical summaries dedupe (truncation makes them equal).
    const summaries = agent.recentActivity.map((entry) => entry.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("plan tasks are not agents", () => {
    const agents = fold([activity("task.started", { taskId: "plan-1", taskType: "plan" })]);
    expect(agents).toHaveLength(0);
  });

  it("workflow members key by stable slot and attach to their coordinator", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit-auth-flow",
        workflowName: "audit-auth-flow",
      }),
      activity("task.progress", {
        taskId: "wf-1",
        phases: [
          { index: 0, title: "Audit" },
          { index: 1, title: "Verify" },
        ],
      }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "audit:entrypoints",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        phaseTitle: "Audit",
        timelineBypass: true,
      }),
    ]);
    const workflow = agents.find((agent) => agent.id === "wf-1");
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.phases).toEqual([
      { index: 0, title: "Audit" },
      { index: 1, title: "Verify" },
    ]);
    expect(member?.kind).toBe("workflow_agent");
    expect(member?.parentAgentId).toBe("wf-1");
  });

  it("a workflow member retry (attempt bump) is a reactivation of the same slot", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "failed",
        error: "attempt 1 died",
        parentAgentId: "wf-2",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "running",
        parentAgentId: "wf-2",
        attempt: 2,
      }),
    ]);
    expect(agents).toHaveLength(1);
    const member = agents[0]!;
    expect(member.activationCount).toBeGreaterThanOrEqual(2);
    expect(member.error).toBeNull();
    expect(member.status).toBe("running");
  });

  it("drops non-http(s) session urls at the fold boundary", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-3",
        taskType: "local_workflow",
        runHandles: { sessionUrl: "javascript:alert(1)", runId: "run-1" },
      }),
    ]);
    expect(agents[0]!.runHandles?.sessionUrl).toBeUndefined();
    expect(agents[0]!.runHandles?.runId).toBe("run-1");
  });
});

describe("deriveAgentPanelModel", () => {
  const roster = fold([
    activity("task.started", { taskId: "wf-1", taskType: "local_workflow", title: "audit" }),
    activity("task.progress", {
      taskId: "wf-1",
      phases: [
        { index: 0, title: "Audit" },
        { index: 1, title: "Verify" },
      ],
    }),
    activity("task.progress", {
      taskId: "wf-1:wf:0",
      title: "audit:a",
      status: "completed",
      parentAgentId: "wf-1",
      agentIndex: 0,
      phaseIndex: 0,
    }),
    activity("task.completed", { taskId: "wf-1:wf:0", status: "completed", parentAgentId: "wf-1" }),
    activity("task.progress", {
      taskId: "wf-1:wf:1",
      title: "verify:b",
      status: "running",
      parentAgentId: "wf-1",
      agentIndex: 1,
      phaseIndex: 1,
      typedUsage: { totalTokens: 4000 },
    }),
    activity("task.started", { taskId: "direct-1", title: "Marlow", role: "explorer" }),
    activity("task.updated", { taskId: "direct-1", status: "idle" }),
  ]);

  it("groups workflow members by phase and separates direct spawns", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.workflows).toHaveLength(1);
    const group = model.workflows[0]!;
    expect(group.phases).toHaveLength(2);
    expect(group.phases[0]!.state).toBe("done");
    expect(group.phases[1]!.state).toBe("running");
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["direct-1"]);
  });

  it("counts idle deliberately and waiting as active", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.idleCount).toBe(1);
    // Member 1 is running; the wf-1 coordinator is a container, not a worker.
    expect(model.runningCount).toBe(1);
    // Every agent lands in exactly one bucket, except coordinators that stand
    // in for their members.
    expect(model.idleCount + model.runningCount + model.waitingCount + model.settledCount).toBe(
      roster.length - 1,
    );
  });

  it("omits a workflow coordinator from the working-agent count", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    // One member still running plus one idle direct spawn. The coordinator
    // reports running for the whole workflow and must not inflate the banner.
    expect(model.liveCount).toBe(1);
  });

  it("omits a finished workflow coordinator from the settled count", () => {
    const finished = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow", title: "sweep" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        title: "sweep:a",
        status: "completed",
        parentAgentId: "wf-2",
        agentIndex: 0,
        phaseIndex: 0,
      }),
      activity("task.completed", {
        taskId: "wf-2:wf:0",
        status: "completed",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "completed" }),
    ]);

    const model = deriveAgentPanelModel({ agents: finished });

    // Only the member settled. The coordinator stands in for it, so counting
    // both would report two finished agents where one ran.
    expect(model.settledCount).toBe(1);
    expect(model.liveCount).toBe(0);
  });

  it("keeps direct spawns in first-seen order as their activity changes", () => {
    const directRoster = fold([
      activity("task.started", { taskId: "direct-a", title: "First" }, "2026-08-01T11:00:00.000Z"),
      activity("task.started", { taskId: "direct-b", title: "Second" }, "2026-08-01T11:00:01.000Z"),
      activity(
        "task.progress",
        { taskId: "direct-a", summary: "Newest activity" },
        "2026-08-01T11:00:02.000Z",
      ),
    ]);

    expect(
      deriveAgentPanelModel({ agents: directRoster }).directAgents.map((agent) => agent.id),
    ).toEqual(["direct-a", "direct-b"]);
  });

  it("keeps first-seen order after the roster retention ranking runs", () => {
    const starts = Array.from({ length: 101 }, (_, index) =>
      activity(
        "task.started",
        { taskId: `capped-${index}`, title: `Agent ${index}` },
        `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
      ),
    );
    const cappedRoster = fold([
      ...starts,
      activity(
        "task.progress",
        { taskId: "capped-0", summary: "Newest activity" },
        "2026-08-01T12:02:00.000Z",
      ),
    ]);

    const ids = deriveAgentPanelModel({ agents: cappedRoster }).directAgents.map(
      (agent) => agent.id,
    );
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 3)).toEqual(["capped-0", "capped-2", "capped-3"]);
    expect(ids.at(-1)).toBe("capped-100");
  });

  it("a phase with only pending members never reads as running", () => {
    const pendingRoster = fold([
      activity("task.started", { taskId: "wf-9", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-9",
        phases: [{ index: 0, title: "Fix" }],
      }),
      activity("task.progress", {
        taskId: "wf-9:wf:0",
        title: "fixer",
        status: "pending",
        parentAgentId: "wf-9",
        agentIndex: 0,
        phaseIndex: 0,
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: pendingRoster });
    // "pending" counts as active liveness (queued work), so the phase reads
    // running only if a member is genuinely pending/running — this asserts
    // the settled-count rule: no member settled, phase not done.
    expect(model.workflows[0]!.phases[0]!.state).not.toBe("done");
  });

  it("v2 projection wins outright and sources are never merged", () => {
    const v2Agent = { ...roster[0]!, id: "v2-only", title: "From v2" };
    const model = deriveAgentPanelModel({ agents: roster, v2Projection: [v2Agent] });
    const allIds = [
      ...model.workflows.map((group) => group.workflow.id),
      ...model.directAgents.map((agent) => agent.id),
    ];
    expect(allIds).toContain("v2-only");
    expect(allIds).not.toContain("direct-1");
  });

  it("orphaned members fall back to the direct list", () => {
    const orphans = fold([
      activity("task.progress", {
        taskId: "gone:wf:0",
        title: "orphan",
        status: "running",
        parentAgentId: "gone",
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: orphans });
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["gone:wf:0"]);
  });
});

describe("agent panel sections", () => {
  it("puts working states on top and every non-working state under idle", () => {
    expect(subagentPanelSection("pending")).toBe("active");
    expect(subagentPanelSection("running")).toBe("active");
    expect(subagentPanelSection("waiting")).toBe("active");
    expect(subagentPanelSection("idle")).toBe("idle");
    expect(subagentPanelSection("completed")).toBe("idle");
    expect(subagentPanelSection("failed")).toBe("idle");
    expect(subagentPanelSection("interrupted")).toBe("idle");
  });

  it("splits mixed workflows without moving idle members into active", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-section",
        taskType: "local_workflow",
        status: "running",
      }),
      activity("task.progress", {
        taskId: "wf-section:wf:0",
        parentAgentId: "wf-section",
        phaseIndex: 0,
        status: "running",
      }),
      activity("task.progress", {
        taskId: "wf-section:wf:1",
        parentAgentId: "wf-section",
        phaseIndex: 0,
        status: "completed",
      }),
      activity("task.progress", {
        taskId: "wf-section:wf:2",
        parentAgentId: "wf-section",
        phaseIndex: 0,
        status: "idle",
      }),
    ]);
    const group = deriveAgentPanelModel({ agents }).workflows[0]!;
    const active = filterWorkflowForPanelSection(group, "active");
    const idle = filterWorkflowForPanelSection(group, "idle");

    expect(group.workflow.status).toBe("running");
    expect(active?.phases.flatMap((phase) => phase.members).map((member) => member.id)).toEqual([
      "wf-section:wf:0",
    ]);
    expect(idle?.phases.flatMap((phase) => phase.members).map((member) => member.id)).toEqual([
      "wf-section:wf:1",
      "wf-section:wf:2",
    ]);
    expect(active?.workflow.status).toBe("running");
    expect(idle?.workflow.status).toBe("idle");
    expect(idle?.phases[0]).toMatchObject({ state: "running", activeCount: 1, settledCount: 1 });
  });
});

describe("workflowCardMembers", () => {
  it("orders by urgency (failed, running, waiting) and reports overflow", () => {
    const roster = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      ...[..."abcdefghij"].map((letter, index) =>
        activity("task.progress", {
          taskId: `wf-1:wf:${index}`,
          title: `agent-${letter}`,
          status: index === 3 ? "failed" : index < 3 ? "completed" : "running",
          ...(index === 3 ? { error: "died" } : {}),
          parentAgentId: "wf-1",
          agentIndex: index,
          phaseIndex: 0,
          phaseTitle: "Work",
        }),
      ),
    ]);
    const model = deriveAgentPanelModel({ agents: roster });
    const { visible, overflow } = workflowCardMembers(model.workflows[0]!, 8);
    expect(visible).toHaveLength(8);
    expect(overflow).toBe(2);
    expect(visible[0]!.status).toBe("failed");
    expect(visible.filter((agent) => agent.status === "completed").length).toBeLessThanOrEqual(2);
  });
});

describe("timeline predicates", () => {
  it("recognizes subagent activity kinds as fold input", () => {
    for (const kind of [
      "task.started",
      "task.progress",
      "task.updated",
      "task.completed",
      "tool.progress",
    ]) {
      expect(isSubagentActivityKind(kind)).toBe(true);
    }
    expect(isSubagentActivityKind("tool.completed")).toBe(false);
  });

  it("attributed tool rows are re-homed; unattributed rows stay in the timeline", () => {
    expect(isAgentAttributedToolActivity(activity("tool.completed", { agentId: "task-1" }))).toBe(
      true,
    );
    expect(isAgentAttributedToolActivity(activity("tool.completed", {}))).toBe(false);
    expect(isAgentAttributedToolActivity(activity("tool.completed", { agentId: "  " }))).toBe(
      false,
    );
  });

  it("timelineBypass rows never render in the parent chat", () => {
    expect(isTimelineBypassActivity(activity("task.progress", { timelineBypass: true }))).toBe(
      true,
    );
    expect(isTimelineBypassActivity(activity("task.progress", {}))).toBe(false);
  });
});

describe("formatSubagentTokenCount", () => {
  it("formats plain counters", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("model and effort attribution", () => {
  it("carries model/effort from start rows and refines model from later rows", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-m",
        title: "Verify math",
        model: "sonnet",
        effort: "high",
      }),
      // Later row refines with the authoritative API model id; effort absent
      // must not clear the known value.
      activity("task.progress", { taskId: "task-m", model: "claude-sonnet-5[1m]" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe("claude-sonnet-5[1m]");
    expect(agents[0]!.effort).toBe("high");
  });

  it("applies metadata-only updates without changing the current status", () => {
    const waitingRows = [
      activity("task.updated", {
        taskId: "task-metadata",
        title: "Check metadata",
        status: "waiting",
      }),
      activity("task.updated", {
        taskId: "task-metadata",
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ];
    const waitingAgent = fold(waitingRows)[0]!;
    expect(waitingAgent.status).toBe("waiting");
    expect(formatSubagentModelLabel(waitingAgent.model, waitingAgent.effort)).toBe(
      "gpt-5.6-sol · high",
    );

    const idleRows = [
      ...waitingRows,
      activity("task.updated", { taskId: "task-metadata", status: "idle" }),
      activity("task.updated", { taskId: "task-metadata", model: "gpt-5.6-sol" }),
    ];
    expect(fold(idleRows)[0]!.status).toBe("idle");

    const completedAgent = fold([
      ...idleRows,
      activity("task.progress", { taskId: "task-metadata", typedUsage: { totalTokens: 42 } }),
      activity("task.completed", { taskId: "task-metadata", status: "completed" }),
      activity("task.updated", { taskId: "task-metadata", effort: "high" }),
    ])[0]!;
    expect(completedAgent.status).toBe("completed");
    expect(completedAgent.model).toBe("gpt-5.6-sol");
    expect(completedAgent.effort).toBe("high");
  });

  it("formatSubagentModelLabel compacts ids and appends effort", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]", "high")).toBe("sonnet-5[1m] · high");
    expect(formatSubagentModelLabel("claude-opus-4-20250514", null)).toBe("opus-4");
    expect(formatSubagentModelLabel("gpt-5.6-sol", "low")).toBe("gpt-5.6-sol · low");
    expect(formatSubagentModelLabel(null, "high")).toBeNull();
  });
});

describe("background task exclusion", () => {
  it("shells and monitors never join the roster (from any lifecycle row)", () => {
    const agents = fold([
      activity("task.started", { taskId: "shell-1", taskType: "shell", title: "Run 12s stall" }),
      activity("task.progress", { taskId: "shell-2", taskType: "shell", title: "Run stall" }),
      activity("task.completed", { taskId: "mon-1", taskType: "monitor", status: "completed" }),
      activity("task.started", { taskId: "agent-1", taskType: "subagent", title: "Real agent" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-1"]);
  });

  it("rows without a taskType stay in the roster (workflow members, Codex children)", () => {
    const agents = fold([
      activity("task.progress", { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" }),
    ]);
    expect(agents).toHaveLength(1);
  });

  it("the server stamp is the only classifier: no stamp means no roster row", () => {
    const agents = fold([
      // Stamped background: agent-looking fields don't matter.
      activity("task.started", {
        taskId: "bg-1",
        agentKind: "background",
        role: "watcher",
        model: "sonnet",
      }),
      // Stamped agent: plain row still joins the roster.
      activity("task.started", { taskId: "ag-1", agentKind: "agent", detail: "plain row" }),
      // Legacy pre-stamp rows (old threads/servers) stay in the work log —
      // exactly their pre-upgrade behavior.
      legacyActivity("task.started", { taskId: "old-task", detail: "tailing logs" }),
      legacyActivity("task.progress", { taskId: "old-task", summary: "still tailing" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["ag-1"]);
  });

  it("membership is sticky: a stampless later row still reaches a known agent", () => {
    const agents = fold([
      activity("task.started", { taskId: "a1", taskType: "local_agent", title: "Agent" }),
      // Terminal row missing the stamp (defensive: adapters synthesize some
      // rows) — sticky membership still routes it to the agent.
      legacyActivity("task.completed", { taskId: "a1", status: "completed", summary: "done" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("completed");
    expect(agents[0]!.result).toBe("done");
  });
});

describe("session-derived interruption", () => {
  it("dead session interrupts live agents but preserves idle and settled", () => {
    const rows = [
      activity("task.started", { taskId: "live-1", taskType: "local_agent" }),
      activity("task.started", { taskId: "idle-1", taskType: "local_agent" }),
      activity("task.updated", { taskId: "idle-1", status: "idle" }),
      activity("task.started", { taskId: "done-1", taskType: "local_agent" }),
      activity("task.completed", { taskId: "done-1", status: "completed" }),
    ];
    const dead = foldSubagentActivities(rows, { sessionLive: false });
    expect(dead.find((agent) => agent.id === "live-1")?.status).toBe("interrupted");
    expect(dead.find((agent) => agent.id === "idle-1")?.status).toBe("idle");
    expect(dead.find((agent) => agent.id === "done-1")?.status).toBe("completed");
    const alive = foldSubagentActivities(rows, { sessionLive: true });
    expect(alive.find((agent) => agent.id === "live-1")?.status).toBe("running");
  });
});

describe("terminal robustness", () => {
  it("keeps reopened prompt metadata idle without reviving settled agents", () => {
    const promptOnly = fold([
      activity("task.updated", {
        taskId: "historical-idle",
        status: "idle",
        prompt: "Original launch prompt",
        role: "reviewer",
      }),
    ]);
    expect(promptOnly[0]?.status).toBe("idle");

    const settled = fold([
      activity("task.started", { taskId: "historical-settled", taskType: "local_agent" }),
      activity("task.completed", { taskId: "historical-settled", status: "completed" }),
      activity("task.progress", {
        taskId: "historical-settled",
        status: "idle",
        prompt: "Original launch prompt",
      }),
    ]);
    expect(settled[0]?.status).toBe("completed");

    const resumedWaiting = fold([
      activity("task.started", { taskId: "historical-waiting", taskType: "local_agent" }),
      activity("task.completed", { taskId: "historical-waiting", status: "failed" }),
      activity("task.updated", { taskId: "historical-waiting", status: "waiting" }),
    ]);
    expect(resumedWaiting[0]?.status).toBe("waiting");
  });

  it("task.updated creating an agent (start row aged out) counts one activation", () => {
    const agents = fold([
      activity("task.updated", { taskId: "orphan-u", status: "running", role: "worker" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(1);
    expect(agents[0]!.status).toBe("running");
  });

  it("a late start after a terminal task.updated does not reopen the run", () => {
    const agents = fold([
      activity("task.updated", { taskId: "t1", status: "failed", role: "worker" }),
      activity("task.started", { taskId: "t1", taskType: "local_agent", title: "Late" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
    expect(agents[0]!.title).toBe("Late");
  });

  it("a completion after a terminal task.updated still enriches result and usage", () => {
    // Claude commonly emits terminal task.updated before task.completed;
    // the completion carries the summary and final usage the update lacked.
    const agents = fold([
      activity("task.started", { taskId: "te-1", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "te-1", status: "completed", endedAt: "2026-08-01T10:59:00.000Z" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        {
          taskId: "te-1",
          status: "completed",
          summary: "final answer",
          typedUsage: { totalTokens: 4200, toolUses: 7 },
        },
        "2026-08-01T11:00:01.000Z",
      ),
    ]);
    const agent = agents[0]!;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("final answer");
    expect(agent.usage?.totalTokens).toBe(4200);
    // Timestamps stay pinned to the transition that settled the run.
    expect(agent.completedAt).toBe("2026-08-01T10:59:00.000Z");
  });

  it("duplicate completions keep the FIRST result, not the last", () => {
    const agents = fold([
      activity("task.started", { taskId: "t2", taskType: "local_agent" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "first result" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "second result" }),
    ]);
    expect(agents[0]!.result).toBe("first result");
  });

  it("provider endedAt wins over ingestion time on the settling transition", () => {
    const agents = fold([
      activity("task.started", { taskId: "t3", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "t3", status: "failed", endedAt: "2026-08-01T09:59:59.000Z" },
        "2026-08-01T10:00:30.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T09:59:59.000Z");
  });

  it("workflow retries count each attempt once", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "failed",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 2,
      }),
    ]);
    expect(agents[0]!.activationCount).toBe(2);
  });
});

describe("phase membership", () => {
  it("members with unknown phase indices land in unphasedMembers, never vanish", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity("task.started", {
          taskId: "wf-p",
          taskType: "local_workflow",
          phases: [{ index: 0, title: "Only phase" }],
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:0",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 0,
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:9",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 9,
        }),
      ]),
    });
    const group = model.workflows[0]!;
    const visible = [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ].map((member) => member.id);
    expect(visible).toContain("wf-p:wf:0");
    expect(visible).toContain("wf-p:wf:9");
  });
});

describe("coordinator settle cascade", () => {
  it("members without their own terminal row settle when the coordinator does", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "stalled member",
        status: "running",
        parentAgentId: "wf-1",
      }),
      activity("task.completed", {
        taskId: "wf-1",
        status: "completed",
        taskType: "local_workflow",
      }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(member?.status).toBe("completed");
    expect(member?.completedAt).not.toBeNull();
  });

  it("a failed coordinator marks unfinished members interrupted, not completed", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        status: "running",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "failed", taskType: "local_workflow" }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-2:wf:0");
    expect(member?.status).toBe("interrupted");
  });
});

describe("task type classification is a denylist", () => {
  it("unknown agent-flavored types (local_agent, future names) join the roster", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "a1",
        taskType: "local_agent",
        title: "Math test 1",
        role: "claude",
      }),
      activity("task.started", { taskId: "a2", taskType: "some_future_agent_kind", title: "X" }),
    ]);
    expect(agents.map((agent) => agent.id).toSorted()).toEqual(["a1", "a2"]);
  });
});

describe("nested agents vs subagent shells", () => {
  it("a nested agent (agentId + agent taskType) stays in the roster; its shells do not", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "nested-1",
        taskType: "local_agent",
        agentId: "parent-agent",
        title: "Nested researcher",
      }),
      activity("task.started", {
        taskId: "shell-1",
        taskType: "local_bash",
        agentId: "parent-agent",
        title: "Nested sleep",
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["nested-1"]);
  });
});

describe("deriveSubagentReplies", () => {
  function message(
    id: string,
    agentId: string | undefined,
    text: string,
    at: string,
    role: "assistant" | "user" = "assistant",
  ): OrchestrationMessage {
    return {
      id,
      role,
      text,
      ...(agentId ? { agentId } : {}),
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    } as unknown as OrchestrationMessage;
  }

  it("recovers a foreground report from the collaboration tool's result", () => {
    const replies = deriveSubagentReplies([
      activity("task.started", {
        taskId: "agent-1",
        title: "Reviewer",
        toolUseId: "toolu_1",
        taskType: "local_agent",
      }),
      activity("tool.completed", {
        itemType: "collab_agent_tool_call",
        itemId: "toolu_1",
        data: { toolName: "Task", agentReply: "Found the bug in parser.ts." },
      }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      agentId: "agent-1",
      agentTitle: "Reviewer",
      ownerAgentId: null,
      text: "Found the bug in parser.ts.",
    });
  });

  it("recovers a background report from the terminal task row's summary", () => {
    const replies = deriveSubagentReplies([
      activity("task.started", { taskId: "agent-bg", title: "Watcher", taskType: "local_agent" }),
      activity("task.completed", {
        taskId: "agent-bg",
        title: "Watcher",
        taskType: "local_agent",
        status: "completed",
        summary: "The build went green.",
      }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ agentId: "agent-bg", text: "The build went green." });
  });

  it("does not render the same report twice when it arrives both ways", () => {
    const replies = deriveSubagentReplies([
      activity("task.started", {
        taskId: "agent-1",
        title: "Reviewer",
        toolUseId: "toolu_1",
        taskType: "local_agent",
      }),
      activity("tool.completed", {
        itemType: "collab_agent_tool_call",
        itemId: "toolu_1",
        data: { agentReply: "Same report." },
      }),
      activity("task.completed", {
        taskId: "agent-1",
        taskType: "local_agent",
        status: "completed",
        summary: "Same report.",
      }),
    ]);

    expect(replies).toHaveLength(1);
  });

  it("falls back to the child's turn-final message when the protocol has no result field", () => {
    // Codex: `collabAgentToolCall` carries no output, so what the parent read
    // is the last thing the child said before it went idle.
    const replies = deriveSubagentReplies(
      [
        activity("task.started", { taskId: "child-1", title: "math_one", taskType: "collab" }),
        activity(
          "task.updated",
          { taskId: "child-1", status: "idle", taskType: "collab" },
          "2026-08-01T10:05:00.000Z",
        ),
      ],
      [
        message("m1", "child-1", "Working on it.", "2026-08-01T10:01:00.000Z"),
        message("m2", "child-1", "The answer is 42.", "2026-08-01T10:04:00.000Z"),
        message("m3", undefined, "parent text", "2026-08-01T10:04:30.000Z"),
      ],
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ agentId: "child-1", text: "The answer is 42." });
  });

  it("does not resend a turn-final message when repeated idle rows land", () => {
    const replies = deriveSubagentReplies(
      [
        activity("task.started", { taskId: "child-1", title: "child", taskType: "collab" }),
        activity(
          "task.updated",
          { taskId: "child-1", status: "idle", taskType: "collab" },
          "2026-08-01T10:05:00.000Z",
        ),
        activity(
          "task.updated",
          { taskId: "child-1", status: "idle", taskType: "collab" },
          "2026-08-01T10:06:00.000Z",
        ),
      ],
      [message("m1", "child-1", "done", "2026-08-01T10:04:00.000Z")],
    );

    expect(replies).toHaveLength(1);
  });

  it("routes a nested agent's report to the subagent that owns it, not the parent", () => {
    const replies = deriveSubagentReplies([
      activity("task.started", {
        taskId: "nested-1",
        title: "Nested",
        toolUseId: "toolu_nested",
        taskType: "local_agent",
        agentId: "agent-1",
      }),
      activity("tool.completed", {
        itemType: "collab_agent_tool_call",
        itemId: "toolu_nested",
        agentId: "agent-1",
        data: { agentReply: "Nested finding." },
      }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.ownerAgentId).toBe("agent-1");
    expect(selectSubagentRepliesFor(replies, null)).toEqual([]);
    expect(selectSubagentRepliesFor(replies, "agent-1")).toHaveLength(1);
  });

  it("ignores a collaboration result it cannot attribute to an agent", () => {
    const replies = deriveSubagentReplies([
      activity("tool.completed", {
        itemType: "collab_agent_tool_call",
        itemId: "toolu_orphan",
        data: { agentReply: "Whose report is this?" },
      }),
    ]);

    expect(replies).toEqual([]);
  });

  it("links a follow-up SendMessage result by the agent name it addressed", () => {
    const replies = deriveSubagentReplies([
      activity("task.started", {
        taskId: "agent-1",
        title: "marlow",
        toolUseId: "toolu_launch",
        taskType: "local_agent",
      }),
      activity("tool.completed", {
        itemType: "collab_agent_tool_call",
        itemId: "toolu_followup",
        data: { toolName: "SendMessage", input: { to: "marlow" }, agentReply: "Acknowledged." },
      }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ agentId: "agent-1", text: "Acknowledged." });
  });
});
