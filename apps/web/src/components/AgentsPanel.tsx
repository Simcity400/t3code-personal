import { TaskControls, TaskStopButton } from "./agents/TaskControls";
/**
 * Agents right-panel surface: the fleet view over server-owned task state,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTitle,
  formatSubagentTokenCount,
  filterWorkflowForPanelSection,
  flattenAgentPanelRoster,
  isActiveSubagentStatus,
  deriveSubagentReplies,
  deriveSubagentTranscriptContent,
  isSubagentTranscriptContentActivity,
  selectSubagentTranscriptActivities,
  selectSubagentTranscriptMessages,
  subagentPanelSection,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  AgentWaitState,
  BackgroundTasksPanelModel,
} from "@t3tools/client-runtime/state/backgroundTasks";
import {
  deriveCompactingSince,
  emptyBackgroundTasksPanelModel,
} from "@t3tools/client-runtime/state/backgroundTasks";
import { OrchestrationProposedPlanId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { ChatFileAttachment } from "../types";
import type {
  AssistantCitation,
  EnvironmentId,
  MessageId,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
  TimestampFormat,
} from "@t3tools/contracts";
import { ArrowLeft, Bot, Braces, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { createContext, use, useEffect, useMemo, useRef, useState } from "react";

import {
  BackgroundTasksSection,
  WaitingOnStrip,
  subscribeElapsedTick,
} from "~/components/agents/BackgroundTasksSection";
import {
  deriveSubagentReplyMessages,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type TimelineEntry,
} from "~/session-logic";
import {
  deriveContextWindowSnapshotsByAgent,
  deriveLatestContextWindowSnapshot,
  type ContextWindowSnapshot,
} from "~/lib/contextWindow";
import { ContextWindowMeter } from "~/components/chat/ContextWindowMeter";
import type { TurnDiffSummary } from "~/types";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { Button } from "~/components/ui/button";

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

/** Stable identity so the default prop never remounts the strip. */
const EMPTY_AGENT_WAITS: ReadonlyArray<AgentWaitState> = [];

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    // One shared 1s ticker for every live row (see BackgroundTasksSection):
    // a timer per agent meant up to a hundred wakeups a second.
    return subscribeElapsedTick(update);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : (agent.completedAt ?? agent.updatedAt))}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

/**
 * Per-agent context-window snapshots, keyed by agent id.
 *
 * Supplied through context rather than threaded as a prop: roster rows sit
 * three components deep (section → workflow → phase → row), and this data is
 * read only by the leaf.
 */
const EMPTY_AGENT_CONTEXT_WINDOWS: ReadonlyMap<string | null, ContextWindowSnapshot> = new Map();
const AgentContextWindowCtx = createContext<ReadonlyMap<string | null, ContextWindowSnapshot>>(
  EMPTY_AGENT_CONTEXT_WINDOWS,
);

/**
 * "42% ctx" — the roster's compact form of the transcript header's full meter.
 *
 * Deliberately a PERCENTAGE, never a token count: the neighbouring "Σ … tok"
 * is a cumulative total, and two raw token figures side by side are
 * indistinguishable to a reader.
 */
function formatContextPercentage(usage: ContextWindowSnapshot): string | null {
  if (usage.usedPercentage === null || !Number.isFinite(usage.usedPercentage)) {
    return null;
  }
  return `${Math.round(usage.usedPercentage)}% ctx`;
}

