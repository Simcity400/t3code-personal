import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { foldSubagentActivities } from "./subagentRuntime.ts";
import {
  backgroundTaskKind,
  backgroundTaskSourceLabel,
  deriveAgentWaitReasons,
  deriveCompactingSince,
  deriveDetachedTaskIds,
  deriveAgentWaitStates,
  deriveBackgroundTasksPanelModel,
  deriveOpenRequestWaits,
  foldBackgroundTasks,
  formatElapsedBetween,
  formatElapsedDuration,
  isActiveBackgroundTaskStatus,
  isTerminalBackgroundTaskStatus,
  type RuntimeBackgroundTask,
} from "./backgroundTasks.ts";

let sequence = 0;

/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload with the same classifier, so the helper stamps too. Pass an
 * explicit agentKind to model a legacy (pre-stamp) row.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at?: string,
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
    createdAt: at ?? `2026-09-03T10:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
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
    createdAt: `2026-09-03T10:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function byId(tasks: ReadonlyArray<RuntimeBackgroundTask>, id: string) {
  const found = tasks.find((task) => task.id === id);
  if (!found) throw new Error(`no task ${id} in [${tasks.map((task) => task.id).join(", ")}]`);
  return found;
}

describe("backgroundTaskKind", () => {
  it("splits shells back out of the contracts watch-loop set", () => {
    expect(backgroundTaskKind("local_bash")).toBe("shell");
    expect(backgroundTaskKind("shell")).toBe("shell");
    expect(backgroundTaskKind("monitor")).toBe("monitor");
    expect(backgroundTaskKind("monitor_mcp")).toBe("monitor");
    expect(backgroundTaskKind("plan")).toBe("plan");
    expect(backgroundTaskKind("dream")).toBe("plan");
  });

  it("keeps unknown and absent types visible as 'other'", () => {
    expect(backgroundTaskKind("brand_new_sdk_type")).toBe("other");
    expect(backgroundTaskKind(undefined)).toBe("other");
    expect(backgroundTaskKind(null)).toBe("other");
  });
});

describe("foldBackgroundTasks", () => {
  it("keeps exactly the rows the subagent fold drops", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
      activity("task.started", { taskId: "ag-1", taskType: "local_agent", title: "Reviewer" }),
      activity("task.started", { taskId: "mon-1", taskType: "monitor", detail: "watch build" }),
    ]);
    expect(tasks.map((task) => task.id).toSorted()).toEqual(["mon-1", "sh-1"]);
    expect(byId(tasks, "sh-1").kind).toBe("shell");
    expect(byId(tasks, "sh-1").label).toBe("pnpm test");
    expect(byId(tasks, "mon-1").kind).toBe("monitor");
  });

  it("treats a subagent's own shell as that subagent's background work", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", {
        taskId: "sh-2",
        taskType: "local_bash",
        agentId: "ag-1",
        detail: "cargo build",
      }),
    ]);
    expect(byId(tasks, "sh-2").ownerAgentId).toBe("ag-1");
  });

  it("classifies a subagent-launched task of unknown type as background", () => {
    // classifyTaskAgentKind: agentId set + no taskType => background.
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "x-1", agentId: "ag-1", detail: "unknown work" }),
    ]);
    expect(byId(tasks, "x-1").kind).toBe("other");
    expect(byId(tasks, "x-1").ownerAgentId).toBe("ag-1");
  });

  it("tracks progress, then a terminal completion with its result", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
      activity("task.progress", { taskId: "sh-1", taskType: "local_bash", summary: "42 passed" }),
      activity("task.completed", {
        taskId: "sh-1",
        taskType: "local_bash",
        status: "completed",
        summary: "exit 0",
      }),
    ]);
    const task = byId(tasks, "sh-1");
    expect(task.status).toBe("completed");
    expect(task.progress).toBe("42 passed");
    expect(task.result).toBe("exit 0");
    expect(task.endedAt).not.toBeNull();
  });

  it("maps a stopped completion to cancelled and a failure to failed", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "a", taskType: "shell", detail: "tail -f log" }),
      activity("task.completed", { taskId: "a", taskType: "shell", status: "stopped" }),
      activity("task.started", { taskId: "b", taskType: "shell", detail: "flaky" }),
      activity("task.completed", {
        taskId: "b",
        taskType: "shell",
        status: "failed",
        summary: "exit 1",
      }),
    ]);
    expect(byId(tasks, "a").status).toBe("cancelled");
    expect(byId(tasks, "b").status).toBe("failed");
    expect(byId(tasks, "b").error).toBe("exit 1");
    expect(byId(tasks, "b").result).toBeNull();
  });

  it("applies a task.updated status patch and prefers the provider end time", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "sleep 999" }),
      activity("task.updated", {
        taskId: "sh-1",
        taskType: "local_bash",
        status: "cancelled",
        endedAt: "2026-09-03T09:59:00.000Z",
      }),
    ]);
    const task = byId(tasks, "sh-1");
    expect(task.status).toBe("cancelled");
    expect(task.endedAt).toBe("2026-09-03T09:59:00.000Z");
  });

  it("freezes the first terminal timestamp but still absorbs a later result", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "build" }),
      activity("task.updated", { taskId: "sh-1", taskType: "local_bash", status: "completed" }),
      activity("task.completed", {
        taskId: "sh-1",
        taskType: "local_bash",
        status: "completed",
        summary: "built in 4s",
      }),
    ]);
    const task = byId(tasks, "sh-1");
    expect(task.result).toBe("built in 4s");
    // The terminal task.updated settled it; the completion must not slide it.
    expect(task.endedAt).toBe(task.updatedAt);
  });

  it("does not reopen a settled task when a late start row arrives", () => {
    const tasks = foldBackgroundTasks([
      activity("task.completed", { taskId: "sh-1", taskType: "local_bash", status: "failed" }),
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "late row" }),
    ]);
    expect(byId(tasks, "sh-1").status).toBe("failed");
    expect(byId(tasks, "sh-1").label).toBe("late row");
  });

  it("reopens on an explicit non-terminal status and clears the old outcome", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "m-1", taskType: "monitor", detail: "watch" }),
      activity("task.completed", { taskId: "m-1", taskType: "monitor", status: "completed" }),
      activity("task.updated", { taskId: "m-1", taskType: "monitor", status: "running" }),
    ]);
    const task = byId(tasks, "m-1");
    expect(task.status).toBe("running");
    expect(task.endedAt).toBeNull();
    expect(task.result).toBeNull();
  });

  it("settles a task from a terminal row that carries only its type", () => {
    // Terminal rows are thin — often just taskId, status and the repeated
    // linkage. As long as the linkage still carries taskType the row stays
    // background and settles the task in place. (A terminal row stamped
    // `agent` is the overlap case and belongs to the subagent fold; see the
    // exclusivity suite.)
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
      activity("task.completed", { taskId: "sh-1", taskType: "local_bash", status: "completed" }),
    ]);
    expect(byId(tasks, "sh-1").status).toBe("completed");
  });

  it("marks live tasks interrupted when the session is gone, sparing idle ones", () => {
    const rows = [
      activity("task.started", { taskId: "live", taskType: "local_bash", detail: "server" }),
      activity("task.started", { taskId: "rest", taskType: "monitor", detail: "watch" }),
      activity("task.updated", { taskId: "rest", taskType: "monitor", status: "idle" }),
    ];
    const tasks = foldBackgroundTasks(rows, { sessionLive: false });
    expect(byId(tasks, "live").status).toBe("interrupted");
    expect(byId(tasks, "live").endedAt).not.toBeNull();
    expect(byId(tasks, "rest").status).toBe("idle");
  });

  it("carries the backgrounded and ambient flags", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", {
        taskId: "sh-1",
        taskType: "local_bash",
        detail: "npm run dev",
        skipTranscript: true,
      }),
      activity("task.updated", {
        taskId: "sh-1",
        taskType: "local_bash",
        isBackgrounded: true,
      }),
    ]);
    expect(byId(tasks, "sh-1").ambient).toBe(true);
    expect(byId(tasks, "sh-1").backgrounded).toBe(true);
  });

  it("skips rows without a task id and non-object payloads", () => {
    expect(
      foldBackgroundTasks([
        activity("task.started", { taskType: "local_bash" }),
        {
          ...activity("task.started", { taskId: "x" }),
          payload: null,
        } as OrchestrationThreadActivity,
      ]),
    ).toEqual([]);
  });

  it("treats a legacy unstamped row as background, matching the subagent fold", () => {
    const legacy = {
      id: "legacy-1",
      tone: "info",
      kind: "task.started",
      summary: "task.started",
      payload: { taskId: "old-1", detail: "old shell" },
      turnId: null,
      createdAt: "2026-09-03T10:00:00.000Z",
    } as unknown as OrchestrationThreadActivity;
    expect(foldBackgroundTasks([legacy]).map((task) => task.id)).toEqual(["old-1"]);
  });

  it("orders newest first", () => {
    const tasks = foldBackgroundTasks([
      activity(
        "task.started",
        { taskId: "old", taskType: "shell", detail: "a" },
        "2026-09-03T10:00:00.000Z",
      ),
      activity(
        "task.started",
        { taskId: "new", taskType: "shell", detail: "b" },
        "2026-09-03T11:00:00.000Z",
      ),
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["new", "old"]);
  });
});

