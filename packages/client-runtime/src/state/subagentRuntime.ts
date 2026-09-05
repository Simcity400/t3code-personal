/** Shared agent presentation and transcript selection. State is owned by the server. */
import {
  MessageId,
  readTaskStates,
  type RuntimeTaskUsage,
  type TaskRunHandles,
  type TaskState,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { isBackgroundTaskActivity } from "./taskSurface.ts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type SubagentUsage = RuntimeTaskUsage;

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export type SubagentRunHandles = TaskRunHandles;

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** First retained observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Active = the user may still need to care while it runs. Idle is settled-ish
 * but resumable; waiting counts as active because it needs the user. */
export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

const SUBAGENT_TITLE_TERMS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  claude: "Claude",
  cli: "CLI",
  codex: "Codex",
  css: "CSS",
  e2e: "E2E",
  expo: "Expo",
  git: "Git",
  github: "GitHub",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  ios: "iOS",
  ipad: "iPad",
  iphone: "iPhone",
  js: "JS",
  json: "JSON",
  macos: "macOS",
  mcp: "MCP",
  pr: "PR",
  qa: "QA",
  sdk: "SDK",
  sql: "SQL",
  ssh: "SSH",
  t3: "T3",
  ts: "TS",
  ui: "UI",
  url: "URL",
  ux: "UX",
  ws: "WS",
  xcode: "Xcode",
  xml: "XML",
};

/**
 * Makes provider task keys pleasant to read without changing the stable key
 * used for transcript attribution. Explicit human-written titles are kept as
 * provided; only lowercase identifier-shaped titles are humanized.
 */
export function formatSubagentTitle(title: string): string {
  const trimmed = title.trim();
  if (
    trimmed.length === 0 ||
    !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(trimmed)
  ) {
    return trimmed;
  }

  return trimmed
    .split(/[_-]+/)
    .map((part, index) => {
      const knownTerm = SUBAGENT_TITLE_TERMS[part];
      if (knownTerm) return knownTerm;
      return index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
    })
    .join(" ");
}

export { isBackgroundTaskActivity };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isOpaqueSubagentTitle(title: string, agentId: string): boolean {
  return title === agentId || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(title);
}

/** Select the server's current roster, regardless of which turns are loaded. */
export function foldSubagentActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly sessionLive?: boolean; readonly protectedAgentIds?: ReadonlyArray<string> },
): ReadonlyArray<RuntimeSubagent> {
  return readTaskStates(activities)
    .filter((task) => task.agentKind === "agent")
    .map((task) =>
      options?.sessionLive === false && isActiveSubagentStatus(task.status)
        ? {
            ...task,
            status: "interrupted" as const,
            completedAt: task.completedAt ?? task.updatedAt,
          }
        : task,
    );
}

export interface AgentPanelWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    /** done = every member settled (success or error); running = any active. */
    readonly state: "pending" | "running" | "done";
    readonly activeCount: number;
    readonly settledCount: number;
  }>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

export type SubagentPanelSection = "active" | "idle";

/** The panel treats every non-working agent as idle, regardless of outcome. */
export function subagentPanelSection(status: RuntimeSubagent["status"]): SubagentPanelSection {
  return isActiveSubagentStatus(status) ? "active" : "idle";
}

function workflowSliceStatus(
  members: ReadonlyArray<RuntimeSubagent>,
  section: SubagentPanelSection,
): RuntimeSubagent["status"] {
  if (section === "active") {
    if (members.some((member) => member.status === "running")) return "running";
    if (members.some((member) => member.status === "waiting")) return "waiting";
    return "pending";
  }
  if (members.some((member) => member.status === "failed")) return "failed";
  if (members.some((member) => member.status === "idle")) return "idle";
  if (members.some((member) => member.status === "interrupted")) return "interrupted";
  if (members.some((member) => member.status === "cancelled")) return "cancelled";
  return "completed";
}

/**
 * Projects one workflow into a panel section without flattening its phase
 * shape. A mixed workflow can therefore appear in both sections while every
 * individual member remains hideable under the correct disclosure.
 */
