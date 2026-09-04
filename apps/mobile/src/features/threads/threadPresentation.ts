import type { StatusTone } from "../../components/StatusPill";
import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadWorkState } from "@t3tools/shared/threadWorkState";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "waiting"
  | "connecting"
  | "error"
  | "plan-ready";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

function isLatestTurnSettled(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  return session.status !== "running";
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  if (thread.hasPendingApprovals) {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-adaptive-amber-500-a12-a16",
      textClassName: "text-adaptive-amber-700-300",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-adaptive-indigo-500-a12-a16",
      textClassName: "text-adaptive-indigo-700-300",
      iconColor: "#5e5ce6",
      iconBackground: "rgba(94,92,230,0.22)",
      pulse: false,
    };
  }

  // Compaction reports itself as a running session, so it is read before that
  // check or it would show up as the agent working. Only compaction jumps the
  // queue; ordinary background work stays below the plan prompt.
  if (thread.compactingSince != null) {
    const compacting = resolveThreadWorkState(thread);
    if (compacting.state === "waiting" && compacting.label !== null) {
      return {
        kind: "waiting",
        label: compacting.label,
        pillClassName: "bg-adaptive-sky-500-a12-a16",
        textClassName: "text-adaptive-sky-700-300",
        iconColor: "#0a84ff",
        iconBackground: "rgba(10,132,255,0.22)",
        pulse: false,
      };
    }
  }

  if (thread.session?.status === "running") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-adaptive-rose-500-a12-a16",
      textClassName: "text-adaptive-rose-700-300",
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-700-300",
      iconColor: "#bf5af2",
      iconBackground: "rgba(191,90,242,0.22)",
      pulse: false,
    };
  }

  // The thread's own turn is over, but work it started is still alive. Not
  // working — waiting: the agent will answer a message straight away. Same
  // hue as Working so a thread reads consistently, but no pulse, because
  // nothing of the agent's own is in flight. The label after "Waiting on" is
  // whatever the provider called the work.
  const backgroundWait = resolveThreadWorkState(thread);
  if (backgroundWait.state === "waiting" && backgroundWait.label !== null) {
    return {
      kind: "waiting",
      label: backgroundWait.label,
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: false,
    };
  }

  return null;
}