describe("deriveOpenRequestWaits", () => {
  it("opens on request and closes on resolution", () => {
    const open = deriveOpenRequestWaits([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }),
      activity("approval.requested", { requestId: "r2", requestKind: "file-change" }),
      activity("approval.resolved", { requestId: "r1" }),
    ]);
    expect(open.map((request) => request.requestId)).toEqual(["r2"]);
    expect(open[0]?.label).toBe("File-change approval");
  });

  it("closes a request the provider has already forgotten", () => {
    const open = deriveOpenRequestWaits([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }),
      activity("provider.approval.respond.failed", {
        requestId: "r1",
        detail: "Stale pending approval request",
      }),
    ]);
    expect(open).toEqual([]);
  });

  it("tracks user-input requests alongside approvals", () => {
    const open = deriveOpenRequestWaits([
      activity("user-input.requested", { requestId: "q1", questions: [] }),
    ]);
    expect(open[0]?.kind).toBe("user-input");
    expect(open[0]?.label).toBe("Your answer");
  });

  it("labels an approval of unknown kind generically", () => {
    const open = deriveOpenRequestWaits([activity("approval.requested", { requestId: "r1" })]);
    expect(open[0]?.label).toBe("Approval");
  });
});

describe("deriveAgentWaitReasons", () => {
  it("records a named reason and clears it when the child resumes", () => {
    expect(
      deriveAgentWaitReasons([
        activity("task.updated", { taskId: "c1", status: "waiting", waitReason: "approval" }),
      ]).get("c1")?.reason,
    ).toBe("approval");
    expect(
      deriveAgentWaitReasons([
        activity("task.updated", { taskId: "c1", status: "waiting", waitReason: "user-input" }),
        activity("task.updated", { taskId: "c1", status: "running" }),
      ]).get("c1"),
    ).toBeUndefined();
  });

  it("times the wait from when it began, not from the agent's start", () => {
    const reasons = deriveAgentWaitReasons([
      activity("task.updated", { taskId: "c1", status: "running" }, "2026-09-03T10:00:00.000Z"),
      activity(
        "task.updated",
        { taskId: "c1", status: "waiting", waitReason: "approval" },
        "2026-09-03T10:40:00.000Z",
      ),
      // A repeat of the same reason must not restart the clock.
      activity(
        "task.updated",
        { taskId: "c1", status: "waiting", waitReason: "approval" },
        "2026-09-03T10:41:00.000Z",
      ),
    ]);
    expect(reasons.get("c1")?.since).toBe("2026-09-03T10:40:00.000Z");
  });

  it("ignores a waiting row that names no reason", () => {
    expect(
      deriveAgentWaitReasons([activity("task.updated", { taskId: "c1", status: "waiting" })]).size,
    ).toBe(0);
  });
});

