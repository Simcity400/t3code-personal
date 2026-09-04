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
 * The same live set also answers WHAT the thread is waiting on
 * (getThreadBackgroundWait). That is a strictly richer view of the identical
 * state — never a second source — so a surface that says "Waiting on …" and
 * one that only asks "is anything alive?" can never disagree.
 *
 * @module ThreadBackgroundLivenessService
 */
import {
  INERT_TASK_TYPES,
  MONITOR_TASK_TYPES,
  type ThreadBackgroundWait,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

type LiveTaskBucket = "agent" | "monitor";

interface LiveTask {
  readonly bucket: LiveTaskBucket;
  /** Whatever the provider called this work; null when it named nothing. */
  readonly label: string | null;
  /** When this run of the task began, for the elapsed timer. */
  readonly startedAt: string | null;
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

/** Long enough to identify a shell command line, short enough for a row. */
const WAIT_LABEL_MAX_LENGTH = 64;

/** Null for anything that would render as an empty name. */
function boundedLabel(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return null;
  if (trimmed.length <= WAIT_LABEL_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, WAIT_LABEL_MAX_LENGTH - 1)}…`;
}

/**
 * The one-line description of a thread's live background work.
 *
 * Deliberately generic: the leading name is whatever the provider called the
 * work, and everything else is a count. Nothing here knows what any
 * particular task does, so a new provider or a new task type reads correctly
 * without touching this function. Work the provider never named contributes
 * to the count only — a task id is an identifier, not a description.
 */
export function composeBackgroundWaitLabel(
  tasks: ReadonlyArray<Pick<LiveTask, "bucket" | "label">>,
): string {
  const noun = tasks.every((task) => task.bucket === "agent") ? "agent" : "task";
  const count = tasks.length;
  const plural = (value: number) => (value === 1 ? noun : `${noun}s`);
  const leading = tasks.find((task) => task.label !== null)?.label ?? null;
  if (leading === null) return `${count} ${plural(count)}`;
  if (count === 1) return leading;
  return `${leading} + ${count - 1} more ${plural(count - 1)}`;
}

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
     *
     * `label` and `at` only enrich what getThreadBackgroundWait can say; a
     * caller that omits them still drives liveness exactly as before.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
      /** Provider's own name for the work: agent title, command line, … */
      readonly label?: string | undefined;
      /** Event timestamp, used as the start of this run of the task. */
      readonly at?: string | undefined;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;

    /**
     * The same live set, described. Non-null exactly when
     * getThreadBackgroundLiveness is non-null.
     */
    readonly getThreadBackgroundWait: (threadId: string) => ThreadBackgroundWait | null;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(): ThreadBackgroundLivenessService["Service"] {
  // One entry per live task id. Insertion order is arrival order, which is
  // the tiebreak when several tasks share a start instant.
  const stateByThreadId = new Map<string, Map<string, LiveTask>>();

  const stateFor = (threadId: string): Map<string, LiveTask> => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, LiveTask>();
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
    state.delete(taskId);
    if (state.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  const liveTasks = (threadId: string): ReadonlyArray<LiveTask> => {
    const state = stateByThreadId.get(threadId);
    return state === undefined ? [] : [...state.values()];
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
      const previous = stateByThreadId.get(input.threadId)?.get(input.taskId);
      if ((input.kind === "progress" || input.kind === "updated") && input.status === undefined) {
        if (previous === undefined) {
          return;
        }
      }

      drop(input.threadId, input.taskId);
      const state = stateFor(input.threadId);
      state.set(input.taskId, {
        bucket: taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? "monitor" : "agent",
        // Fill-if-absent in both directions: a later thin row (a reconnect
        // drops the adapter's remembered linkage) must not blank a name the
        // start row already gave, and the first row that names the work wins
        // the elapsed anchor for this run of it.
        label: boundedLabel(input.label) ?? previous?.label ?? null,
        startedAt: previous?.startedAt ?? input.at ?? null,
      });
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    getThreadBackgroundLiveness: (threadId) => {
      const tasks = liveTasks(threadId);
      if (tasks.length === 0) {
        return null;
      }
      return tasks.some((task) => task.bucket === "agent") ? "working" : "monitoring";
    },

    getThreadBackgroundWait: (threadId) => {
      const tasks = liveTasks(threadId);
      if (tasks.length === 0) {
        return null;
      }
      // The longest-running item leads the label and anchors the timer: it is
      // the one that has held the thread up, and it keeps the line stable
      // while shorter work churns underneath it.
      const ordered = [...tasks].toSorted((left, right) => {
        if (left.startedAt === right.startedAt) return 0;
        if (left.startedAt === null) return 1;
        if (right.startedAt === null) return -1;
        return left.startedAt.localeCompare(right.startedAt);
      });
      return {
        count: ordered.length,
        label: composeBackgroundWaitLabel(ordered),
        since: ordered.find((task) => task.startedAt !== null)?.startedAt ?? null,
        monitorOnly: ordered.every((task) => task.bucket === "monitor"),
      };
    },
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));
