/**
 * One thread-level answer to "is the agent working, or is it just waiting?".
 *
 * The distinction the whole app hangs on:
 *
 * - **working** — the thread's own turn is in flight. The agent is generating
 *   text or running a foreground tool call, and anything the user sends now
 *   joins that turn as a steer.
 * - **waiting** — no turn of its own is running, but background work it
 *   started is still alive: background shells, watch loops, workflows,
 *   subagents, anything the provider reports as a task. The agent itself is
 *   idle, so a message sent now starts a real turn immediately.
 * - **idle** — nothing is live.
 *
 * Both inputs are durable projections of the shell, not client-local state,
 * so every surface (sidebar, thread view, phone) reads the same answer and it
 * survives reload, resume and reconnect.
 *
 * Provider-neutral by construction: `backgroundWait` is filled from the
 * shared task lifecycle every adapter feeds, and `session.status` from the
 * shared session lifecycle. A provider that reports no tasks at all simply
 * never reaches `waiting`, which is the correct reading of "nothing is known
 * to be alive" rather than a special case.
 *
 * Connection states are deliberately NOT modelled here. "starting" is a
 * session coming up, not work; surfaces that show a Connecting state resolve
 * it themselves before consulting this.
 */
import type { OrchestrationThreadShell, ThreadBackgroundWait } from "@t3tools/contracts";

export type ThreadWorkState = "working" | "waiting" | "idle";

export interface ThreadWorkStatus {
  readonly state: ThreadWorkState;
  /**
   * Ready-to-render status text: "Working" while a turn runs, "Waiting on
   * <what>" while only background work is alive, null when idle. The <what>
   * comes verbatim from the provider-derived wait label.
   */
  readonly label: string | null;
  /**
   * Instant the "Waiting on …" timer counts from — the longest-running live
   * item's start. Null in every other state: a working thread's elapsed time
   * belongs to its turn, which surfaces already resolve from `latestTurn`.
   */
  readonly since: string | null;
  /**
   * Waiting only, and only on watch loops. A monitor can outlive every turn,
   * so a surface that must eventually declare the thread finished treats this
   * as idle instead of waiting forever.
   */
  readonly monitorOnly: boolean;
}

export type ThreadWorkStateInput = Pick<OrchestrationThreadShell, "session"> & {
  readonly backgroundWait?: ThreadBackgroundWait | null | undefined;
};

const IDLE: ThreadWorkStatus = { state: "idle", label: null, since: null, monitorOnly: false };

/** "Waiting on 3 tasks", "Waiting on Reviewer + 2 more agents", … */
export function formatThreadWaitLabel(wait: ThreadBackgroundWait): string {
  return `Waiting on ${wait.label}`;
}

export function resolveThreadWorkState(thread: ThreadWorkStateInput): ThreadWorkStatus {
  // A running session is the agent's own turn, whatever else is alive
  // underneath it. Ordering matters: a turn that spawned five agents and is
  // still generating is Working, not Waiting.
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
