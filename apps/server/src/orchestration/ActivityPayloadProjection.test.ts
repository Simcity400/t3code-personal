import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps preview normalization and fence-only fallback while scanning lines", () => {
    const preview = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: `\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}` },
      }),
    );
    const fences = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: "```\r\n \t \n```\n" },
      }),
    );

    expect((preview.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "actual result",
    });
    expect((fences.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "2 lines",
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude command input and result summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "tests passed" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: {
        toolName: "Bash",
        command: "vp test run",
        rawOutput: { content: "tests passed" },
      },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(250);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("preserves only Claude's exact subagent prompt linkage", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "toolu_agent_1",
        data: {
          toolName: "Agent",
          input: {
            description: "Review the database layer",
            name: "security-reviewer",
            prompt: "Audit every SQL change and report exact file evidence.",
            subagent_type: "code-reviewer",
          },
          result: { huge: "x".repeat(5000) },
        },
      }),
    );

    // `name` rides along because later follow-ups address the agent by it.
    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      itemId: "toolu_agent_1",
      data: {
        toolName: "Agent",
        input: {
          name: "security-reviewer",
          prompt: "Audit every SQL change and report exact file evidence.",
        },
      },
    });
  });

  it("preserves a Claude SendMessage follow-up instruction and its recipient", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "toolu_send_1",
        data: {
          toolName: "SendMessage",
          input: {
            to: "code-reviewer",
            message: "Also check the reopened thread.",
            summary: "Follow-up",
          },
          result: { huge: "x".repeat(5000) },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      itemId: "toolu_send_1",
      data: {
        toolName: "SendMessage",
        input: {
          to: "code-reviewer",
          message: "Also check the reopened thread.",
          summary: "Follow-up",
        },
      },
    });
  });

  it("preserves a child agent's user message text and drops the rest", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "user_message",
        itemId: "child-user-1",
        agentId: "child-1",
        data: {
          type: "userMessage",
          id: "child-user-1",
          content: [
            { type: "text", text: "Review the exact diff." },
            { type: "image", data: "z".repeat(5000) },
          ],
          rawProviderBlob: "y".repeat(5000),
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "user_message",
      itemId: "child-user-1",
      agentId: "child-1",
      data: {
        type: "userMessage",
        id: "child-user-1",
        content: [{ type: "text", text: "Review the exact diff." }],
      },
    });
  });

  it("preserves only Codex's exact prompt and receiving child linkage", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "call_spawn_1",
        data: {
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            prompt: "Inspect the mobile transcript.",
            receiverThreadIds: ["child-thread-1"],
            agentsStates: { "child-thread-1": { status: "completed" } },
            model: "gpt-5.6-sol",
          },
          turnId: "turn-1",
          rawProviderBlob: "y".repeat(5000),
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      itemId: "call_spawn_1",
      data: {
        item: {
          type: "collabAgentToolCall",
          id: "call_spawn_1",
          tool: "spawnAgent",
          prompt: "Inspect the mobile transcript.",
          receiverThreadIds: ["child-thread-1"],
        },
      },
    });
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

describe("collaboration replies and per-agent context rows", () => {
  it("keeps the reply a subagent sent back, verbatim", () => {
    // Every other tool result is reduced to a one-line summary here. This one
    // is the message the parent actually received, and the parent timeline
    // renders it as a message, so summarizing it would delete the content.
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "toolu_agent_1",
        data: {
          toolName: "Task",
          input: { prompt: "Audit the SQL changes." },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "Found two unparameterized queries.\nBoth in db/users.ts." },
            ],
          },
        },
      }),
    );

    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.agentReply).toBe("Found two unparameterized queries.\nBoth in db/users.ts.");
  });

  it("reads a plain-string reply envelope too", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "toolu_agent_2",
        data: { toolName: "Task", result: { content: "Done." } },
      }),
    );

    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.agentReply).toBe("Done.");
  });

  it("bounds a runaway report instead of shipping it whole", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "toolu_agent_3",
        data: { toolName: "Task", result: { content: "y".repeat(50_000) } },
      }),
    );

    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(typeof data.agentReply).toBe("string");
    expect((data.agentReply as string).length).toBe(20_001);
    expect((data.agentReply as string).endsWith("…")).toBe(true);
  });

  it("adds nothing when the result carries no reply text", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        itemId: "toolu_agent_4",
        data: { toolName: "Task", result: { status: "ok" } },
      }),
    );

    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data).not.toHaveProperty("agentReply");
  });

  it("retains one context-window row per turn AND per owner", () => {
    // The parent and its subagents report under the same turn id, so a
    // turn-only retention rule shipped only whichever conversation reported
    // last and every other meter came back empty after a reload.
    const contextRow = (id: string, usedTokens: number, agentId?: string) =>
      ({
        id,
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens, ...(agentId ? { agentId } : {}) },
        turnId: "turn-1",
        createdAt: "2026-08-01T10:00:00.000Z",
      }) as unknown as OrchestrationThreadActivity;

    const projected = projectThreadDetailSnapshot({
      thread: {
        activities: [
          contextRow("parent-1", 1_000),
          contextRow("agent-a-1", 2_000, "agent-a"),
          contextRow("parent-2", 1_500),
          contextRow("agent-a-2", 2_500, "agent-a"),
          contextRow("agent-b-1", 3_000, "agent-b"),
        ],
      },
    } as unknown as Parameters<typeof projectThreadDetailSnapshot>[0]);

    expect(projected.thread.activities.map((row) => row.id)).toEqual([
      "parent-2",
      "agent-a-2",
      "agent-b-1",
    ]);
  });
});
