import { selectSubagentTranscriptMessages } from "../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  ThreadId,
  readTaskStates,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { projectTaskActivity, updateTaskState } from "./taskState.ts";
import { retainThreadActivities } from "./projector.ts";

const threadId = ThreadId.make("task-state-test");
function activity(
  kind: string,
  payload: Record<string, unknown>,
  second = 0,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${kind}:${second}`),
    kind,
    payload,
    tone: "info",
    summary: kind,
    turnId: null,
    createdAt: DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe("2026-09-05T10:00:00Z"), { seconds: second }),
    ),
  };
}

describe("server task state", () => {
  it("preserves a shell's identity and owner through thin updates", () => {
    const start = updateTaskState(
      undefined,
      activity("task.started", {
        taskId: "shell",
        taskType: "local_bash",
        agentId: "reviewer",
        command: "pnpm test",
        canStop: true,
      }),
    );
    const end = updateTaskState(
      start,
      activity(
        "task.completed",
        {
          taskId: "shell",
          agentKind: "agent",
          status: "completed",
          summary: "Tests passed",
        },
        1,
      ),
    );
    expect(end).toMatchObject({
      id: "shell",
      agentKind: "background",
      parentAgentId: "reviewer",
      command: "pnpm test",
      canStop: true,
      status: "completed",
      result: "Tests passed",
    });
  });

  it("keeps one current record after the transcript window ages out", () => {
    let rows: ReadonlyArray<OrchestrationThreadActivity> = [];
    for (let index = 0; index < 1200; index++) {
      const next = activity(
        index === 0 ? "task.started" : "tool.completed",
        index === 0
          ? { taskId: "agent", taskType: "subagent", title: "Reviewer", model: "model-a" }
          : { itemId: `tool-${index}` },
        index,
      );
      const updates = projectTaskActivity(threadId, rows, next);
      const ids = new Set(updates.map((row) => row.id));
      rows = retainThreadActivities([...rows.filter((row) => !ids.has(row.id)), next, ...updates]);
    }
    expect(readTaskStates(rows)).toMatchObject([
      { id: "agent", title: "Reviewer", model: "model-a" },
    ]);
    expect(rows.some((row) => row.kind === "task.started")).toBe(false);
    expect(rows.length).toBeLessThanOrEqual(501);
  });

  it("never drops a running agent because more than 100 other agents exist", () => {
    let rows: ReadonlyArray<OrchestrationThreadActivity> = [];
    for (let index = 0; index < 150; index++)
      rows = [
        ...rows,
        ...projectTaskActivity(
          threadId,
          rows,
          activity("task.started", { taskId: `agent-${index}`, taskType: "subagent" }, index),
        ),
      ];
    expect(readTaskStates(rows)).toHaveLength(150);
    expect(readTaskStates(rows)[0]?.id).toBe("agent-0");
  });

  it("retains usage fields when a thin completion arrives", () => {
    const start = updateTaskState(
      undefined,
      activity("task.progress", {
        taskId: "agent",
        taskType: "subagent",
        typedUsage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
      }),
    );
    expect(
      updateTaskState(
        start,
        activity(
          "task.completed",
          {
            taskId: "agent",
            status: "completed",
            typedUsage: { totalTokens: 120 },
          },
          1,
        ),
      )?.usage,
    ).toEqual({ totalTokens: 120, inputTokens: 80, outputTokens: 20 });
  });

  it("a late start enriches a finished task without reopening it", () => {
    const end = updateTaskState(
      undefined,
      activity("task.completed", {
        taskId: "agent",
        taskType: "subagent",
        status: "failed",
        summary: "Failed",
      }),
    );
    const late = updateTaskState(
      end,
      activity("task.started", { taskId: "agent", title: "Reviewer" }, 1),
    );
    expect(late).toMatchObject({
      status: "failed",
      title: "Reviewer",
      completedAt: end?.completedAt,
    });
  });

  it("reactivates a completed agent directly into a waiting state", () => {
    const end = updateTaskState(
      undefined,
      activity("task.completed", {
        taskId: "agent",
        taskType: "subagent",
        status: "completed",
        summary: "Old result",
      }),
    );
    expect(
      updateTaskState(end, activity("task.updated", { taskId: "agent", status: "waiting" }, 1)),
    ).toMatchObject({ status: "waiting", activationCount: 2, result: null, completedAt: null });
  });

  it("settles orphaned workflow members but not unrelated tasks", () => {
    let rows: ReadonlyArray<OrchestrationThreadActivity> = [];
    for (const payload of [
      { taskId: "workflow", taskType: "local_workflow" },
      { taskId: "member", taskType: "local_agent", parentAgentId: "workflow", phaseIndex: 0 },
      { taskId: "other", taskType: "local_agent" },
    ])
      rows = [...rows, ...projectTaskActivity(threadId, rows, activity("task.started", payload))];
    const updates = readTaskStates(
      projectTaskActivity(
        threadId,
        rows,
        activity("task.completed", { taskId: "workflow", status: "failed" }, 1),
      ),
    );
    expect(updates.map((state) => [state.id, state.status])).toEqual([
      ["workflow", "failed"],
      ["member", "interrupted"],
    ]);
  });

  it("ignores malformed tasks and does not create a task from a tool heartbeat", () => {
    expect(updateTaskState(undefined, activity("task.updated", { taskId: " " }))).toBeUndefined();
    expect(
      updateTaskState(undefined, activity("tool.progress", { taskId: "unknown" })),
    ).toBeUndefined();
  });
});

describe("retained task relationships", () => {
  it("preserves Claude launch and name-addressed follow-up after lifecycle rows expire", () => {
    const start = activity("task.started", {
      taskId: "reviewer",
      taskType: "local_agent",
      toolUseId: "launch",
      agentPath: "main/reviewer",
    });
    const states = projectTaskActivity(threadId, [], start);
    const rows = retainThreadActivities([
      start,
      ...states,
      activity(
        "tool.completed",
        {
          itemId: "launch",
          itemType: "collab_agent_tool_call",
          data: {
            toolName: "Agent",
            input: { name: "security-reviewer", prompt: "Review security." },
          },
        },
        1,
      ),
      activity(
        "tool.completed",
        {
          itemId: "follow-up",
          itemType: "collab_agent_tool_call",
          data: {
            toolName: "SendMessage",
            input: { to: "security-reviewer", message: "Check recovery too." },
          },
        },
        2,
      ),
      ...Array.from({ length: 510 }, (_, index) =>
        activity("tool.completed", { itemId: `noise-${index}` }, index + 3),
      ),
    ]);
    expect(rows.some((row) => row.kind === "task.started")).toBe(false);
    expect(selectSubagentTranscriptMessages([], rows, "reviewer").map((row) => row.text)).toEqual([
      "Review security.",
      "Check recovery too.",
    ]);
  });

  it("settles late workflow members and permits a new workflow run", () => {
    const coordinator = projectTaskActivity(
      threadId,
      [],
      activity("task.completed", {
        taskId: "workflow",
        taskType: "local_workflow",
        status: "completed",
      }),
    );
    const late = activity(
      "task.progress",
      {
        taskId: "member",
        agentKind: "agent",
        parentAgentId: "workflow",
        agentIndex: 0,
        status: "running",
      },
      1,
    );
    const member = projectTaskActivity(threadId, coordinator, late);
    expect(readTaskStates(member)[0]?.status).toBe("completed");
    const restarted = projectTaskActivity(
      threadId,
      coordinator,
      activity("task.updated", { taskId: "workflow", status: "running" }, 2),
    );
    expect(
      readTaskStates(
        projectTaskActivity(threadId, [...restarted, ...member], {
          ...late,
          createdAt: "2026-09-05T10:00:03.000Z",
        }),
      )[0],
    ).toMatchObject({ status: "running", activationCount: 2, completedAt: null });
  });
});
