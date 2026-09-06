import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import { resolveThreadWorkState } from "./threadWorkState.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface ProjectThreadAwarenessInput {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: Pick<
    OrchestrationThreadShell,
    | "id"
    | "title"
    | "modelSelection"
    | "session"
    | "latestTurn"
    | "updatedAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "backgroundWait"
    | "compactingSince"
  >;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function projectThreadAwareness(
  input: ProjectThreadAwarenessInput,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  const phase = resolveThreadAwarenessPhase(thread);
  if (!phase) {
    return null;
  }

  const detail = detailForPhase(phase, thread);
  // A thread can be "running" without the agent generating anything: the turn
  // ended while work it launched runs on, or the provider is compacting. The
  // same derivation every surface uses says which, so the card names it
  // instead of claiming the agent is working. The PHASE stays "running" on
  // purpose — it is what the hosted relay's schema accepts, and it is what
  // keeps the completion alert from firing early.
  const workState = phase === "running" ? resolveThreadWorkState(thread) : null;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline:
      workState?.state === "waiting" && workState.label !== null
        ? workState.label
        : headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhase(
  thread: ProjectThreadAwarenessInput["thread"],
): AgentAwarenessPhase | null {
  if (thread.hasPendingApprovals) {
    return "waiting_for_approval";
  }
  if (thread.hasPendingUserInput) {
    return "waiting_for_input";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (thread.session?.status === "starting") {
    return "starting";
  }
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "running";
  }
  // A turn that ended while the work it launched is still alive has not
  // finished the job, and "Agent finished" here is the false Done this ladder
  // exists to avoid: the phone buzzes, the user opens the thread, and three
  // agents are still going. Report the run as still in flight and let the
  // completion fire once, when everything is actually settled.
  //
  // Watch loops are the deliberate exception. A monitor can outlive every
  // turn a thread will ever run, so letting one hold the ladder open would
  // suppress Done forever rather than delay it; monitor-only liveness reads
  // as finished here while the UI still shows the thread as waiting.
  const settled: AgentAwarenessPhase =
    thread.backgroundWait != null && !thread.backgroundWait.monitorOnly ? "running" : "completed";
  if (thread.latestTurn?.state === "completed") {
    return settled;
  }
  // A turn that finished can still read as "interrupted" here: session
  // teardown settles still-running turns by session status, and that write
  // can race the turn.completed one. completedAt survives the race — a turn
  // that has a completion timestamp finished, whatever the state column says.
  // Without this, quick finish-then-teardown threads resolve to null
  // persistently and get tombstoned instead of published as completed.
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null) {
    return settled;
  }
  // Threads whose turns never produce a checkpoint (no code changes) have no
  // materialized latestTurn in the shell at all, and the session-set
  // projection clears latest_turn_id the moment the session settles. The
  // session status is then the only surviving completion signal: a live
  // session at "ready"/"idle" with nothing pending and nothing running means
  // the agent finished and is waiting for the next prompt — Done.
  if (thread.session?.status === "ready" || thread.session?.status === "idle") {
    return settled;
  }
  return null;
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}

function detailForPhase(
  phase: AgentAwarenessPhase,
  thread: ProjectThreadAwarenessInput["thread"],
): string | undefined {
  if (phase === "failed") {
    return thread.session?.lastError ?? undefined;
  }
  if (phase === "completed") {
    return "Review the completed task.";
  }
  if (phase === "running" && thread.session?.providerName) {
    return `${thread.session.providerName} is active.`;
  }
  return undefined;
}
