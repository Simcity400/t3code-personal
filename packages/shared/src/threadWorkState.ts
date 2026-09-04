/**
 * One thread-level answer to "is the agent working, or is it just waiting?".
 *
 * The distinction the whole app hangs on:
 *
 * - **working** — the thread's own turn is in flight. The agent is generating
 *   text or running a foreground tool call, and anything the user sends now
 *   joins that turn as a steer.
 * - **waiting** — the agent is producing nothing of its own. Two shapes: work
 *   it started is still alive (background shells, watch loops, workflows,
 *   subagents — anything the provider reports as a task), in which case a
 *   message starts a fresh turn immediately; or the provider is compacting its
 *   own context, in which case a message is accepted and answered once
 *   compaction ends. Either way nobody is waiting on the user.
 * - **idle** — nothing is live.
 *
 * Every input is a durable projection of the shell, not client-local state, so
 * every surface (sidebar, thread view, phone) reads the same answer and it
 * survives reload, resume and reconnect.
 *
 * Provider-neutral by construction: `backgroundWait` is filled from the shared
 * task lifecycle every adapter feeds, `compactingSince` from the shared
 * session lifecycle, and `session.status` likewise. A provider that reports no
 * tasks and no compaction simply never reaches `waiting`, which is the correct
 * reading of "nothing is known to be alive" rather than a special case.
 *
 * Connection states are deliberately NOT modelled here. "starting" is a
 * session coming up, not work; surfaces that show a Connecting state resolve
 * it themselves before consulting this. Nor does this gate the composer, which
 * reads `session.status` directly — during compaction that status is `running`
 * so the thread correctly refuses a fresh turn while still reading as waiting.
 */
import type { OrchestrationThreadShell, ThreadBackgroundWait } from "@t3tools/contracts";

export type ThreadWorkState = "working" | "waiting" | "idle";

export interface ThreadWorkStatus {
  readonly state: ThreadWorkState;
  /**
   * Ready-to-render status text: "Working" while a turn runs, "Waiting on
   * <what>" while the agent is producing nothing of its own, null when idle.
   * The <what> is the provider's own name for the work, never ours.
   */
  readonly label: string | null;
  /**
   * Instant the "Waiting on …" timer counts from — the longest-running live
   * item's start, or when compaction began. Null in every other state: a
   * working thread's elapsed time belongs to its turn, which surfaces already
   * resolve from `latestTurn`.
   */
  readonly since: string | null;
  /**
   * Waiting only, and only on watch loops. A monitor can outlive every turn,
   * so a surface that must eventually declare the thread finished treats this
   * as idle instead of waiting forever. Compaction is never monitor-only: it
   * always ends.
   */
  readonly monitorOnly: boolean;
}

export type ThreadWorkStateInput = Pick<OrchestrationThreadShell, "session"> & {
  readonly backgroundWait?: ThreadBackgroundWait | null | undefined;
  readonly compactingSince?: string | null | undefined;
};

const IDLE: ThreadWorkStatus = { state: "idle", label: null, since: null, monitorOnly: false };

/** What the "Waiting on …" line calls provider-side context compaction. */
export const COMPACTING_WAIT_SUBJECT = "context compaction";

/** "Waiting on 3 tasks", "Waiting on Reviewer + 2 more agents", … */
export function formatThreadWaitLabel(wait: ThreadBackgroundWait): string {
  return `Waiting on ${wait.label}`;
}

export function resolveThreadWorkState(thread: ThreadWorkStateInput): ThreadWorkStatus {
  // Compaction outranks everything, including the running session it reports
  // itself through: it is the one long pause nothing else here explains, and
  // during it the agent is demonstrably not generating. Naming it is the whole
  // difference between a thread that looks hung and one that says why.
  if (thread.compactingSince != null) {
    return {
      state: "waiting",
      label: `Waiting on ${COMPACTING_WAIT_SUBJECT}`,
      since: thread.compactingSince,
      monitorOnly: false,
    };
  }
  // Otherwise a running session is the agent's own turn, whatever else is
  // alive underneath it: a turn that spawned five agents and is still
  // generating is Working, not Waiting.
  if (thread.session?.status === "running") {
    return { state: "working", label: "Working", since: null, monitorOnly: false };
  }
  const wait = thread.backgroundWait;
  if (wait == null) return IDLE;
  return {
    state: "waiting",
    label: formatThreadWaitLabel(wait),
    since: wait.since,
    monitorOnly: wait.monitorOnly,
  };
}
