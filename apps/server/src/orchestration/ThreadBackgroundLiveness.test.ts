import { describe, expect, it } from "vite-plus/test";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

describe("ThreadBackgroundLiveness", () => {
  it("does not let status-free progress or metadata restart an idle task", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();

    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "completed-task",
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "completed-task",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "completed-task",
      taskType: undefined,
      status: undefined,
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
  });

  it("agents present as working; monitors as monitoring; agents win", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-1";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("terminal rows without a taskType still clear monitor entries", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-2";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    // Terminal tick arrives with no taskType (common on task.completed).
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("nested agents (agentId + agent taskType) still count toward liveness", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-nested";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: "completed",
      kind: "completed",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("untyped rows count as agents; idle is not live; agent-owned tasks are ignored", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-3";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
    liveness.recordTaskLiveness({
      threadId,
      taskId: "sh:1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("reclassification moves a task between buckets instead of duplicating it", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-reclass";
    // First seen without a taskType: counts as an agent.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: undefined,
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    // Later transition reveals it's a shell: downgrade to monitoring, not
    // a stale duplicate pinning "working".
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    // Turning out to be inert or agent-owned drops the prior entry too.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("plan tasks are inert; clear removes everything; instances are isolated", () => {
    const a = ThreadBackgroundLiveness.make();
    const b = ThreadBackgroundLiveness.make();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "p1",
      taskType: "plan",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: "local_workflow",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBe("working");
    expect(b.getThreadBackgroundLiveness("t")).toBeNull();
    a.clearThreadLiveness("t");
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
  });
});

describe("getThreadBackgroundWait", () => {
  it("names one live task with whatever the provider called it", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "sh1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
      label: "pnpm test --watch",
      at: "2026-09-04T10:00:00.000Z",
    });
    expect(liveness.getThreadBackgroundWait("t")).toEqual({
      count: 1,
      label: "pnpm test --watch",
      since: "2026-09-04T10:00:00.000Z",
      monitorOnly: true,
    });
  });

  it("leads with the longest-running item and counts the rest, agents-only using the agent noun", () => {
    const liveness = ThreadBackgroundLiveness.make();
    for (const [taskId, label, at] of [
      ["a2", "Second", "2026-09-04T10:05:00.000Z"],
      ["a1", "First", "2026-09-04T10:00:00.000Z"],
      ["a3", "Third", "2026-09-04T10:09:00.000Z"],
    ] as const) {
      liveness.recordTaskLiveness({
        threadId: "t",
        taskId,
        taskType: "subagent",
        status: undefined,
        kind: "started",
        label,
        at,
      });
    }
    expect(liveness.getThreadBackgroundWait("t")).toEqual({
      count: 3,
      label: "First + 2 more agents",
      since: "2026-09-04T10:00:00.000Z",
      monitorOnly: false,
    });
  });

  it("falls back to a plain count when the provider named nothing, and never prints a task id", () => {
    const liveness = ThreadBackgroundLiveness.make();
    for (const taskId of ["x1", "x2"]) {
      liveness.recordTaskLiveness({
        threadId: "t",
        taskId,
        taskType: "subagent",
        status: undefined,
        kind: "started",
        at: "2026-09-04T10:00:00.000Z",
      });
    }
    const wait = liveness.getThreadBackgroundWait("t");
    expect(wait?.label).toBe("2 agents");
    expect(wait?.label).not.toContain("x1");
  });

  it("uses the generic noun once anything but an agent is live", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
      label: "Reviewer",
      at: "2026-09-04T10:00:00.000Z",
    });
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "m1",
      taskType: "monitor",
      status: undefined,
      kind: "started",
      label: "watch",
      at: "2026-09-04T10:01:00.000Z",
    });
    expect(liveness.getThreadBackgroundWait("t")?.label).toBe("Reviewer + 1 more task");
  });

  it("monitorOnly agrees with the two-value liveness on every transition", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const record = (taskId: string, taskType: string, status?: string) =>
      liveness.recordTaskLiveness({
        threadId: "t",
        taskId,
        taskType,
        status,
        kind: status === undefined ? "started" : "updated",
        at: "2026-09-04T10:00:00.000Z",
      });
    record("m1", "local_bash");
    expect(liveness.getThreadBackgroundWait("t")?.monitorOnly).toBe(true);
    expect(liveness.getThreadBackgroundLiveness("t")).toBe("monitoring");
    record("a1", "subagent");
    expect(liveness.getThreadBackgroundWait("t")?.monitorOnly).toBe(false);
    expect(liveness.getThreadBackgroundLiveness("t")).toBe("working");
    record("a1", "subagent", "completed");
    record("m1", "local_bash", "completed");
    expect(liveness.getThreadBackgroundWait("t")).toBeNull();
    expect(liveness.getThreadBackgroundLiveness("t")).toBeNull();
  });

  it("keeps a name and a start instant that a later thin row does not repeat", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
      label: "Reviewer",
      at: "2026-09-04T10:00:00.000Z",
    });
    // Reconnect: the adapter's remembered linkage is gone, so this row
    // carries a status and nothing else.
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: undefined,
      status: "running",
      kind: "progress",
      at: "2026-09-04T10:30:00.000Z",
    });
    expect(liveness.getThreadBackgroundWait("t")).toEqual({
      count: 1,
      label: "Reviewer",
      since: "2026-09-04T10:00:00.000Z",
      monitorOnly: false,
    });
  });

  it("times the new run when a settled task restarts", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const at = (iso: string, status?: string) =>
      liveness.recordTaskLiveness({
        threadId: "t",
        taskId: "a1",
        taskType: "subagent",
        status,
        kind: status === "completed" ? "completed" : "started",
        label: "Reviewer",
        at: iso,
      });
    at("2026-09-04T10:00:00.000Z");
    at("2026-09-04T10:10:00.000Z", "completed");
    at("2026-09-04T11:00:00.000Z");
    expect(liveness.getThreadBackgroundWait("t")?.since).toBe("2026-09-04T11:00:00.000Z");
  });

  it("bounds a label long enough to break a sidebar row", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "sh1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
      label: "x".repeat(400),
      at: "2026-09-04T10:00:00.000Z",
    });
    const label = liveness.getThreadBackgroundWait("t")?.label ?? "";
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith("…")).toBe(true);
  });

  it("is null exactly when the two-value liveness is null", () => {
    const liveness = ThreadBackgroundLiveness.make();
    expect(liveness.getThreadBackgroundWait("nothing")).toBeNull();
    liveness.recordTaskLiveness({
      threadId: "t",
      taskId: "p1",
      taskType: "plan",
      status: undefined,
      kind: "started",
      label: "plan bookkeeping",
      at: "2026-09-04T10:00:00.000Z",
    });
    expect(liveness.getThreadBackgroundWait("t")).toBeNull();
    expect(liveness.getThreadBackgroundLiveness("t")).toBeNull();
  });
});