function AgentRow({ agent, onOpen }: { agent: RuntimeSubagent; onOpen: () => void }) {
  const contextWindow = use(AgentContextWindowCtx).get(agent.id) ?? null;
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const title = formatSubagentTitle(agent.title);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  // Two different numbers that read alike unless they are labelled apart:
  // "Σ … tok" is everything this agent has ever processed (a running total,
  // summed into the panel footer the same way), while "… ctx" is how full its
  // context window is right now. The sigma matches the footer so a reader
  // learns one convention, not two.
  const metadata = [
    modelLabel,
    agent.usage ? `Σ ${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "Σ — tok",
    contextWindow ? formatContextPercentage(contextWindow) : null,
    agent.usage?.toolUses !== undefined ? `Σ ${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={onOpen}
        className="grid h-[3.875rem] min-w-0 flex-1 grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-label={`Open ${title} transcript`}
      >
        <span className="col-start-1 row-start-1 flex items-center">
          <StatusDot status={agent.status} />
        </span>
        <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          {role ? (
            <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
              {role}
            </span>
          ) : null}
        </span>
        <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
          <span className="inline-flex items-center gap-1">
            <AgentElapsed agent={agent} />
            {agent.status === "completed" ? (
              <Check aria-hidden className="size-3 text-success" />
            ) : null}
          </span>
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 row-start-2 block truncate text-xs",
            agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {activity ?? visuals.label}
        </span>
        <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
          {metadata.join(" · ")}
        </span>
        <span className="sr-only">{visuals.label}</span>
      </button>
      <TaskStopButton
        taskId={agent.id}
        label={title}
        active={isActiveSubagentStatus(agent.status)}
      />
    </div>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-[.65rem]",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[.6rem] text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  open,
  onOpenChange,
  onOpenAgent,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAgent: (agent: RuntimeSubagent) => void;
}) {
  const workingCount = phase.members.filter((member) =>
    isActiveSubagentStatus(member.status),
  ).length;
  const idleCount = phase.members.filter((member) => member.status === "idle").length;
  const phaseSummary =
    phase.state === "pending" && phase.members.length === 0
      ? "pending"
      : [
          workingCount > 0 ? `${workingCount} active` : null,
          idleCount > 0 ? `${idleCount} idle` : null,
          phase.settledCount > 0 ? `${phase.settledCount} done` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(" · ");

  return (
    <div>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">{phaseSummary}</span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open
        ? phase.members.map((member) => (
            <AgentRow key={member.id} agent={member} onOpen={() => onOpenAgent(member)} />
          ))
        : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
  phaseOpen,
  onPhaseOpenChange,
  onOpenAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
  phaseOpen: (phase: AgentPanelWorkflowGroup["phases"][number]) => boolean;
  onPhaseOpenChange: (phase: AgentPanelWorkflowGroup["phases"][number], open: boolean) => void;
  onOpenAgent: (agent: RuntimeSubagent) => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          phase={phase}
          open={phaseOpen(phase)}
          onOpenChange={(open) => onPhaseOpenChange(phase, open)}
          onOpenAgent={onOpenAgent}
        />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} onOpen={() => onOpenAgent(member)} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} onOpen={() => onOpenAgent(group.workflow)} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
  open,
  onOpenChange,
  phaseOpen,
  onPhaseOpenChange,
  onOpenAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phaseOpen: (phase: AgentPanelWorkflowGroup["phases"][number]) => boolean;
  onPhaseOpenChange: (phase: AgentPanelWorkflowGroup["phases"][number], open: boolean) => void;
  onOpenAgent: (agent: RuntimeSubagent) => void;
}) {
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => onOpenChange(false)}
      phaseOpen={phaseOpen}
      onPhaseOpenChange={onPhaseOpenChange}
      onOpenAgent={onOpenAgent}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => onOpenChange(true)} />
  );
}

function workflowPhaseDisclosureKey(workflowId: string, phaseIndex: number): string {
  return `${workflowId}:${phaseIndex}`;
}

function sectionAgentCount(
  workflows: ReadonlyArray<AgentPanelWorkflowGroup>,
  directAgents: ReadonlyArray<RuntimeSubagent>,
): number {
  return (
    directAgents.length +
    workflows.reduce((total, group) => {
      const memberCount = workflowMembers(group).length;
      return total + (memberCount > 0 ? memberCount : 1);
    }, 0)
  );
}