export function filterWorkflowForPanelSection(
  group: AgentPanelWorkflowGroup,
  section: SubagentPanelSection,
): AgentPanelWorkflowGroup | null {
  const allMembers = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  if (allMembers.length === 0) {
    return subagentPanelSection(group.workflow.status) === section ? group : null;
  }

  const phases = group.phases.flatMap<AgentPanelWorkflowGroup["phases"][number]>((phase) => {
    const members = phase.members.filter(
      (member) => subagentPanelSection(member.status) === section,
    );
    if (members.length === 0) return [];
    const activeCount = members.filter(
      (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
    ).length;
    const settledCount = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
    return [
      {
        ...phase,
        members,
        state: activeCount > 0 ? "running" : settledCount === members.length ? "done" : "pending",
        activeCount,
        settledCount,
      },
    ];
  });
  const unphasedMembers = group.unphasedMembers.filter(
    (member) => subagentPanelSection(member.status) === section,
  );
  const members = [...phases.flatMap((phase) => phase.members), ...unphasedMembers];
  if (members.length === 0) return null;

  return {
    ...group,
    workflow: { ...group.workflow, status: workflowSliceStatus(members, section) },
    phases,
    unphasedMembers,
  };
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

export function emptyAgentPanelModel(): AgentPanelModel {
  return EMPTY_PANEL_MODEL;
}

/** Group the server roster without reconstructing task lifecycle history. */
export function deriveAgentPanelModel({
  agents,
}: {
  readonly agents: ReadonlyArray<RuntimeSubagent>;
}): AgentPanelModel {
  const source = agents;
  if (source.length === 0) {
    return EMPTY_PANEL_MODEL;
  }

  const workflows = source
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];

  for (const agent of source) {
    if (agent.kind === "workflow") {
      continue;
    }
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      // Orphaned members (coordinator aged out) fall back to the direct list.
      direct.push(agent);
    }
  }

  const workflowGroups: AgentPanelWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`,
                );
              }
            }
            return Array.from(derived.entries())
              .map(([index, title]) => ({ index, title }))
              .slice()
              .sort((a, b) => a.index - b.index);
          })();

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const activeCount = phaseMembers.filter(
        // Idle members count as active for phase-liveness: a resumable Codex
        // member has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? "pending"
          : activeCount > 0
            ? "running"
            : settledCount === phaseMembers.length
              ? "done"
              : "pending";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        activeCount,
        settledCount,
      };
    });

    // Unknown phase indices land here too — a member must never vanish just
    // because its phase row was lost (review finding).
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, phases, unphasedMembers };
  });

  let runningCount = 0;
  let waitingCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of source) {
    // A workflow coordinator with members is a container for those members, not
    // work of its own: it reports running for the whole run and aggregates their
    // usage upstream in some providers. Counting it would report one more agent
    // working than there are, and double count tokens.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    // Updates and the >100-agent retention ranking must never reshuffle rows
    // that remain visible.
    directAgents: direct
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)),
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

/**
 * Members ordered by urgency for the capped inline workflow card: running and
 * failed first, then waiting, then most recently updated.
 */
/**
 * Every agent on the panel, flattened: direct spawns, each workflow's
 * coordinator, its phase members and its unphased members.
 *
 * The roster is the lookup for anything keyed by agent id — a reply's display
 * title, an open transcript, a per-agent meter. Reading only `directAgents`
 * (which three call sites used to do independently) left workflow members
 * labelled with their raw task id.
 */
export function flattenAgentPanelRoster(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return [
    ...model.directAgents,
    ...model.workflows.flatMap((group) => [
      group.workflow,
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ]),
  ];
}

export function workflowCardMembers(
  group: AgentPanelWorkflowGroup,
  limit: number,
): { readonly visible: ReadonlyArray<RuntimeSubagent>; readonly overflow: number } {
  const all = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const urgency = (agent: RuntimeSubagent): number => {
    if (agent.status === "failed") return 0;
    if (agent.status === "running") return 1;
    if (agent.status === "waiting") return 2;
    return 3;
  };
  const ordered = all
    .slice()
    .sort((a, b) => urgency(a) - urgency(b) || b.updatedAt.localeCompare(a.updatedAt));
  return {
    visible: ordered.slice(0, limit),
    overflow: Math.max(0, ordered.length - limit),
  };
}

/** Kinds the timeline should not render as generic rows (fold input only). */
export function isSubagentActivityKind(kind: string): boolean {
  return (
    kind === "task.state" ||
    kind === "task.started" ||
    kind === "task.progress" ||
    kind === "task.updated" ||
    kind === "task.completed" ||
    kind === "tool.progress"
  );
}

/**
 * Quiet-timeline guarantee: tool rows attributed to an owning agent belong in
 * the Agents surface, not the parent chat. Unattributed rows must stay.
 */
export function isAgentAttributedToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return false;
  }
  const payload = activity.payload as Record<string, unknown>;
  return typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
}

/**
 * Selects one agent's activity stream for replay through the ordinary chat
 * timeline renderers.
 *
 * Every row the server stamped with this `agentId` is returned, whatever its
 * kind — tool lifecycle, the agent's own plan (`turn.plan.updated`), a denial,
 * the tasks it spawned itself, its context-window updates. Selecting by
 * attribution rather than by an allowlist of kinds is what makes the agent
 * transcript identical to the parent chat: the SAME derivations
 * (`deriveWorkLogEntries`, `deriveLatestContextWindowSnapshot`)
 * run over the same shape of input and apply their own filters, instead of a
 * thinner tool-only feed that silently dropped everything else.
 *
 * Attribution is removed from the returned copies so the parent-timeline
 * quieting rule (`isAgentInternalActivity`) does not discard rows that have
 * already been explicitly scoped to the selected agent.
 *
 * Assistant and user message items stay out: they are the transcript's
 * messages, delivered through `selectSubagentTranscriptMessages`, and would
 * otherwise render a second time as tool cards.
 * The selected agent's own task lifecycle belongs to the roster, not its
 * transcript: replaying it here would make the agent appear to spawn itself.
 */
export function selectSubagentTranscriptActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  agentId: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  return activities.flatMap((activity) => {
    if (typeof activity.payload !== "object" || activity.payload === null) {
      return [];
    }
    const payload = activity.payload as Record<string, unknown>;
    if (
      activity.kind.startsWith("task.") &&
      (asString(payload.taskId) === agentId || asString(payload.id) === agentId)
    ) {
      return [];
    }
    // `agentId` is how Claude stamps the owning conversation; `parentAgentId`
    // is how providers that model children as their own threads (Codex,
    // OpenCode) name it on the child's task rows. Matching only the former hid
    // a nested agent's launch row from the subagent that actually spawned it.
    const ownedByAgent =
      asString(payload.agentId) === agentId || asString(payload.parentAgentId) === agentId;
    if (
      !ownedByAgent ||
      payload.itemType === "assistant_message" ||
      payload.itemType === "user_message"
    ) {
      return [];
    }
    const { agentId: _agentId, timelineBypass: _timelineBypass, ...transcriptPayload } = payload;
    return [
      {
        ...activity,
        payload: transcriptPayload,
      },
    ];
  });
}

export interface SubagentTranscriptContent {
  readonly id: string;
  readonly kind: "plan" | "reasoning";
  readonly text: string;
  readonly createdAt: string;
  readonly turnId: OrchestrationMessage["turnId"];
  readonly streaming: boolean;
}

export function isSubagentTranscriptContentActivity(
  activity: OrchestrationThreadActivity,
): boolean {
  const payload = asRecord(activity.payload);
  if (!payload) return false;
  return (
    activity.kind === "turn.proposed.completed" ||
    (activity.kind === "content.delta" &&
      ["reasoning_text", "reasoning_summary_text", "plan_text"].includes(
        String(payload?.streamKind),
      )) ||
    (["item.started", "item.updated", "item.completed"].includes(activity.kind) &&
      (payload?.itemType === "reasoning" || payload?.itemType === "plan"))
  );
}

/** Reads already agent-scoped activities into Markdown blocks, retaining provider item boundaries. */
export function deriveSubagentTranscriptContent(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<SubagentTranscriptContent> {
  const blocks: Array<{
    id: string;
    kind: SubagentTranscriptContent["kind"];
    chunks: string[];
    createdAt: string;
    turnId: SubagentTranscriptContent["turnId"];
    streaming: boolean;
    item: string;
  }> = [];
  const open = new Map<string, (typeof blocks)[number]>();
  for (const activity of activities) {
    if (!isSubagentTranscriptContentActivity(activity)) continue;
    const payload = asRecord(activity.payload)!;
    const kind =
      activity.kind === "turn.proposed.completed" ||
      payload.itemType === "plan" ||
      payload.streamKind === "plan_text"
        ? "plan"
        : "reasoning";
    const item = asString(payload.itemId) ?? activity.turnId ?? "current";
    const stream =
      asString(payload.streamKind) ?? (kind === "plan" ? "plan_text" : "reasoning_text");
    const key = `${kind}:${stream}:${item}`;
    const delta = activity.kind === "content.delta";
    const text = delta
      ? payload.delta
      : activity.kind === "turn.proposed.completed"
        ? payload.planMarkdown
        : payload.detail;
    let block = open.get(key);
    if (!block && typeof text === "string" && text.length > 0) {
      block = {
        id: `agent-content:${activity.id}`,
        kind,
        chunks: [],
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        streaming: true,
        item,
      };
      blocks.push(block);
      open.set(key, block);
    }
    if (block && typeof text === "string" && text.length > 0) {
      if (delta) block.chunks.push(text);
      else block.chunks = [text];
    }
    if (activity.kind.endsWith(".completed")) {
      for (const [candidateKey, candidate] of open) {
        if (candidate.kind === kind && candidate.item === item) {
          candidate.streaming = false;
          open.delete(candidateKey);
        }
      }
    }
  }
  return blocks.map(({ chunks, item: _item, ...block }) => ({ ...block, text: chunks.join("") }));
}

/**
 * Rows that belong to the PARENT conversation's own surfaces (its work log,
 * its plan chip, its context meter).
 *
 * A row the server attributed to a subagent is that agent's, and the parent
 * must skip it rather than render it or — worse for single-value surfaces like
 * the context meter and the plan chip — read a child's value as its own.
 */
export function isParentScopedActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.state" || activity.kind.startsWith("task.stop.")) return false;
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return true;
  }
  const payload = activity.payload as Record<string, unknown>;
  return asString(payload.agentId) === undefined;
}

interface SubagentPromptCandidate {
  readonly key: string;
  readonly source: "task" | "tool";
  readonly text: string;
  readonly createdAt: string;
  readonly turnId: OrchestrationMessage["turnId"];
  readonly activityId: string;
  readonly promptId: string | undefined;
  readonly childUserMessage: boolean;
  /**
   * The provider only kept ciphertext for this instruction, so `text` is a
   * placeholder describing that an instruction was sent — never real content.
   */
  readonly encryptedFallback: boolean;
  /** Ciphertext for encrypted fallbacks, otherwise the prompt itself. */
  readonly dedupeKey: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isEncryptedCollabPrompt(value: string): boolean {
  return /^gAAAAA[A-Za-z0-9_-]{74,}={0,2}$/.test(value.trim());
}

function asPrompt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return isEncryptedCollabPrompt(value) ? undefined : value;
}

/**
 * Shown in place of an instruction the provider only persisted as ciphertext.
 * A visible marker beats an empty transcript: the reader learns an
 * instruction was sent and that the text — not the row — is missing.
 */
export const ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER =
  "Instruction sent to subagent. Codex encrypted the original text.";

/** "/root/marlow" -> "marlow": the name a parent addresses the agent by. */
function agentPathLeaf(value: unknown): string | undefined {
  const path = asString(value);
  if (!path) return undefined;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}

function asEncryptedPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isEncryptedCollabPrompt(trimmed) ? trimmed : undefined;
}

function readUserMessagePrompt(item: Record<string, unknown> | undefined): string | undefined {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return undefined;
  const text = item.content
    .flatMap((content) => {
      const part = asRecord(content);
      return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
  return asPrompt(text);
}

/**
 * Recovers every instruction the parent sent to one agent from persisted
 * provider tool rows. Claude links its launching Agent/Task tool through
 * task.*.toolUseId; Codex records the receiving child thread directly on its
 * collabAgentToolCall. Tool lifecycle rows are coalesced by item id so a
 * streamed start/update/completion contributes one prompt, not three.
 */
function deriveSubagentPromptCandidates(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  agentId: string,
): ReadonlyArray<SubagentPromptCandidate> {
  const launchingToolIds = new Set<string>();
  const directCandidates: SubagentPromptCandidate[] = [];
  // Names the parent can address this agent by in a follow-up tool call: its
  // id, its Codex agent-path leaf, and the name given at launch. The task
  // description is deliberately NOT an alias — it is prose, and two agents
  // launched with the same description would both claim the instruction.
  const agentAliases = new Set<string>([agentId.toLowerCase()]);

  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = asRecord(activity.payload);
    if (
      !payload ||
      asString(activity.kind === "task.state" ? payload.id : payload.taskId) !== agentId
    )
      continue;
    const toolUseId = asString(payload.toolUseId);
    if (toolUseId) launchingToolIds.add(toolUseId);
    const pathAlias = agentPathLeaf(payload.agentPath);
    if (pathAlias) agentAliases.add(pathAlias.toLowerCase());
    const prompt = asPrompt(payload.prompt);
    const encryptedPrompt = asEncryptedPrompt(payload.prompt);
    if (prompt || encryptedPrompt) {
      directCandidates.push({
        key: `task:${activity.id}`,
        source: "task",
        text: prompt ?? ENCRYPTED_SUBAGENT_PROMPT_PLACEHOLDER,
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        activityId: activity.id,
        promptId: asString(payload.promptId),
        childUserMessage: false,
        encryptedFallback: prompt === undefined,
        // Ciphertext keys the fold so two different encrypted instructions
        // stay two rows instead of collapsing into one placeholder.
        dedupeKey: prompt ?? encryptedPrompt!,
      });
    }
  }

  const tools = new Map<
    string,
    {
      prompt: string | undefined;
      tool: string | undefined;
      receiverThreadIds: Set<string>;
      /** Lower-cased agent names/ids a follow-up tool call addressed. */
      recipients: Set<string>;
      createdAt: string;
      turnId: OrchestrationMessage["turnId"];
      activityId: string;
      itemType: string | undefined;
      activityAgentId: string | undefined;
    }
  >();

  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (!payload) continue;
    const itemId = asString(payload.itemId) ?? activity.id;
    const existing = tools.get(itemId);
    const data = asRecord(payload.data);
    const item = asRecord(data?.item) ?? (typeof data?.type === "string" ? data : undefined);
    const input = asRecord(data?.input);
    const receiverThreadIds = new Set(existing?.receiverThreadIds ?? []);
    if (Array.isArray(item?.receiverThreadIds)) {
      for (const receiverThreadId of item.receiverThreadIds) {
        const receiver = asString(receiverThreadId);
        if (receiver) receiverThreadIds.add(receiver);
      }
    }
    if (asString(payload.agentId) === agentId && payload.itemType === "user_message") {
      receiverThreadIds.add(agentId);
    }
    // Claude's SendMessage addresses a running agent by name or id rather
    // than by provider thread id, and carries the instruction in `message`.
    // Only collaboration tools are read this way: an unrelated MCP tool with
    // `to`/`message` arguments must never become a transcript instruction.
    const recipients = new Set(existing?.recipients ?? []);
    if (payload.itemType === "collab_agent_tool_call") {
      for (const key of ["to", "agentId", "agent_id"] as const) {
        const recipient = asString(input?.[key]);
        if (recipient) recipients.add(recipient.toLowerCase());
      }
      // The launching call names the agent; later follow-ups address it by
      // that name rather than by its provider id.
      if (launchingToolIds.has(itemId)) {
        const launchName = asString(input?.name);
        if (launchName) agentAliases.add(launchName.toLowerCase());
      }
    }
    tools.set(itemId, {
      prompt:
        existing?.prompt ??
        asPrompt(input?.prompt) ??
        (recipients.size > 0 ? asPrompt(input?.message) : undefined) ??
        asPrompt(item?.prompt) ??
        readUserMessagePrompt(item) ??
        asPrompt(payload.prompt),
      tool: existing?.tool ?? asString(item?.tool) ?? asString(data?.toolName),
      receiverThreadIds,
      recipients,
      createdAt:
        existing && existing.createdAt.localeCompare(activity.createdAt) <= 0
          ? existing.createdAt
          : activity.createdAt,
      turnId: existing?.turnId ?? activity.turnId,
      activityId: existing?.activityId ?? activity.id,
      itemType: existing?.itemType ?? asString(payload.itemType),
      activityAgentId: existing?.activityAgentId ?? asString(payload.agentId),
    });
  }

  const directByPromptId = new Map<string, SubagentPromptCandidate>();
  const directWithoutPromptIdByText = new Map<string, SubagentPromptCandidate>();
  for (const candidate of directCandidates) {
    if (candidate.promptId) {
      const existing = directByPromptId.get(candidate.promptId);
      if (!existing || candidate.createdAt.localeCompare(existing.createdAt) < 0) {
        directByPromptId.set(candidate.promptId, candidate);
      }
      continue;
    }
    const existing = directWithoutPromptIdByText.get(candidate.dedupeKey);
    if (!existing || candidate.createdAt.localeCompare(existing.createdAt) < 0) {
      directWithoutPromptIdByText.set(candidate.dedupeKey, candidate);
    }
  }
  const uniqueDirectCandidates = [
    ...directByPromptId.values(),
    ...directWithoutPromptIdByText.values(),
  ];
  const directPromptTexts = new Set(uniqueDirectCandidates.map((candidate) => candidate.dedupeKey));
  const directPromptIds = new Set(
    uniqueDirectCandidates.flatMap((candidate) => (candidate.promptId ? [candidate.promptId] : [])),
  );

  const toolCandidates = Array.from(tools.entries()).flatMap<SubagentPromptCandidate>(
    ([itemId, tool]) => {
      const addressedToAgent = Array.from(tool.recipients).some((recipient) =>
        agentAliases.has(recipient),
      );
      if (
        !tool.prompt ||
        (!launchingToolIds.has(itemId) && !tool.receiverThreadIds.has(agentId) && !addressedToAgent)
      ) {
        return [];
      }
      if (directPromptIds.has(itemId)) {
        return [];
      }
      if (
        directPromptTexts.has(tool.prompt) &&
        (launchingToolIds.has(itemId) || tool.tool === "spawnAgent" || tool.tool === "sendInput")
      ) {
        return [];
      }
      return [
        {
          key: `tool:${itemId}`,
          source: "tool",
          text: tool.prompt,
          createdAt: tool.createdAt,
          turnId: tool.turnId,
          activityId: tool.activityId,
          promptId: itemId,
          childUserMessage: tool.itemType === "user_message" && tool.activityAgentId === agentId,
          encryptedFallback: false,
          dedupeKey: tool.prompt,
        },
      ];
    },
  );

  const seen = new Set<string>();
  const remainingChildMirrorsByText = new Map<string, number>();
  for (const candidate of uniqueDirectCandidates) {
    remainingChildMirrorsByText.set(
      candidate.text,
      (remainingChildMirrorsByText.get(candidate.text) ?? 0) + 1,
    );
  }
  // The child's own user items are the decrypted copy of what the parent sent,
  // so each one retires exactly ONE ciphertext marker — never all of them, or
  // a single decrypted instruction would erase the agent's whole history.
  // Providers give the two no shared id, so pair each plaintext item with the
  // newest still-unpaired marker at or before it: a marker that has no
  // plaintext yet (the child is still mid-turn) is always newer, and survives.
  const decryptedChildMirrorTimes = toolCandidates
    .filter((candidate) => candidate.childUserMessage && !directPromptTexts.has(candidate.text))
    .map((candidate) => candidate.createdAt)
    .sort((left, right) => left.localeCompare(right));
  const encryptedCandidates = [...uniqueDirectCandidates]
    .filter((candidate) => candidate.encryptedFallback)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key),
    );
  const suppressedEncryptedKeys = new Set<string>();
  const pairEncryptedMarker = (mirrorTime: string): void => {
    for (let index = encryptedCandidates.length - 1; index >= 0; index -= 1) {
      const encrypted = encryptedCandidates[index];
      if (
        encrypted &&
        !suppressedEncryptedKeys.has(encrypted.key) &&
        encrypted.createdAt.localeCompare(mirrorTime) <= 0
      ) {
        suppressedEncryptedKeys.add(encrypted.key);
        return;
      }
    }
    // Rollout recovery is polled, so a marker can be persisted after the child
    // already echoed the instruction. Fall forward to the oldest unpaired
    // marker rather than leaving the pair unmatched and printing both the
    // instruction and a placeholder for it.
    for (const encrypted of encryptedCandidates) {
      if (!suppressedEncryptedKeys.has(encrypted.key)) {
        suppressedEncryptedKeys.add(encrypted.key);
        return;
      }
    }
  };
  for (const mirrorTime of decryptedChildMirrorTimes) {
    pairEncryptedMarker(mirrorTime);
  }
  // Mobile Hermes does not provide the ES2023 change-by-copy array methods.
  return [...uniqueDirectCandidates, ...toolCandidates]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key),
    )
    .filter((candidate) => {
      if (suppressedEncryptedKeys.has(candidate.key)) {
        return false;
      }
      if (candidate.childUserMessage) {
        const remainingMirrors = remainingChildMirrorsByText.get(candidate.text) ?? 0;
        if (remainingMirrors > 0) {
          remainingChildMirrorsByText.set(candidate.text, remainingMirrors - 1);
          return false;
        }
      }
      // Two instructions can share text AND millisecond (historical recovery
      // replays them in a tight loop), so identity wins whenever the provider
      // supplied one; text+time only backstops candidates that have none.
      const fingerprint = candidate.promptId
        ? `id\u0000${candidate.promptId}`
        : `${candidate.createdAt}\u0000${candidate.text}`;
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
}

/**
 * Selects one agent's persisted messages and inserts the parent's original
 * instructions as user-style messages. This keeps provider-specific linkage
 * in one shared place so web and mobile render identical transcripts, and it
 * also recovers prompts from historic rows written before prompt messages
 * were a first-class projection.
 */
export function selectSubagentTranscriptMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  agentId: string,
): ReadonlyArray<OrchestrationMessage> {
  // Every agent-attributed message is assistant output (the server never
  // stamps agentId on a user message), so nothing here may be dropped on
  // content shape: a ciphertext-looking assistant reply is still the agent
  // talking.
  const selectedMessages = messages.filter((message) => message.agentId === agentId);
  const transcriptActivities = selectSubagentTranscriptActivities(activities, agentId);
  const firstTranscriptCreatedAt = [
    ...selectedMessages.map((message) => message.createdAt),
    ...transcriptActivities.map((activity) => activity.createdAt),
  ].sort((left, right) => left.localeCompare(right))[0];
  const promptCandidates = deriveSubagentPromptCandidates(activities, agentId);
  const initialPromptKey = promptCandidates[0]?.key;
  // Text membership in a Set: this selector runs per tick while a transcript
  // is open, and a nested scan over every persisted message is quadratic.
  const persistedUserTexts = new Set(
    selectedMessages.filter((message) => message.role === "user").map((message) => message.text),
  );
  const promptMessages = promptCandidates
    .filter((candidate) => !persistedUserTexts.has(candidate.text))
    .map<OrchestrationMessage>((candidate) => {
      const createdAt =
        candidate.key === initialPromptKey &&
        firstTranscriptCreatedAt !== undefined &&
        firstTranscriptCreatedAt.localeCompare(candidate.createdAt) < 0
          ? firstTranscriptCreatedAt
          : candidate.createdAt;
      return {
        id: MessageId.make(`subagent-prompt:${agentId}:${candidate.activityId}`),
        role: "user",
        text: candidate.text,
        agentId,
        turnId: candidate.turnId,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      };
    });

  // Keep this shared selector compatible with mobile Hermes.
  return [...promptMessages, ...selectedMessages].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    if (byTime !== 0) return byTime;
    if (left.role !== right.role) {
      if (left.role === "user") return -1;
      if (right.role === "user") return 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export interface SubagentTranscriptMessageEntry {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubagentTranscriptToolEntry {
  readonly kind: "tool";
  readonly id: string;
  readonly itemId: string;
  readonly title: string;
  readonly detail: string | null;
  readonly status: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SubagentTranscriptEntry = SubagentTranscriptMessageEntry | SubagentTranscriptToolEntry;

function transcriptToolTitle(
  payload: Readonly<Record<string, unknown>>,
  existingTitle?: string,
): string {
  const title = asString(payload.title) ?? asString(payload.toolName);
  if (title) {
    return title;
  }
  if (existingTitle) {
    return existingTitle;
  }
  return (asString(payload.itemType) ?? "Tool").replaceAll("_", " ");
}

/**
 * Builds one agent's durable, live transcript from the same persisted message
 * and activity projections used by the parent timeline. Tool lifecycle rows
 * collapse by provider item id so streaming updates never grow duplicate
 * cards; assistant lifecycle rows are omitted because their text is already
 * represented by the agent-attributed message projection.
 */
export function deriveSubagentTranscript({
  agentId,
  messages,
  activities,
}: {
  readonly agentId: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyArray<SubagentTranscriptEntry> {
  const entries: SubagentTranscriptEntry[] = selectSubagentTranscriptMessages(
    messages,
    activities,
    agentId,
  ).map((message) => ({
    kind: "message" as const,
    id: message.id,
    role: message.role,
    text: message.text,
    streaming: message.streaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }));
  const tools = new Map<string, SubagentTranscriptToolEntry>();

  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    if (typeof activity.payload !== "object" || activity.payload === null) {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    // Message items are already represented as transcript messages
    // (assistant text by the message projection, the parent's instruction by
    // the prompt selector above), so they must not also become tool cards.
    if (
      asString(payload.agentId) !== agentId ||
      payload.itemType === "assistant_message" ||
      payload.itemType === "user_message"
    ) {
      continue;
    }
    const itemId = asString(payload.itemId) ?? activity.id;
    const existing = tools.get(itemId);
    const status =
      asString(payload.status) ??
      (activity.kind === "tool.completed" ? "completed" : (existing?.status ?? "inProgress"));
    tools.set(itemId, {
      kind: "tool",
      id: existing?.id ?? `tool:${itemId}`,
      itemId,
      title: transcriptToolTitle(payload, existing?.title),
      detail: asString(payload.detail) ?? existing?.detail ?? null,
      status,
      payload,
      createdAt: existing?.createdAt ?? activity.createdAt,
      updatedAt: activity.createdAt,
    });
  }

  entries.push(...tools.values());
  return entries.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * One message a subagent sent back to the conversation that owns it.
 *
 * The mirror image of the parent instructions `deriveSubagentPromptCandidates`
 * recovers: those go parent → child, these go child → parent. Both directions
 * render as ordinary chat messages so a reader can follow the whole exchange.
 */
export interface SubagentReplyEntry {
  /** Stable row id (activities upsert, so the activity id is the identity). */
  readonly id: string;
  readonly activityId: string;
  /** The agent that sent the message. */
  readonly agentId: string;
  /** Best known display name for the sender at the time it replied. */
  readonly agentTitle: string | null;
  /**
   * Conversation that RECEIVED it: null for the parent thread, otherwise the
   * agent whose transcript owns the collaboration call (a subagent reading its
   * own sub-subagent's report).
   */
  readonly ownerAgentId: string | null;
  readonly turnId: OrchestrationThreadActivity["turnId"];
  readonly text: string;
  readonly createdAt: string;
}

/**
 * How much of a reply is compared when deciding whether two rows are the same
 * report. A terminal task summary is truncated at ingestion (180 chars) while a
 * collaboration tool result keeps far more, so an exact-text key let one report
 * render twice: once in full and once clipped.
 */
const REPLY_DEDUPE_PREFIX_CHARS = 120;

/** Drops a truncation marker so a clipped copy keys like its full original. */
function replyDedupeText(text: string): string {
  return text
    .trim()
    .replace(/(?:…|\.\.\.)$/u, "")
    .trimEnd()
    .slice(0, REPLY_DEDUPE_PREFIX_CHARS);
}

function normalizedReplyKey(agentId: string, text: string): string {
  return `${agentId}\u0000${replyDedupeText(text)}`;
}

/**
 * Recovers every message a subagent sent back, from persisted rows only.
 *
 * Two provider shapes carry one:
 * - the collaboration tool's own result (`data.agentReply`, retained verbatim
 *   by the activity projection) — a foreground Task/Agent/SendMessage call
 *   returning the child's report;
 * - a terminal task row's `summary` — how a BACKGROUND agent's report arrives,
 *   since a detached task has no tool result to return into.
 *
 * The same report can arrive both ways for a task that was backgrounded
 * mid-flight, so a task summary that merely repeats a reply already recovered
 * from the tool result is dropped rather than rendered twice.
 */
const EMPTY_SUBAGENT_REPLIES: ReadonlyArray<SubagentReplyEntry> = Object.freeze([]);

export function deriveSubagentReplies(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  _messages: ReadonlyArray<OrchestrationMessage> = [],
): ReadonlyArray<SubagentReplyEntry> {
  // Launching tool call -> the agent it launched, and each agent's best title.
  const agentIdByToolUseId = new Map<string, string>();
  const agentIdByAlias = new Map<string, string>();
  const titleByAgentId = new Map<string, string>();
  // Providers that model children as their own threads (Codex, OpenCode) name
  // the owning conversation as `parentAgentId` instead of stamping `agentId`.
  const parentAgentIdByAgentId = new Map<string, string>();
  const knownAgentIds = new Set<string>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = asRecord(activity.payload);
    const taskId = payload
      ? asString(activity.kind === "task.state" ? payload.id : payload.taskId)
      : undefined;
    if (!payload || !taskId) continue;
    const toolUseId = asString(payload.toolUseId);
    if (toolUseId) agentIdByToolUseId.set(toolUseId, taskId);
    const title = asString(payload.title) ?? asString(payload.description);
    if (title && !isOpaqueSubagentTitle(title, taskId)) titleByAgentId.set(taskId, title);
    agentIdByAlias.set(taskId.toLowerCase(), taskId);
    knownAgentIds.add(taskId);
    const pathAlias = agentPathLeaf(payload.agentPath);
    if (pathAlias) agentIdByAlias.set(pathAlias.toLowerCase(), taskId);
    if (title) agentIdByAlias.set(title.toLowerCase(), taskId);
    const parentAgentId = asString(payload.parentAgentId);
    if (parentAgentId) parentAgentIdByAgentId.set(taskId, parentAgentId);
  }

  // The name the LAUNCH call gave the agent. Claude's Agent tool takes `name`
  // and `description` as separate fields and task_started reports only the
  // description, so a follow-up addressed by `name` cannot be resolved without
  // reading it off the launching tool — the same alias prompt recovery learns.
  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (!payload || payload.itemType !== "collab_agent_tool_call") continue;
    const itemId = asString(payload.itemId) ?? asString(payload.toolCallId);
    const launchedAgentId = itemId ? agentIdByToolUseId.get(itemId) : undefined;
    if (!launchedAgentId) continue;
    const launchName = asString(asRecord(asRecord(payload.data)?.input)?.name);
    if (launchName) agentIdByAlias.set(launchName.toLowerCase(), launchedAgentId);
  }

  /**
   * The conversation a reply from `agentId` is addressed to: the subagent that
   * owns it, or null for the root thread. `agentId` on a task row is the owner
   * stamped by Claude; `parentAgentId` is how Codex and OpenCode name it, and
   * it only counts when it names an agent this thread actually knows (for a
   * top-level child it is the root provider thread, which is not an agent).
   */
  const ownerOf = (agentId: string, stampedOwner: string | undefined): string | null => {
    // Bridge attribution names the speaker itself, not the recipient. Its
    // task hierarchy still identifies the conversation receiving the report.
    if (stampedOwner && stampedOwner !== agentId) return stampedOwner;
    const parent = parentAgentIdByAgentId.get(agentId);
    return parent !== undefined && knownAgentIds.has(parent) ? parent : null;
  };

  const replies: SubagentReplyEntry[] = [];
  const seenReplyKeys = new Set<string>();
  const seenActivityIds = new Set<string>();

  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    const payload = asRecord(activity.payload);
    if (!payload || payload.itemType !== "collab_agent_tool_call") continue;
    const data = asRecord(payload.data);
    const text = asString(data?.agentReply);
    if (!text) continue;
    const itemId = asString(payload.itemId) ?? asString(payload.toolCallId);
    const input = asRecord(data?.input);
    const recipient = asString(input?.to) ?? asString(input?.agentId) ?? asString(input?.agent_id);
    const agentId =
      (itemId ? agentIdByToolUseId.get(itemId) : undefined) ??
      (recipient ? agentIdByAlias.get(recipient.toLowerCase()) : undefined);
    // An unresolvable reply is a tool result like any other: without knowing
    // which agent spoke, a "From …" message would be a guess, and the row
    // still renders as the ordinary tool card it already was.
    if (!agentId) continue;
    // A subagent reading its own sub-subagent's report owns that exchange.
    const ownerAgentId = ownerOf(agentId, asString(payload.agentId));
    if (ownerAgentId === agentId) continue;
    seenReplyKeys.add(normalizedReplyKey(agentId, text));
    seenActivityIds.add(activity.id);
    replies.push({
      id: `subagent-reply:${activity.id}`,
      activityId: activity.id,
      agentId,
      agentTitle: titleByAgentId.get(agentId) ?? null,
      ownerAgentId,
      turnId: activity.turnId,
      text,
      createdAt: activity.createdAt,
    });
  }

  for (const activity of activities) {
    if (activity.kind !== "task.completed") continue;
    const payload = asRecord(activity.payload);
    const agentId = payload ? asString(payload.taskId) : undefined;
    if (!payload || !agentId) continue;
    if (isBackgroundTaskActivity(payload)) continue;
    const text = asString(payload.summary);
    if (!text) continue;
    if (seenReplyKeys.has(normalizedReplyKey(agentId, text))) continue;
    if (seenActivityIds.has(activity.id)) continue;
    seenReplyKeys.add(normalizedReplyKey(agentId, text));
    seenActivityIds.add(activity.id);
    // Resolve provider owner stamps and bridge speaker stamps through the
    // same hierarchy before selecting the receiving conversation.
    const ownerAgentId = ownerOf(agentId, asString(payload.agentId));
    replies.push({
      id: `subagent-reply:${activity.id}`,
      activityId: activity.id,
      agentId,
      agentTitle: titleByAgentId.get(agentId) ?? null,
      ownerAgentId,
      turnId: activity.turnId,
      text,
      createdAt: activity.createdAt,
    });
  }

  // A thread with nothing to report returns one shared frozen value: callers
  // memoize on this result, and a fresh empty array per fold would invalidate
  // every downstream memo on each activity delta.
  if (replies.length === 0) {
    return EMPTY_SUBAGENT_REPLIES;
  }
  // Mobile Hermes does not provide the ES2023 change-by-copy array methods.
  return replies.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/** Explicit Resume is offered only when the server confirms durable wrapper recovery. */
export function canResumeCrossProviderTask(
  task: Pick<TaskState, "executionOwner" | "taskType" | "canResume" | "status"> | undefined,
): boolean {
  return (
    task?.executionOwner === "cross-provider" &&
    task.taskType === "cross_provider" &&
    task.canResume === true &&
    ["interrupted", "failed", "completed", "idle"].includes(task.status)
  );
}

/**
 * The replies one conversation received: the parent thread (`null`) or one
 * subagent reading its own children's reports.
 */
export function selectSubagentRepliesFor(
  replies: ReadonlyArray<SubagentReplyEntry>,
  ownerAgentId: string | null,
): ReadonlyArray<SubagentReplyEntry> {
  return replies.filter(
    (reply) => reply.ownerAgentId === ownerAgentId && reply.agentId !== ownerAgentId,
  );
}

/** Timeline-bypassing synthesized rows (Codex children, workflow members). */
export function isTimelineBypassActivity(activity: OrchestrationThreadActivity): boolean {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return false;
  }
  return (activity.payload as Record<string, unknown>).timelineBypass === true;
}

/**
 * Compact model chip text: strips vendor prefixes/date-or-context suffixes
 * ("claude-sonnet-5[1m]" → "sonnet-5[1m]", "claude-opus-4-20250514" →
 * "opus-4"). Unknown ids pass through untouched; effort appends as "· high".
 */
export function formatSubagentModelLabel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) {
    return null;
  }
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}