describe("deriveAgentWaitStates", () => {
  const agent = (id: string, title: string, status: RuntimeBackgroundTask["status"]) => ({
    id,
    title,
    status,
    startedAt: "2026-09-03T10:00:00.000Z",
  });

  const task = (
    id: string,
    label: string,
    ownerAgentId: string | null,
    status: RuntimeBackgroundTask["status"] = "running",
  ): RuntimeBackgroundTask => ({
    id,
    kind: "shell",
    taskType: "local_bash",
    label,
    command: null,
    server: null,
    tool: null,
    ownerAgentId,
    status,
    startedAt: "2026-09-03T10:05:00.000Z",
    endedAt: null,
    progress: null,
    result: null,
    error: null,
    backgrounded: false,
    ambient: false,
    firstSeenAt: "2026-09-03T10:05:00.000Z",
    updatedAt: "2026-09-03T10:05:00.000Z",
  });

  it("returns nothing when nothing is blocked", () => {
    expect(deriveAgentWaitStates({ tasks: [], agents: [], requests: [] })).toEqual([]);
  });

  it("claims no wait for detached work — it blocks nobody", () => {
    // Claude backgrounding returns the tool call immediately and the turn
    // carries on, so a backgrounded shell is not a dependency.
    expect(
      deriveAgentWaitStates({
        tasks: [{ ...task("t1", "npm run dev", null), backgrounded: true }],
        agents: [],
        requests: [],
      }),
    ).toEqual([]);
  });

  it("does not claim a detached agent blocks main", () => {
    expect(
      deriveAgentWaitStates({
        tasks: [],
        agents: [agent("a1", "Reviewer", "running")],
        requests: [],
        detachedIds: new Set(["a1"]),
      }),
    ).toEqual([]);
  });

  it("claims no main wait once the turn has settled", () => {
    // Whatever is still alive outlived the turn; Tasks reports it without
    // asserting that main is blocked on it.
    expect(
      deriveAgentWaitStates({
        tasks: [task("t1", "pnpm test", null)],
        agents: [agent("a1", "Reviewer", "running")],
        requests: [],
        mainTurnActive: false,
      }),
    ).toEqual([]);
  });

  it("still surfaces an open request when no turn is running", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [],
      requests: [
        {
          requestId: "r1",
          kind: "approval",
          label: "Command approval",
          since: "2026-09-03T10:09:00.000Z",
          ownerId: null,
        },
      ],
      mainTurnActive: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "approval", needsUser: true });
  });

  it("times a named agent wait from when the wait began", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [agent("a1", "Reviewer", "waiting")],
      requests: [],
      agentWaitReasons: new Map([
        ["a1", { reason: "approval" as const, since: "2026-09-03T10:39:00.000Z" }],
      ]),
    });
    // Main is legitimately blocked on the agent (row 0); the agent's own
    // named wait carries the wait's start, not the agent's.
    const agentRow = rows.find((row) => row.ownerId === "a1");
    expect(agentRow?.since).toBe("2026-09-03T10:39:00.000Z");
  });

  it("puts an open approval ahead of running work on the main line", () => {
    const rows = deriveAgentWaitStates({
      tasks: [task("t1", "pnpm test", null)],
      agents: [agent("a1", "Reviewer", "running")],
      requests: [
        {
          requestId: "r1",
          kind: "approval",
          label: "Command approval",
          since: "2026-09-03T10:09:00.000Z",
          ownerId: null,
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      ownerId: null,
      kind: "approval",
      label: "Command approval",
      needsUser: true,
    });
  });

  it("names the agents main is waiting on", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [agent("a1", "Reviewer", "running"), agent("a2", "Merger", "running")],
      requests: [],
    });
    expect(rows[0]).toMatchObject({
      ownerId: null,
      kind: "agents",
      label: "Reviewer + 1 more agent",
    });
    expect(rows[0]?.blockingIds).toEqual(["a1", "a2"]);
  });

  it("falls back to main's own tasks when no agent is running", () => {
    const rows = deriveAgentWaitStates({
      tasks: [task("t1", "pnpm test", null)],
      agents: [],
      requests: [],
    });
    expect(rows[0]).toMatchObject({ ownerId: null, kind: "tasks", label: "pnpm test" });
  });

  it("gives each active agent its own line for its own background work", () => {
    const rows = deriveAgentWaitStates({
      tasks: [task("t1", "cargo build", "a1")],
      agents: [agent("a1", "Reviewer", "running")],
      requests: [],
    });
    expect(rows.map((row) => row.ownerId)).toEqual([null, "a1"]);
    expect(rows[1]).toMatchObject({ ownerLabel: "Reviewer", kind: "tasks", label: "cargo build" });
  });

  it("prefers a provider-named wait reason over the agent's own tasks", () => {
    const rows = deriveAgentWaitStates({
      tasks: [task("t1", "cargo build", "a1")],
      agents: [agent("a1", "Reviewer", "waiting")],
      requests: [],
      agentWaitReasons: new Map([
        ["a1", { reason: "user-input" as const, since: "2026-09-03T10:30:00.000Z" }],
      ]),
    });
    expect(rows[1]).toMatchObject({ ownerId: "a1", kind: "user-input", needsUser: true });
  });

  it("claims no wait for a shell that outlived the agent that launched it", () => {
    // The owner has finished, so it is not waiting on anything. The task is
    // still listed under that owner in the Tasks section; asserting a wait
    // would invent a blocked agent that no longer exists.
    expect(
      deriveAgentWaitStates({
        tasks: [task("t1", "tail -f log", "a1")],
        agents: [agent("a1", "Reviewer", "completed")],
        requests: [],
      }),
    ).toEqual([]);
  });

  it("does not attribute a settled task to anyone", () => {
    expect(
      deriveAgentWaitStates({
        tasks: [task("t1", "pnpm test", null, "completed")],
        agents: [],
        requests: [],
      }),
    ).toEqual([]);
  });
});