function AgentRosterSection({
  title,
  workflows,
  directAgents,
  environmentId,
  threadId,
  open = true,
  onToggle,
  workflowOpenById,
  phaseOpenByKey,
  onWorkflowOpenChange,
  onPhaseOpenChange,
  onOpenAgent,
}: {
  title: "Active" | "Idle";
  workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  directAgents: ReadonlyArray<RuntimeSubagent>;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  open?: boolean;
  onToggle?: () => void;
  workflowOpenById: Readonly<Record<string, boolean>>;
  phaseOpenByKey: Readonly<Record<string, boolean>>;
  onWorkflowOpenChange: (workflowId: string, open: boolean) => void;
  onPhaseOpenChange: (workflowId: string, phaseIndex: number, open: boolean) => void;
  onOpenAgent: (agent: RuntimeSubagent) => void;
}) {
  const count = sectionAgentCount(workflows, directAgents);
  if (count === 0) return null;

  const heading = (
    <>
      {onToggle ? (
        open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )
      ) : null}
      <span>{title}</span>
      <span className="font-mono font-normal text-muted-foreground/70">{count}</span>
    </>
  );

  return (
    <section
      className={cn(
        "rounded-lg border p-1.5",
        title === "Active" ? "border-info/30 bg-info/5" : "border-border/60 bg-card/20",
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent/40"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[.65rem] font-medium uppercase tracking-wider text-info-foreground">
          {heading}
        </div>
      )}
      {open ? (
        <div className="flex flex-col gap-1">
          {workflows.map((group) => (
            <WorkflowSection
              key={group.workflow.id}
              group={group}
              environmentId={environmentId}
              threadId={threadId}
              open={workflowOpenById[group.workflow.id] ?? workflowIsLive(group)}
              onOpenChange={(open) => onWorkflowOpenChange(group.workflow.id, open)}
              phaseOpen={(phase) =>
                phaseOpenByKey[workflowPhaseDisclosureKey(group.workflow.id, phase.index)] ??
                (phase.state === "running" || !workflowIsLive(group))
              }
              onPhaseOpenChange={(phase, open) =>
                onPhaseOpenChange(group.workflow.id, phase.index, open)
              }
              onOpenAgent={onOpenAgent}
            />
          ))}
          {directAgents.length > 0 ? (
            <div>
              {workflows.length > 0 ? (
                <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground/70">
                  Direct spawns
                </div>
              ) : null}
              {directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onOpen={() => onOpenAgent(agent)} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const EMPTY_TURN_DIFFS = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const NOOP_MESSAGE_ANCHOR = () => {};
const NOOP_TURN_DIFF = () => {};
const NOOP_REVERT = () => {};
const NOOP_IMAGE_EXPAND = () => {};

function AgentTranscript({
  agent,
  model,
  messages,
  activities,
  cwd,
  threadRef,
  skills,
  resolvedTheme,
  timestampFormat,
  onBack,
  onOpenAgent,
  onFileOpen,
  onFileDownload,
  onUseArtifactTemplate,
  onCiteAssistantText,
  onImageExpand,
  loadEarlier,
}: {
  agent: RuntimeSubagent;
  /** The whole roster: nested-agent rows read their live state from it, the
   * same way the main chat's spawn rows do. */
  model: AgentPanelModel;
  messages: ReadonlyArray<OrchestrationMessage>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  cwd?: string | undefined;
  threadRef: ScopedThreadRef;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  loadEarlier?:
    | { loading: boolean; onLoadEarlier: () => void; cursor?: string | null }
    | null
    | undefined;
  onBack: () => void;
  /** Opens another agent's transcript (a nested spawn row, or a reply header). */
  onOpenAgent: (agentId: string) => void;
  /**
   * The row affordances the main chat wires up. A subagent transcript renders
   * the same rows through the same component, so without these a file it
   * produced is drawn but dead on click, and its text cannot be cited —
   * identical-looking rows that quietly do less.
   */
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  onFileOpen?: ((attachment: ChatFileAttachment) => void) | undefined;
  onFileDownload?: ((attachment: ChatFileAttachment) => void) | undefined;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onCiteAssistantText?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
}) {
  const title = formatSubagentTitle(agent.title);
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const ownMessages = useMemo(
    () => selectSubagentTranscriptMessages(messages, activities, agent.id),
    [activities, agent.id, messages],
  );
  const transcriptActivities = useMemo(
    () => selectSubagentTranscriptActivities(activities, agent.id),
    [activities, agent.id],
  );
  // Reports this agent's OWN sub-subagents sent back to it, rendered exactly
  // as the parent thread renders the reports it receives.
  const nestedReplies = useMemo(
    () =>
      deriveSubagentReplyMessages(deriveSubagentReplies(activities, messages), agent.id, (reply) =>
        formatSubagentTitle(reply.agentTitle ?? reply.agentId),
      ),
    [activities, agent.id, messages],
  );
  const subagentReplyByMessageId = useMemo(
    () =>
      new Map(
        nestedReplies.map((reply) => [
          reply.message.id,
          { agentId: reply.agentId, label: reply.label },
        ]),
      ),
    [nestedReplies],
  );
  const transcriptMessages = useMemo(
    () =>
      nestedReplies.length === 0
        ? ownMessages
        : [...ownMessages, ...nestedReplies.map((reply) => reply.message)],
    [nestedReplies, ownMessages],
  );
  const workLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(
        transcriptActivities.filter((activity) => !isSubagentTranscriptContentActivity(activity)),
      ),
    [transcriptActivities],
  );
  const contextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(transcriptActivities),
    [transcriptActivities],
  );
  const content = useMemo(
    () => deriveSubagentTranscriptContent(transcriptActivities),
    [transcriptActivities],
  );
  const compactingSince = useMemo(
    () => deriveCompactingSince(transcriptActivities),
    [transcriptActivities],
  );
  const timelineEntries = useMemo(() => {
    const plans = content
      .filter((block) => block.kind === "plan")
      .map((block) => ({
        id: OrchestrationProposedPlanId.make(block.id),
        turnId: block.turnId,
        planMarkdown: block.text,
        createdAt: block.createdAt,
        updatedAt: block.createdAt,
        implementedAt: null,
        implementationThreadId: null,
      }));
    const reasoning: TimelineEntry[] = content
      .filter((block) => block.kind === "reasoning")
      .map((block) => ({
        id: block.id,
        createdAt: block.createdAt,
        kind: "reasoning",
        content: block,
      }));
    const rank = (entry: TimelineEntry) =>
      entry.kind === "message" ? (entry.message.role === "user" ? 0 : 2) : 1;
    const contentOrder = new Map(content.map((block, index) => [block.id, index]));
    return [
      ...deriveTimelineEntries(transcriptMessages, plans, workLogEntries),
      ...reasoning,
    ].toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        rank(left) - rank(right) ||
        (contentOrder.get(left.id) ?? 0) - (contentOrder.get(right.id) ?? 0),
    );
  }, [content, transcriptMessages, workLogEntries]);
  // The agent's CURRENT turn, not its first. A resumed agent runs across
  // several turns, and anchoring on the oldest one made turn folding, the
  // elapsed timer and the working row describe a turn that had long finished.
  const turnId = useMemo(() => {
    let latest: (typeof transcriptMessages)[number]["turnId"] = null;
    let latestAt = "";
    for (const message of transcriptMessages) {
      if (message.turnId !== null && message.createdAt >= latestAt) {
        latest = message.turnId;
        latestAt = message.createdAt;
      }
    }
    for (const activity of transcriptActivities) {
      if (activity.turnId !== null && activity.createdAt >= latestAt) {
        latest = activity.turnId;
        latestAt = activity.createdAt;
      }
    }
    return latest;
  }, [transcriptActivities, transcriptMessages]);
  const isWorking = isActiveSubagentStatus(agent.status);
  const latestTurn =
    turnId === null
      ? null
      : {
          turnId,
          state: isWorking
            ? ("running" as const)
            : agent.status === "failed"
              ? ("error" as const)
              : agent.status === "cancelled" || agent.status === "interrupted"
                ? ("interrupted" as const)
                : ("completed" as const),
          startedAt: agent.startedAt,
          completedAt: isWorking ? null : (agent.completedAt ?? agent.updatedAt),
        };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents"
          className="rounded-sm p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </button>
        <StatusDot status={agent.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <span className="text-[.65rem] text-muted-foreground">
          {isWorking && compactingSince !== null
            ? "Compacting context"
            : STATUS_VISUALS[agent.status].label}
        </span>
        <TaskStopButton taskId={agent.id} label={title} active={isWorking} />
        {/* The same meter the main chat shows, on this agent's own window. */}
        {contextWindow ? (
          <ContextWindowMeter usage={contextWindow} modelDisplayName={agent.model} />
        ) : null}
      </header>
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          key={agent.id}
          loadEarlier={loadEarlier ?? null}
          isWorking={isWorking}
          activeTurnStartedAt={isWorking ? (agent.startedAt ?? agent.firstSeenAt) : null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          subagentReplyByMessageId={subagentReplyByMessageId}
          // Same roster and callbacks the main chat passes, so a nested spawn
          // row shows live counts and opens, instead of reading an empty model
          // and clicking into a no-op.
          agentPanelModel={model}
          onOpenAgents={() => onOpenAgent(agent.id)}
          onOpenAgent={onOpenAgent}
          {...(onFileOpen ? { onFileOpen } : {})}
          {...(onFileDownload ? { onFileDownload } : {})}
          {...(onUseArtifactTemplate ? { onUseArtifactTemplate } : {})}
          {...(onCiteAssistantText ? { onCiteAssistantText } : {})}
          latestTurn={latestTurn}
          runningTurnId={isWorking ? turnId : null}
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
          routeThreadKey={scopedThreadKey(threadRef)}
          onOpenTurnDiff={NOOP_TURN_DIFF}
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          onRevertUserMessage={NOOP_REVERT}
          isRevertingCheckpoint={false}
          onImageExpand={onImageExpand ?? NOOP_IMAGE_EXPAND}
          activeThreadEnvironmentId={threadRef.environmentId}
          markdownCwd={cwd}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={cwd}
          skills={skills}
          anchorMessageId={null}
          onAnchorReady={NOOP_MESSAGE_ANCHOR}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={liveFollowEnabled}
          onIsAtEndChange={(atEnd) => {
            if (atEnd) setLiveFollowEnabled(true);
          }}
          onManualNavigation={() => setLiveFollowEnabled(false)}
        />
        {!liveFollowEnabled ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
            <button
              type="button"
              aria-label="Scroll to end"
              onClick={() => {
                setLiveFollowEnabled(true);
                void listRef.current?.scrollToEnd?.({ animated: true });
              }}
              className="chat-composer-glass pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground"
            >
              <ChevronDown className="size-3.5" />
              Scroll to end
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentsPanelContent({
  model,
  environmentId = null,
  threadId = null,
  messages = [],
  activities = [],
  cwd,
  threadRef,
  skills = [],
  resolvedTheme = "light",
  timestampFormat = "locale",
  requestedAgentId = null,
  onRequestedAgentHandled,
  onFileOpen,
  onFileDownload,
  onUseArtifactTemplate,
  onCiteAssistantText,
  onImageExpand,
  loadEarlier,
  tasksModel = emptyBackgroundTasksPanelModel(),
  waits = EMPTY_AGENT_WAITS,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  messages?: ReadonlyArray<OrchestrationMessage>;
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
  cwd?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  resolvedTheme?: "light" | "dark";
  timestampFormat?: TimestampFormat;
  loadEarlier?:
    | { loading: boolean; onLoadEarlier: () => void; cursor?: string | null }
    | null
    | undefined;
  /**
   * Agent to open directly, set when the chat asks for one (clicking a
   * "From <agent>" reply). Cleared through `onRequestedAgentHandled` so the
   * user can navigate away again without the request re-opening it.
   */
  requestedAgentId?: string | null;
  onRequestedAgentHandled?: () => void;
  /**
   * The row affordances the main chat wires up. A subagent transcript renders
   * the same rows through the same component, so without these a file it
   * produced is drawn but dead on click, and its text cannot be cited —
   * identical-looking rows that quietly do less.
   */
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  onFileOpen?: ((attachment: ChatFileAttachment) => void) | undefined;
  onFileDownload?: ((attachment: ChatFileAttachment) => void) | undefined;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onCiteAssistantText?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
  /** Background work running beside the roster (shells, monitors, watch loops). */
  tasksModel?: BackgroundTasksPanelModel;
  /** One line per blocked agent, main first. */
  waits?: ReadonlyArray<AgentWaitState>;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  useEffect(() => {
    if (!requestedAgentId) return;
    setSelectedAgentId(requestedAgentId);
    onRequestedAgentHandled?.();
  }, [onRequestedAgentHandled, requestedAgentId]);

  const [idleOpen, setIdleOpen] = useState(true);
  const [workflowOpenById, setWorkflowOpenById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(model.workflows.map((group) => [group.workflow.id, workflowIsLive(group)])),
  );
  const [phaseOpenByKey, setPhaseOpenByKey] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      model.workflows.flatMap((group) =>
        group.phases.map((phase) => [
          workflowPhaseDisclosureKey(group.workflow.id, phase.index),
          phase.state === "running" || !workflowIsLive(group),
        ]),
      ),
    ),
  );
  const previousPhaseStateByKeyRef = useRef(
    new Map(
      model.workflows.flatMap((group) =>
        group.phases.map(
          (phase) =>
            [workflowPhaseDisclosureKey(group.workflow.id, phase.index), phase.state] as const,
        ),
      ),
    ),
  );
  const allAgents = useMemo(() => flattenAgentPanelRoster(model), [model]);
  const sections = useMemo(
    () => ({
      activeWorkflows: model.workflows.flatMap((group) => {
        const slice = filterWorkflowForPanelSection(group, "active");
        return slice ? [slice] : [];
      }),
      idleWorkflows: model.workflows.flatMap((group) => {
        const slice = filterWorkflowForPanelSection(group, "idle");
        return slice ? [slice] : [];
      }),
      activeDirectAgents: model.directAgents.filter(
        (agent) => subagentPanelSection(agent.status) === "active",
      ),
      idleDirectAgents: model.directAgents.filter(
        (agent) => subagentPanelSection(agent.status) === "idle",
      ),
    }),
    [model],
  );
  useEffect(() => {
    setWorkflowOpenById((current) => {
      let next = current;
      for (const group of model.workflows) {
        if (group.workflow.id in current) continue;
        if (next === current) next = { ...current };
        next[group.workflow.id] = workflowIsLive(group);
      }
      return next;
    });

    const previousStates = previousPhaseStateByKeyRef.current;
    const nextStates = new Map<string, AgentPanelWorkflowGroup["phases"][number]["state"]>();
    setPhaseOpenByKey((current) => {
      let next = current;
      for (const group of model.workflows) {
        for (const phase of group.phases) {
          const key = workflowPhaseDisclosureKey(group.workflow.id, phase.index);
          nextStates.set(key, phase.state);
          const shouldOpen = phase.state === "running" || !workflowIsLive(group);
          if (!(key in current)) {
            if (next === current) next = { ...current };
            next[key] = shouldOpen;
          } else if (previousStates.get(key) !== "running" && phase.state === "running") {
            if (next === current) next = { ...current };
            next[key] = true;
          }
        }
      }
      return next;
    });
    previousPhaseStateByKeyRef.current = nextStates;
  }, [model.workflows]);
  const selectedAgent = allAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  // One pass over the thread's activities yields every agent's meter; each row
  // then reads its own by id instead of re-walking the list per agent.
  const contextWindowByAgentId = useMemo(
    () => deriveContextWindowSnapshotsByAgent(activities),
    [activities],
  );

  if (selectedAgent && threadRef) {
    return (
      <AgentTranscript
        agent={selectedAgent}
        model={model}
        messages={messages}
        activities={activities}
        cwd={cwd}
        threadRef={threadRef}
        skills={skills}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        loadEarlier={loadEarlier}
        onImageExpand={onImageExpand}
        onBack={() => setSelectedAgentId(null)}
        onOpenAgent={setSelectedAgentId}
        {...(onFileOpen ? { onFileOpen } : {})}
        {...(onFileDownload ? { onFileDownload } : {})}
        {...(onUseArtifactTemplate ? { onUseArtifactTemplate } : {})}
        {...(onCiteAssistantText ? { onCiteAssistantText } : {})}
      />
    );
  }

  // A thread can have background work and no subagents at all (a backgrounded
  // shell, a Monitor watch loop), and that is exactly when this panel earns
  // its keep — so the empty state only applies when there is nothing of either.
  if (!model.hasAgents && !tasksModel.hasTasks && waits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents, runs a workflow, or leaves work running in the
          background, it shows up here with live status, activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <AgentContextWindowCtx value={contextWindowByAgentId}>
      <div className="flex h-full min-h-0 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-2">
            <WaitingOnStrip waits={waits} />
            <AgentRosterSection
              title="Active"
              workflows={sections.activeWorkflows}
              directAgents={sections.activeDirectAgents}
              environmentId={environmentId}
              threadId={threadId}
              workflowOpenById={workflowOpenById}
              phaseOpenByKey={phaseOpenByKey}
              onWorkflowOpenChange={(workflowId, open) =>
                setWorkflowOpenById((current) => ({ ...current, [workflowId]: open }))
              }
              onPhaseOpenChange={(workflowId, phaseIndex, open) =>
                setPhaseOpenByKey((current) => ({
                  ...current,
                  [workflowPhaseDisclosureKey(workflowId, phaseIndex)]: open,
                }))
              }
              onOpenAgent={(agent) => setSelectedAgentId(agent.id)}
            />
            <AgentRosterSection
              title="Idle"
              workflows={sections.idleWorkflows}
              directAgents={sections.idleDirectAgents}
              environmentId={environmentId}
              threadId={threadId}
              open={idleOpen}
              onToggle={() => setIdleOpen((value) => !value)}
              workflowOpenById={workflowOpenById}
              phaseOpenByKey={phaseOpenByKey}
              onWorkflowOpenChange={(workflowId, open) =>
                setWorkflowOpenById((current) => ({ ...current, [workflowId]: open }))
              }
              onPhaseOpenChange={(workflowId, phaseIndex, open) =>
                setPhaseOpenByKey((current) => ({
                  ...current,
                  [workflowPhaseDisclosureKey(workflowId, phaseIndex)]: open,
                }))
              }
              onOpenAgent={(agent) => setSelectedAgentId(agent.id)}
            />
            <BackgroundTasksSection model={tasksModel} />
          </div>
        </ScrollArea>
        <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
          <span className="flex items-center gap-2">
            {model.runningCount + model.waitingCount > 0 ? (
              <span className="text-info-foreground">
                ● {model.runningCount + model.waitingCount} working
              </span>
            ) : null}
            {model.idleCount + model.settledCount > 0 ? (
              <span>{model.idleCount + model.settledCount} idle</span>
            ) : null}
          </span>
          <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
        </footer>
      </div>
    </AgentContextWindowCtx>
  );
}

export function AgentsPanel(props: Parameters<typeof AgentsPanelContent>[0]) {
  return (
    <TaskControls activities={props.activities ?? []} threadRef={props.threadRef}>
      <AgentsPanelContent {...props} />
    </TaskControls>
  );
}
