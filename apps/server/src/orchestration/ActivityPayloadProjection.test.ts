import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

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

  it("normalizes Claude and OpenCode command inputs before slimming provider data", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: { content: "x".repeat(5_000) },
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
      data: { command: "vp test run" },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(200);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
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