describe("deriveBackgroundTasksPanelModel", () => {
  const make = (
    id: string,
    ownerAgentId: string | null,
    status: RuntimeBackgroundTask["status"],
    extra: Partial<RuntimeBackgroundTask> = {},
  ): RuntimeBackgroundTask => ({
    id,
    kind: "shell",
    taskType: "local_bash",
    label: id,
    command: null,
    server: null,
    tool: null,
    ownerAgentId,
    status,
    startedAt: "2026-09-03T10:00:00.000Z",
    endedAt: null,
    progress: null,
    result: null,
    error: null,
    backgrounded: false,
    ambient: false,
    firstSeenAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    ...extra,
  });

  it("is empty for no tasks", () => {
    expect(deriveBackgroundTasksPanelModel({ tasks: [] }).hasTasks).toBe(false);
  });

  it("keeps failures visible and collapses successes", () => {
    const model = deriveBackgroundTasksPanelModel({
      tasks: [
        make("live", null, "running"),
        make("bad", null, "failed"),
        make("good", null, "completed"),
        make("gone", null, "cancelled"),
      ],
    });
    expect(model.groups[0]?.tasks.map((task) => task.id)).toEqual(["live", "bad"]);
    expect(model.finished.map((entry) => entry.task.id)).toEqual(["good", "gone"]);
    expect(model.activeCount).toBe(1);
    expect(model.failedCount).toBe(1);
    expect(model.totalCount).toBe(4);
  });

  it("groups by owner with main first and names owners from the roster", () => {
    const model = deriveBackgroundTasksPanelModel({
      tasks: [
        make("t1", "a2", "running"),
        make("t2", null, "running"),
        make("t3", "a1", "running"),
      ],
      agentTitles: new Map([
        ["a1", "Reviewer"],
        ["a2", "Merger"],
      ]),
    });
    expect(model.groups.map((group) => group.ownerLabel)).toEqual(["Main", "Merger", "Reviewer"]);
  });

  it("falls back to the owner id when the agent aged out of the roster", () => {
    const model = deriveBackgroundTasksPanelModel({ tasks: [make("t1", "ghost", "running")] });
    expect(model.groups[0]?.ownerLabel).toBe("ghost");
  });

  it("sorts live work above failures and ambient housekeeping last", () => {
    const model = deriveBackgroundTasksPanelModel({
      tasks: [
        make("ambient", null, "running", { ambient: true }),
        make("bad", null, "failed"),
        make("live", null, "running"),
      ],
    });
    expect(model.groups[0]?.tasks.map((task) => task.id)).toEqual(["live", "bad", "ambient"]);
    expect(model.groups[0]?.activeCount).toBe(2);
  });
});

describe("elapsed formatting", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsedDuration(9)).toBe("9s");
    expect(formatElapsedDuration(63)).toBe("1m 03s");
    expect(formatElapsedDuration(3600 * 2 + 60 * 14)).toBe("2h 14m");
    expect(formatElapsedDuration(-5)).toBe("0s");
  });

  it("measures to now when there is no end, and to the end when there is", () => {
    const now = Date.parse("2026-09-03T10:42:00.000Z");
    expect(formatElapsedBetween("2026-09-03T10:00:00.000Z", null, now)).toBe("42m 00s");
    expect(formatElapsedBetween("2026-09-03T10:00:00.000Z", "2026-09-03T10:00:05.000Z", now)).toBe(
      "5s",
    );
  });

  it("renders nothing for an unparseable timestamp", () => {
    expect(formatElapsedBetween("not-a-date", null, 0)).toBe("");
  });
});

describe("status predicates", () => {
  it("splits active from terminal, with idle in neither", () => {
    expect(isActiveBackgroundTaskStatus("running")).toBe(true);
    expect(isActiveBackgroundTaskStatus("waiting")).toBe(true);
    expect(isActiveBackgroundTaskStatus("idle")).toBe(false);
    expect(isTerminalBackgroundTaskStatus("idle")).toBe(false);
    expect(isTerminalBackgroundTaskStatus("interrupted")).toBe(true);
  });
});

describe("fold exclusivity with the subagent fold", () => {
  /**
   * The two folds must partition one stream. Per-row stickiness was not
   * enough: a legacy unstamped start claimed the task here while a later
   * stamped agent row claimed it in the subagent fold, showing one task in
   * both sections.
   */
  it("yields a task id to the subagent fold when a row shows real agent evidence", () => {
    const rows = [
      legacyActivity("task.started", { taskId: "amb-1", detail: "unstamped legacy start" }),
      // A real agent row repeats its linkage — taskType and role — which is
      // what makes the stamp trustworthy.
      activity("task.progress", {
        taskId: "amb-1",
        taskType: "local_agent",
        role: "reviewer",
        summary: "thinking",
      }),
    ];
    expect(foldBackgroundTasks(rows)).toEqual([]);
    expect(foldSubagentActivities(rows).map((agent) => agent.id)).toEqual(["amb-1"]);
  });

  it("keeps a purely background task id out of the subagent fold", () => {
    const rows = [
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
      activity("task.completed", { taskId: "sh-1", taskType: "local_bash", status: "completed" }),
    ];
    expect(foldBackgroundTasks(rows).map((task) => task.id)).toEqual(["sh-1"]);
    expect(foldSubagentActivities(rows)).toEqual([]);
  });

  it("never lists the same id in both folds across a mixed stream", () => {
    const rows = [
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "shell" }),
      activity("task.started", { taskId: "ag-1", taskType: "local_agent", title: "Reviewer" }),
      legacyActivity("task.started", { taskId: "old-1", detail: "legacy" }),
      activity("task.progress", { taskId: "ag-1", agentKind: "agent", summary: "working" }),
    ];
    const background = new Set(foldBackgroundTasks(rows).map((task) => task.id));
    const agents = new Set(foldSubagentActivities(rows).map((agent) => agent.id));
    expect([...background].filter((id) => agents.has(id))).toEqual([]);
    expect(background).toEqual(new Set(["sh-1", "old-1"]));
    expect(agents).toEqual(new Set(["ag-1"]));
  });
});

