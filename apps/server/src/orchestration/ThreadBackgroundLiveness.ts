/**
 * ThreadBackgroundLivenessService - in-memory per-thread background liveness
 * for the sidebar status pill.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * "monitoring" is reserved for watch loops (monitor tasks and background
 * shells) when they are the ONLY live work; any agent work presents as
 * "working".
 *
 * @module ThreadBackgroundLivenessService
 */
import {
  EventId,
  INERT_TASK_TYPES,
  MONITOR_TASK_TYPES,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

/** The persisted activity kinds that feed the registry: `task.<transition>`. */
export const TASK_LIFECYCLE_ACTIVITY_KINDS = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
] as const;

type TaskLifecycleTransition = "started" | "progress" | "updated" | "completed";

/** A task the registry still counts as live, with the bucket it landed in. */
export interface LiveTask {
  readonly taskId: string;
  readonly agentKind: "agent" | "background";
}

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

// Classification sets are the shared contracts copies (MONITOR_TASK_TYPES:
// watch loops — monitor tasks plus background shells, which in practice are
// PR babysitting/log tails since pacing sleeps complete inside the turn;
// INERT_TASK_TYPES: plan-mode bookkeeping) so this registry, ingestion's
// agentKind stamp, and the client fold can never drift apart.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Feed one task lifecycle transition. taskType may be absent on
     * synthesized rows (workflow members, Codex children) — those count as
     * agents. agentId marks a task launched from inside a subagent: its
     * internal shells are covered by the owning agent's liveness, but a
     * NESTED AGENT (agentId + agent-flavored taskType) still counts — it
     * can outlive its parent and must keep the thread Working.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /** Tasks currently counted live for a thread (agents and monitors). */
    readonly listThreadLiveTasks: (threadId: string) => ReadonlyArray<LiveTask>;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without
  // a taskType may later reveal itself as a shell, become inert, or turn out
  // to be agent-owned. Every path drops any prior entry for the taskId so a
  // stale bucket assignment can't pin the thread's status (review finding).
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    recordTaskLiveness: (input) => {
      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        return;
      }
      // A subagent's internal non-agent work (its own shells/monitors) is
      // covered by the owning agent's liveness. Nested agents fall through:
      // they can outlive their parent (review finding).
      if (
        input.agentId !== undefined &&
        (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
      ) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Status-free progress and metadata updates are not restarts. A delayed
      // row after idle must not put the task back in the live set (#7128).
      if ((input.kind === "progress" || input.kind === "updated") && input.status === undefined) {
        const existing = stateByThreadId.get(input.threadId);
        const stillLive =
          existing !== undefined &&
          (existing.agents.has(input.taskId) || existing.monitors.has(input.taskId));
        if (!stillLive) {
          return;
        }
      }

      drop(input.threadId, input.taskId);
      const state = stateFor(input.threadId);
      const bucket =
        taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;
      bucket.add(input.taskId);
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    listThreadLiveTasks: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return [];
      }
      return [
        ...Array.from(state.agents, (taskId) => ({ taskId, agentKind: "agent" as const })),
        ...Array.from(state.monitors, (taskId) => ({ taskId, agentKind: "background" as const })),
      ];
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0) {
        return "working";
      }
      if (state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));

/**
 * Replays persisted task rows (ascending order) through a scratch registry
 * and returns what would still be live. The in-memory registry is empty after
 * a server restart, but the projection holds every transition, so startup
 * can still find the work an orphaned session left running.
 */
export function liveTasksFromActivities(
  threadId: string,
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyArray<LiveTask> {
  const liveness = make();
  for (const activity of activities) {
    if (!TASK_LIFECYCLE_ACTIVITY_KINDS.some((kind) => kind === activity.kind)) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : {};
    if (typeof payload.taskId !== "string") {
      continue;
    }
    liveness.recordTaskLiveness({
      threadId,
      taskId: payload.taskId,
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      status: typeof payload.status === "string" ? payload.status : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
      kind: activity.kind.slice("task.".length) as TaskLifecycleTransition,
    });
  }
  return liveness.listThreadLiveTasks(threadId);
}

/**
 * The terminal row a dead session owes each task it was still running. It is
 * stamped like every ingested task row (agentKind) so clients file it with
 * the task it settles instead of rendering it as a stray background row.
 * Without a persisted terminal row the Agents panel reads the task as running
 * again the moment the session resumes.
 */
export function interruptedTaskActivity(input: {
  readonly activityId: string;
  readonly task: LiveTask;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.activityId),
    createdAt: input.createdAt,
    tone: "info",
    kind: "task.updated",
    summary: "Task interrupted",
    payload: {
      taskId: input.task.taskId,
      status: "interrupted",
      agentKind: input.task.agentKind,
      detail: "The provider session ended before this task finished.",
    },
    turnId: input.turnId,
  };
}