describe("foldBackgroundTasks timing", () => {
  it("gives a progress-only task an origin so its timer is not blank", () => {
    const tasks = foldBackgroundTasks([
      activity("task.progress", {
        taskId: "sh-1",
        taskType: "local_bash",
        summary: "still running",
      }),
    ]);
    expect(byId(tasks, "sh-1").startedAt).not.toBeNull();
  });

  it("times a restarted task from its new run, not the original start", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "m-1", taskType: "monitor" }, "2026-09-03T10:00:00.000Z"),
      activity(
        "task.completed",
        { taskId: "m-1", taskType: "monitor", status: "completed" },
        "2026-09-03T10:05:00.000Z",
      ),
      activity(
        "task.updated",
        { taskId: "m-1", taskType: "monitor", status: "running" },
        "2026-09-03T11:00:00.000Z",
      ),
    ]);
    expect(byId(tasks, "m-1").startedAt).toBe("2026-09-03T11:00:00.000Z");
    expect(byId(tasks, "m-1").endedAt).toBeNull();
  });

  it("keeps the first terminal outcome when two terminal rows disagree", () => {
    const viaUpdate = foldBackgroundTasks([
      activity("task.started", { taskId: "a", taskType: "shell" }),
      activity("task.updated", { taskId: "a", taskType: "shell", status: "failed" }),
      activity("task.updated", { taskId: "a", taskType: "shell", status: "cancelled" }),
    ]);
    expect(byId(viaUpdate, "a").status).toBe("failed");

    // The same precedence regardless of which event kind arrives second.
    const viaCompleted = foldBackgroundTasks([
      activity("task.started", { taskId: "b", taskType: "shell" }),
      activity("task.updated", { taskId: "b", taskType: "shell", status: "failed" }),
      activity("task.completed", { taskId: "b", taskType: "shell", status: "completed" }),
    ]);
    expect(byId(viaCompleted, "b").status).toBe("failed");
  });

  it("keeps live work and failures when far more than the cap arrives", () => {
    const rows = [];
    for (let index = 0; index < 260; index += 1) {
      rows.push(
        activity(
          "task.started",
          { taskId: `idle-${index}`, taskType: "monitor" },
          `2026-09-03T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
        ),
        activity("task.updated", { taskId: `idle-${index}`, taskType: "monitor", status: "idle" }),
      );
    }
    rows.push(
      activity("task.started", { taskId: "live-1", taskType: "local_bash", detail: "server" }),
      activity("task.started", { taskId: "bad-1", taskType: "local_bash", detail: "build" }),
      activity("task.updated", { taskId: "bad-1", taskType: "local_bash", status: "failed" }),
    );
    const tasks = foldBackgroundTasks(rows);
    const ids = new Set(tasks.map((task) => task.id));
    expect(ids.has("live-1")).toBe(true);
    expect(ids.has("bad-1")).toBe(true);
    expect(tasks.length).toBeLessThanOrEqual(200);
  });
});

describe("deriveDetachedTaskIds", () => {
  it("tracks detachment and undetachment", () => {
    expect(
      deriveDetachedTaskIds([activity("task.updated", { taskId: "t1", isBackgrounded: true })]).has(
        "t1",
      ),
    ).toBe(true);
    expect(
      deriveDetachedTaskIds([
        activity("task.updated", { taskId: "t1", isBackgrounded: true }),
        activity("task.updated", { taskId: "t1", isBackgrounded: false }),
      ]).has("t1"),
    ).toBe(false);
  });

  it("treats provider-synthesized child agents as asynchronous", () => {
    // Codex spawnAgent returns immediately; only its separate wait tool
    // blocks, and nothing on the wire reports that call. agentPath is what
    // marks a Codex child (see the detachment-marker suite).
    expect(
      deriveDetachedTaskIds([
        activity("task.updated", {
          taskId: "c1",
          timelineBypass: true,
          agentPath: "/root/audit",
          status: "running",
        }),
      ]).has("c1"),
    ).toBe(true);
  });

  it("clears the folded flag when a task is undetached", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "dev" }),
      activity("task.updated", { taskId: "sh-1", taskType: "local_bash", isBackgrounded: true }),
      activity("task.updated", { taskId: "sh-1", taskType: "local_bash", isBackgrounded: false }),
    ]);
    expect(byId(tasks, "sh-1").backgrounded).toBe(false);
  });
});

describe("deriveOpenRequestWaits failure handling", () => {
  it("keeps the request open when the response failed for a transient reason", () => {
    const open = deriveOpenRequestWaits([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }),
      activity("provider.approval.respond.failed", {
        requestId: "r1",
        detail: "WebSocket closed before the reply was delivered",
      }),
    ]);
    // The answer card is still on screen; the strip must not disappear.
    expect(open.map((request) => request.requestId)).toEqual(["r1"]);
  });

  it("closes it only when the provider says it no longer knows the request", () => {
    const open = deriveOpenRequestWaits([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }),
      activity("provider.approval.respond.failed", {
        requestId: "r1",
        detail: "Unknown pending approval request r1",
      }),
    ]);
    expect(open).toEqual([]);
  });
});

describe("evidence-based classification", () => {
  /**
   * A reconnect drops the adapter's remembered linkage, so a terminal
   * notification can arrive carrying only taskId + status.
   * classifyTaskAgentKind defaults those to "agent". That evidence-free stamp
   * must not flip a shell we already know about, or the task would vanish
   * from the panel exactly when it finished.
   */
  it("keeps a known background task when a thin terminal row is stamped agent", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
      {
        ...activity("task.completed", { taskId: "sh-1", status: "completed" }),
        payload: { taskId: "sh-1", status: "completed", agentKind: "agent" },
      } as OrchestrationThreadActivity,
    ]);
    expect(byId(tasks, "sh-1").status).toBe("completed");
  });

  it("claims nothing for a task id that never describes itself", () => {
    // No start row and no descriptive field: there is no evidence it is
    // background work, so it is left to the roster rather than duplicated.
    expect(
      foldBackgroundTasks([
        {
          ...activity("task.completed", { taskId: "orphan", status: "completed" }),
          payload: { taskId: "orphan", status: "completed", agentKind: "agent" },
        } as OrchestrationThreadActivity,
      ]),
    ).toEqual([]);
  });
});

describe("resuming an idle task", () => {
  it("times the new run rather than spanning the idle gap", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "m-1", taskType: "monitor" }, "2026-09-03T10:00:00.000Z"),
      activity(
        "task.updated",
        { taskId: "m-1", taskType: "monitor", status: "idle" },
        "2026-09-03T10:01:00.000Z",
      ),
      activity(
        "task.updated",
        { taskId: "m-1", taskType: "monitor", status: "running" },
        "2026-09-03T11:30:00.000Z",
      ),
    ]);
    expect(byId(tasks, "m-1").startedAt).toBe("2026-09-03T11:30:00.000Z");
  });
});

describe("Codex child agents do not block main", () => {
  it("claims no main wait for an active provider-async child", () => {
    expect(
      deriveAgentWaitStates({
        tasks: [],
        agents: [
          { id: "c1", title: "math_one", status: "running", startedAt: "2026-09-03T10:00:00.000Z" },
        ],
        requests: [],
        detachedIds: new Set(["c1"]),
      }),
    ).toEqual([]);
  });

  it("still reports that child's own named wait", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        { id: "c1", title: "math_one", status: "waiting", startedAt: "2026-09-03T10:00:00.000Z" },
      ],
      requests: [],
      detachedIds: new Set(["c1"]),
      agentWaitReasons: new Map([
        ["c1", { reason: "approval" as const, since: "2026-09-03T10:20:00.000Z" }],
      ]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: "c1", kind: "approval", needsUser: true });
  });
});

describe("request ownership", () => {
  it("attributes a request to the child that raised it, not to main", () => {
    const open = deriveOpenRequestWaits([
      activity("approval.requested", {
        requestId: "r1",
        requestKind: "command",
        agentId: "child-1",
      }),
    ]);
    expect(open[0]?.ownerId).toBe("child-1");
  });

  it("leaves an unattributed request with the main agent", () => {
    const open = deriveOpenRequestWaits([
      activity("approval.requested", { requestId: "r1", requestKind: "command" }),
    ]);
    expect(open[0]?.ownerId).toBeNull();
  });

  it("does not claim main is blocked when only a detached child is asking", () => {
    // The child raised the approval; main is free. Reporting both
    // "Main <- Command approval" and "child <- Approval" was a false line.
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        { id: "c1", title: "math_one", status: "waiting", startedAt: "2026-09-03T10:00:00.000Z" },
      ],
      requests: [
        {
          requestId: "r1",
          kind: "approval",
          label: "Command approval",
          since: "2026-09-03T10:20:00.000Z",
          ownerId: "c1",
        },
      ],
      detachedIds: new Set(["c1"]),
      mainTurnActive: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: "c1", ownerLabel: "math_one", needsUser: true });
  });

  it("shows every simultaneous request instead of only the first", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [],
      requests: [
        {
          requestId: "r1",
          kind: "approval",
          label: "Command approval",
          since: "2026-09-03T10:00:00.000Z",
          ownerId: null,
        },
        {
          requestId: "r2",
          kind: "approval",
          label: "File-change approval",
          since: "2026-09-03T10:01:00.000Z",
          ownerId: null,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Command approval + 1 more request");
    expect(rows[0]?.since).toBe("2026-09-03T10:00:00.000Z");
  });
});

describe("detachment marker", () => {
  it("does not treat a Claude workflow member as asynchronous", () => {
    // Claude stamps timelineBypass on workflow members purely to keep
    // synthetic rows out of the parent timeline; a coordinator does block
    // its parent. Only Codex children carry agentPath.
    expect(
      deriveDetachedTaskIds([
        activity("task.updated", {
          taskId: "wf-member",
          timelineBypass: true,
          workflowName: "spec",
          status: "running",
        }),
      ]).has("wf-member"),
    ).toBe(false);
    expect(
      deriveDetachedTaskIds([
        activity("task.updated", {
          taskId: "codex-child",
          timelineBypass: true,
          agentPath: "/root/audit",
          status: "running",
        }),
      ]).has("codex-child"),
    ).toBe(true);
  });
});

describe("terminal then idle", () => {
  it("ignores a late idle row instead of leaving a settled task inconsistent", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "build" }),
      activity("task.completed", {
        taskId: "sh-1",
        taskType: "local_bash",
        status: "completed",
        summary: "built",
      }),
      activity("task.updated", { taskId: "sh-1", taskType: "local_bash", status: "idle" }),
    ]);
    const task = byId(tasks, "sh-1");
    expect(task.status).toBe("completed");
    expect(task.result).toBe("built");
    expect(task.endedAt).not.toBeNull();
  });
});

describe("tasks registered in the background at start", () => {
  /**
   * The CLI sets is_backgrounded on task_started for local_agent and
   * local_bash tasks, and a resumed subagent is ALWAYS registered
   * backgrounded. Those never send a later task_updated patch, so reading
   * detachment only from the patch reported them as blocking main while main
   * was demonstrably free.
   */
  it("marks a task detached from its start row alone", () => {
    const rows = [
      activity("task.started", {
        taskId: "sh-1",
        taskType: "local_bash",
        detail: "pnpm test --watch",
        isBackgrounded: true,
      }),
    ];
    expect(byId(foldBackgroundTasks(rows), "sh-1").backgrounded).toBe(true);
    expect(deriveDetachedTaskIds(rows).has("sh-1")).toBe(true);
  });

  it("claims no main wait for a lane backgrounded at start and never patched", () => {
    const rows = [
      activity("task.started", {
        taskId: "lane-1",
        taskType: "local_agent",
        title: "merge-upstream",
        isBackgrounded: true,
      }),
    ];
    expect(
      deriveAgentWaitStates({
        tasks: [],
        agents: [
          {
            id: "lane-1",
            title: "merge-upstream",
            status: "running",
            startedAt: "2026-09-04T10:00:00.000Z",
          },
        ],
        requests: [],
        detachedIds: deriveDetachedTaskIds(rows),
        mainTurnActive: true,
      }),
    ).toEqual([]);
  });
});

describe("workflow members block their coordinator", () => {
  const member = (id: string, title: string) => ({
    id,
    title,
    status: "running" as const,
    startedAt: "2026-09-04T10:00:00.000Z",
    parentAgentId: "wf-1",
  });

  it("keeps members out of main's line and gives the coordinator its own", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        {
          id: "wf-1",
          title: "Spec",
          status: "running",
          startedAt: "2026-09-04T09:59:00.000Z",
          parentAgentId: null,
        },
        member("m-1", "writer"),
        member("m-2", "checker"),
        member("m-3", "linter"),
      ],
      requests: [],
      mainTurnActive: true,
    });

    const mainRow = rows.find((row) => row.ownerId === null);
    // Main waits on the coordinator only — not "Spec + 3 more agents".
    expect(mainRow?.label).toBe("Spec");
    expect(mainRow?.blockingIds).toEqual(["wf-1"]);

    const coordinatorRow = rows.find((row) => row.ownerId === "wf-1");
    expect(coordinatorRow?.kind).toBe("agents");
    expect(coordinatorRow?.label).toBe("writer + 2 more agents");
    expect(coordinatorRow?.blockingIds).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("still treats an agent whose parent is not in the roster as top level", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        {
          id: "orphan",
          title: "Stray",
          status: "running",
          startedAt: "2026-09-04T10:00:00.000Z",
          parentAgentId: "gone",
        },
      ],
      requests: [],
      mainTurnActive: true,
    });
    expect(rows[0]).toMatchObject({ ownerId: null, label: "Stray" });
  });
});

describe("requests with an unresolvable owner", () => {
  it("falls back to the main line instead of vanishing", () => {
    // An owner that aged out of the roster cap would otherwise land in a
    // bucket that never renders, hiding an approval only the user can answer.
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [],
      requests: [
        {
          requestId: "r1",
          kind: "approval",
          label: "Command approval",
          since: "2026-09-04T10:00:00.000Z",
          ownerId: "ghost-agent",
        },
      ],
      mainTurnActive: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: null, ownerLabel: "Main", needsUser: true });
  });
});

describe("named wait outranks a coordinator's running members", () => {
  /**
   * Precedence is by who can unblock it. A coordinator that is `waiting` on an
   * approval while its members keep working is stuck, not busy: reporting the
   * members read as quiet machine progress and hid the one line the user had
   * to act on.
   */
  it("reports the approval, not the members still running under it", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        {
          id: "wf-1",
          title: "Spec",
          status: "waiting",
          startedAt: "2026-09-04T09:59:00.000Z",
          parentAgentId: null,
        },
        {
          id: "m-1",
          title: "writer",
          status: "running",
          startedAt: "2026-09-04T10:00:00.000Z",
          parentAgentId: "wf-1",
        },
        {
          id: "m-2",
          title: "checker",
          status: "running",
          startedAt: "2026-09-04T10:00:00.000Z",
          parentAgentId: "wf-1",
        },
      ],
      requests: [],
      agentWaitReasons: new Map([
        ["wf-1", { reason: "approval" as const, since: "2026-09-04T10:30:00.000Z" }],
      ]),
      mainTurnActive: true,
    });

    const coordinatorRow = rows.find((row) => row.ownerId === "wf-1");
    expect(coordinatorRow).toMatchObject({
      kind: "approval",
      label: "Approval",
      needsUser: true,
      since: "2026-09-04T10:30:00.000Z",
    });
    // Exactly one line for the coordinator: the members must not add a second.
    expect(rows.filter((row) => row.ownerId === "wf-1")).toHaveLength(1);
  });

  it("still reports the members when the coordinator names no wait", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        {
          id: "wf-1",
          title: "Spec",
          status: "running",
          startedAt: "2026-09-04T09:59:00.000Z",
          parentAgentId: null,
        },
        {
          id: "m-1",
          title: "writer",
          status: "running",
          startedAt: "2026-09-04T10:00:00.000Z",
          parentAgentId: "wf-1",
        },
      ],
      requests: [],
      mainTurnActive: true,
    });
    expect(rows.find((row) => row.ownerId === "wf-1")).toMatchObject({
      kind: "agents",
      label: "writer",
      needsUser: false,
    });
  });
});

describe("one surface, never both (mixed resumed stream)", () => {
  /**
   * The exact sequence that used to double-list a task, in arrival order:
   *
   * 1. the shell starts and is fully described (pre-restart);
   * 2. the server restarts, so its task registry is empty;
   * 3. the shell finishes — the notification carries only taskId + status,
   *    and ingestion's classifier defaults a type-less row to "agent";
   * 4. the roster snapshot that repairs identity arrives AFTER that.
   *
   * Step 3 used to be enough for the roster fold to build a phantom agent,
   * while this fold rightly kept the real shell. Membership is now decided
   * once for the whole id, so exactly one surface claims it.
   */
  const resumedStream = (): ReadonlyArray<OrchestrationThreadActivity> => [
    activity("task.started", {
      taskId: "sh-9",
      taskType: "local_bash",
      detail: "pnpm test --watch",
      command: "pnpm test --watch",
    }),
    {
      ...activity("task.completed", { taskId: "sh-9", status: "completed" }),
      payload: { taskId: "sh-9", status: "completed", agentKind: "agent" },
    } as OrchestrationThreadActivity,
    // The adapter's roster repair, arriving late.
    activity("task.updated", {
      taskId: "sh-9",
      taskType: "local_bash",
      title: "pnpm test --watch",
      command: "pnpm test --watch",
    }),
  ];

  it("renders the task in Tasks", () => {
    const tasks = foldBackgroundTasks(resumedStream());
    expect(tasks.map((task) => task.id)).toEqual(["sh-9"]);
    expect(byId(tasks, "sh-9").status).toBe("completed");
  });

  it("builds no phantom agent for it in the roster", () => {
    expect(foldSubagentActivities(resumedStream()).map((agent) => agent.id)).toEqual([]);
  });

  it("still keeps a real subagent out of Tasks in the same stream", () => {
    const stream = [
      ...resumedStream(),
      activity("task.started", { taskId: "ag-1", taskType: "local_agent", role: "reviewer" }),
      {
        ...activity("task.completed", { taskId: "ag-1", status: "completed" }),
        payload: { taskId: "ag-1", status: "completed", agentKind: "agent" },
      } as OrchestrationThreadActivity,
    ];
    expect(foldBackgroundTasks(stream).map((task) => task.id)).toEqual(["sh-9"]);
    expect(foldSubagentActivities(stream).map((agent) => agent.id)).toEqual(["ag-1"]);
  });
});

describe("task detail recovered from the launching call", () => {
  it("leads a shell row with its command line, not the humanized description", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", {
        taskId: "sh-2",
        taskType: "local_bash",
        detail: "Running the test suite",
        command: "pnpm vitest run packages/client-runtime",
      }),
    ]);
    expect(byId(tasks, "sh-2").label).toBe("pnpm vitest run packages/client-runtime");
    expect(byId(tasks, "sh-2").command).toBe("pnpm vitest run packages/client-runtime");
  });

  it("takes the command even when it arrives after the description", () => {
    // The launching call is only read at task_started; a resumed task
    // recovers its command from a later snapshot repair.
    const tasks = foldBackgroundTasks([
      activity("task.progress", { taskId: "sh-3", taskType: "local_bash", detail: "Running" }),
      activity("task.updated", { taskId: "sh-3", taskType: "local_bash", command: "cargo watch" }),
    ]);
    expect(byId(tasks, "sh-3").label).toBe("cargo watch");
  });

  it("names a monitor by its MCP server and tool", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", {
        taskId: "mon-1",
        taskType: "monitor_mcp",
        detail: "github/list_issues",
        server: "github",
        tool: "list_issues",
      }),
    ]);
    expect(backgroundTaskSourceLabel(byId(tasks, "mon-1"))).toBe("github · list_issues");
    expect(byId(tasks, "mon-1").kind).toBe("monitor");
  });

  it("says what it can when only half the pair was recovered", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "mon-2", taskType: "mcp_task", server: "github" }),
    ]);
    expect(backgroundTaskSourceLabel(byId(tasks, "mon-2"))).toBe("github");
  });

  it("has no source label for an ordinary shell", () => {
    const tasks = foldBackgroundTasks([
      activity("task.started", { taskId: "sh-4", taskType: "local_bash", detail: "ls" }),
    ]);
    expect(backgroundTaskSourceLabel(byId(tasks, "sh-4"))).toBe(null);
  });

  it("classifies the CLI's remaining background task types as background", () => {
    // mcp_task / monitor_ws / auto_mode_scan used to fall through the agent
    // default and land a watch loop in the subagent roster.
    for (const taskType of ["mcp_task", "monitor_ws", "auto_mode_scan"]) {
      const stream = [activity("task.started", { taskId: taskType, taskType, detail: taskType })];
      expect(foldBackgroundTasks(stream).map((task) => task.id)).toEqual([taskType]);
      expect(foldSubagentActivities(stream)).toEqual([]);
    }
  });
});

describe("the compacting wait", () => {
  const compactingRow = (compacting: boolean, at: string): OrchestrationThreadActivity =>
    ({
      id: "session-compacting:t-1",
      tone: "info",
      kind: "session.compacting",
      summary: compacting ? "Compacting context" : "Context compaction finished",
      payload: { compacting },
      turnId: null,
      createdAt: at,
    }) as unknown as OrchestrationThreadActivity;

  it("reports when compaction began", () => {
    expect(deriveCompactingSince([compactingRow(true, "2026-09-04T10:00:00.000Z")])).toBe(
      "2026-09-04T10:00:00.000Z",
    );
  });

  it("reports nothing once compaction has ended", () => {
    expect(
      deriveCompactingSince([
        compactingRow(true, "2026-09-04T10:00:00.000Z"),
        compactingRow(false, "2026-09-04T10:00:20.000Z"),
      ]),
    ).toBe(null);
  });

  it("reports nothing for a thread that never compacted", () => {
    expect(deriveCompactingSince([activity("task.started", { taskId: "sh-1" })])).toBe(null);
  });

  it("prints a machine wait on main for the whole compaction", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [],
      requests: [],
      compactingSince: "2026-09-04T10:00:00.000Z",
      // Compaction between turns is exactly when a reader needs telling.
      mainTurnActive: false,
    });
    expect(rows).toEqual([
      {
        ownerId: null,
        ownerLabel: "Main",
        kind: "compacting",
        label: "Compacting context",
        since: "2026-09-04T10:00:00.000Z",
        blockingIds: [],
        needsUser: false,
      },
    ]);
  });

  it("yields to an open request, which only the user can clear", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [],
      requests: [
        {
          requestId: "r1",
          kind: "approval",
          label: "Command approval",
          since: "2026-09-04T10:00:10.000Z",
          ownerId: null,
        },
      ],
      compactingSince: "2026-09-04T10:00:00.000Z",
      mainTurnActive: true,
    });
    expect(rows.map((row) => row.kind)).toEqual(["approval"]);
  });

  it("outranks the machine work still running under main", () => {
    const rows = deriveAgentWaitStates({
      tasks: [],
      agents: [
        {
          id: "ag-1",
          title: "Reviewer",
          status: "running",
          startedAt: "2026-09-04T10:00:00.000Z",
          parentAgentId: null,
        },
      ],
      requests: [],
      compactingSince: "2026-09-04T10:00:05.000Z",
      mainTurnActive: true,
    });
    expect(rows.filter((row) => row.ownerId === null).map((row) => row.kind)).toEqual([
      "compacting",
    ]);
  });
});
