/**
 * Native-provider subagent observability: a tolerant fold over persisted
 * task.* / tool.* thread activities into orchestration-v2-shaped subagent
 * state, plus the source-neutral panel model every client renders.
 *
 * This module is deliberately legacy-bridge code. When orchestration-v2's
 * subagent projection is available for a thread, deriveAgentPanelModel
 * prefers it (see the v2Projection parameter) and the fold is skipped; when
 * the v1 orchestrator is retired this file is deleted. Field names and
 * transition semantics copy the v2 stack (#4779) exactly so that swap is
 * mechanical.
 *
 * Invariants encoded here trace to shipped bugs in the prior PRs (#4220,
 * #3650, #4662): reusable identity vs one-shot activations, idle as a real
 * nonterminal state, provider-specific usage merges, first-write terminal
 * timestamps, reactivation clearing terminal detail, and order-robust
 * folding (completion can create an agent; a late start only fills
 * metadata).
 */
import {
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
  readonly sessionUrl?: string;
}

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

const RECENT_ACTIVITY_LIMIT = 6;
const SUMMARY_CHAR_LIMIT = 180;
const ROSTER_LIMIT = 100;

/**
 * True when this activity's payload does NOT belong on the Agents surface.
 * Classification happens exactly once, server-side at ingestion
 * (classifyTaskAgentKind → the persisted agentKind stamp); the client only
 * reads it. Rows without a stamp — legacy threads, pre-stamp servers — are
 * background by definition: they render in the ordinary work log, exactly
 * as they did before this feature existed.
 */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

function bounded(value: string): string {
  return value.length <= SUMMARY_CHAR_LIMIT ? value : `${value.slice(0, SUMMARY_CHAR_LIMIT - 1)}…`;
}

/** Appends to the ring buffer, deduping consecutive identical summaries. */
function appendActivity(
  entries: ReadonlyArray<SubagentActivityEntry>,
  at: string,
  summary: string,
): ReadonlyArray<SubagentActivityEntry> {
  const boundedSummary = bounded(summary);
  if (entries.length > 0 && entries[entries.length - 1]?.summary === boundedSummary) {
    return entries;
  }
  const next = [...entries, { at, summary: boundedSummary }];
  return next.length > RECENT_ACTIVITY_LIMIT ? next.slice(-RECENT_ACTIVITY_LIMIT) : next;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isOpaqueSubagentTitle(title: string, agentId: string): boolean {
  return title === agentId || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(title);
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asUsage(value: unknown): SubagentUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const totalTokens = asCount(record.totalTokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const usage: {
    totalTokens: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    toolUses?: number;
    durationMs?: number;
  } = { totalTokens };
  const inputTokens = asCount(record.inputTokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const cachedInputTokens = asCount(record.cachedInputTokens);
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const outputTokens = asCount(record.outputTokens);
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const reasoningOutputTokens = asCount(record.reasoningOutputTokens);
  if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
  const toolUses = asCount(record.toolUses);
  if (toolUses !== undefined) usage.toolUses = toolUses;
  const durationMs = asCount(record.durationMs);
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return usage;
}

/**
 * Provider-specific usage merge (#4779 semantics, verbatim):
 * - max-merge (Codex-style cumulative frames): field-wise maximum, idempotent
 *   under duplicate or late frames. Cumulative totals never shrink.
 * - accumulate (Claude-style activation deltas): not needed at this layer —
 *   Claude's task_progress usage is itself cumulative per task, so the fold
 *   also max-merges. The distinction matters when v2 sums activations.
 * Field-wise: a terminal payload carrying only totalTokens must not wipe a
 * known breakdown.
 */
function mergeUsageMax(
  current: SubagentUsage | null,
  incoming: SubagentUsage | undefined,
): SubagentUsage | null {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  const pick = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);
  const merged: {
    totalTokens: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    toolUses?: number;
    durationMs?: number;
  } = { totalTokens: Math.max(current.totalTokens, incoming.totalTokens) };
  const inputTokens = pick(current.inputTokens, incoming.inputTokens);
  if (inputTokens !== undefined) merged.inputTokens = inputTokens;
  const cachedInputTokens = pick(current.cachedInputTokens, incoming.cachedInputTokens);
  if (cachedInputTokens !== undefined) merged.cachedInputTokens = cachedInputTokens;
  const outputTokens = pick(current.outputTokens, incoming.outputTokens);
  if (outputTokens !== undefined) merged.outputTokens = outputTokens;
  const reasoningOutputTokens = pick(current.reasoningOutputTokens, incoming.reasoningOutputTokens);
  if (reasoningOutputTokens !== undefined) merged.reasoningOutputTokens = reasoningOutputTokens;
  const toolUses = pick(current.toolUses, incoming.toolUses);
  if (toolUses !== undefined) merged.toolUses = toolUses;
  const durationMs = pick(current.durationMs, incoming.durationMs);
  if (durationMs !== undefined) merged.durationMs = durationMs;
  return merged;
}

interface MutableAgent {
  id: string;
  kind: RuntimeSubagent["kind"];
  title: string;
  role: string | null;
  model: string | null;
  effort: string | null;
  status: RuntimeSubagentStatus;
  activationCount: number;
  usage: SubagentUsage | null;
  progress: string | null;
  lastToolName: string | null;
  result: string | null;
  error: string | null;
  outputFile: string | null;
  parentAgentId: string | null;
  agentIndex: number | null;
  phaseIndex: number | null;
  phaseTitle: string | null;
  attempt: number | null;
  workflowName: string | null;
  phases: ReadonlyArray<SubagentWorkflowPhase>;
  runHandles: SubagentRunHandles | null;
  recentActivity: ReadonlyArray<SubagentActivityEntry>;
  firstSeenAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

function kindFromPayload(
  payload: Record<string, unknown>,
  agentId: string,
): RuntimeSubagent["kind"] {
  if (asString(payload.taskType) === "local_workflow") {
    return "workflow";
  }
  if (payload.parentAgentId !== undefined || agentId.includes(":wf:")) {
    return "workflow_agent";
  }
  return "subagent";
}

/** Completion can create an agent (its start may have aged out of retention). */
function getOrCreate(
  agents: Map<string, MutableAgent>,
  id: string,
  payload: Record<string, unknown>,
  at: string,
): MutableAgent {
  const existing = agents.get(id);
  if (existing) {
    return existing;
  }
  const created: MutableAgent = {
    id,
    kind: kindFromPayload(payload, id),
    title: asString(payload.title) ?? asString(payload.detail) ?? id,
    role: asString(payload.role) ?? null,
    model: asString(payload.model) ?? null,
    effort: asString(payload.effort) ?? null,
    status: "pending",
    activationCount: 0,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: asString(payload.parentAgentId) ?? null,
    agentIndex: asCount(payload.agentIndex) ?? null,
    phaseIndex: asCount(payload.phaseIndex) ?? null,
    phaseTitle: asString(payload.phaseTitle) ?? null,
    attempt: asCount(payload.attempt) ?? null,
    workflowName: asString(payload.workflowName) ?? null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: at,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
  };
  agents.set(id, created);
  return created;
}

/** Metadata fill from any payload: never downgrades known values to null. */
function fillMetadata(agent: MutableAgent, payload: Record<string, unknown>): void {
  const title = asString(payload.title);
  if (
    title &&
    (!isOpaqueSubagentTitle(title, agent.id) || isOpaqueSubagentTitle(agent.title, agent.id))
  ) {
    agent.title = title;
  }
  const role = asString(payload.role);
  if (role) agent.role = role;
  const model = asString(payload.model);
  if (model) agent.model = model;
  const effort = asString(payload.effort);
  if (effort) agent.effort = effort;
  const parentAgentId = asString(payload.parentAgentId);
  if (parentAgentId) {
    agent.parentAgentId = parentAgentId;
    if (agent.kind === "subagent") agent.kind = "workflow_agent";
  }
  const workflowName = asString(payload.workflowName);
  if (workflowName) agent.workflowName = workflowName;
  if (asString(payload.taskType) === "local_workflow") agent.kind = "workflow";
  const agentIndex = asCount(payload.agentIndex);
  if (agentIndex !== undefined) agent.agentIndex = agentIndex;
  const phaseIndex = asCount(payload.phaseIndex);
  if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;
  const phaseTitle = asString(payload.phaseTitle);
  if (phaseTitle) agent.phaseTitle = phaseTitle;
  const attempt = asCount(payload.attempt);
  if (attempt !== undefined) {
    // A new attempt on a workflow slot is a reactivation of the same
    // identity: clear the previous attempt's terminal detail so the status
    // transition (terminal → running, in applyStatus) reads as a fresh run.
    // The activation bump lives ONLY in applyStatus — bumping here too
    // counted every retry twice (review finding: two attempts read "run 3").
    if (agent.attempt !== null && attempt > agent.attempt) {
      agent.result = null;
      agent.error = null;
      agent.completedAt = null;
    }
    agent.attempt = attempt;
  }
  const outputFile = asString(payload.outputFile);
  if (outputFile) agent.outputFile = outputFile;
  if (Array.isArray(payload.phases)) {
    const phases: SubagentWorkflowPhase[] = [];
    for (const entry of payload.phases) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const index = asCount(record.index);
      const phaseName = asString(record.title);
      if (index !== undefined && phaseName) {
        phases.push({ index, title: phaseName });
      }
    }
    if (phases.length > 0) {
      agent.phases = phases.slice().sort((a, b) => a.index - b.index);
    }
  }
  if (typeof payload.runHandles === "object" && payload.runHandles !== null) {
    const record = payload.runHandles as Record<string, unknown>;
    const runHandles: {
      runId?: string;
      scriptPath?: string;
      transcriptDir?: string;
      sessionUrl?: string;
    } = {};
    const runId = asString(record.runId);
    if (runId) runHandles.runId = runId;
    const scriptPath = asString(record.scriptPath);
    if (scriptPath) runHandles.scriptPath = scriptPath;
    const transcriptDir = asString(record.transcriptDir);
    if (transcriptDir) runHandles.transcriptDir = transcriptDir;
    // Defense-in-depth: the adapter already sanitizes, but payloads are not
    // schema-validated on the read path (shipped XSS lesson).
    const sessionUrl = asString(record.sessionUrl);
    if (sessionUrl && /^https?:\/\//i.test(sessionUrl)) runHandles.sessionUrl = sessionUrl;
    if (Object.keys(runHandles).length > 0) {
      agent.runHandles = { ...agent.runHandles, ...runHandles };
    }
  }
}

function applyStatus(agent: MutableAgent, status: RuntimeSubagentStatus, at: string): void {
  const wasTerminal = isTerminalSubagentStatus(agent.status);
  const isTerminal = isTerminalSubagentStatus(status);
  if (wasTerminal && (isTerminal || status === "idle")) {
    // Duplicate terminal events and late historical-idle metadata are
    // idempotent: first write wins and timestamps don't slide. Waiting must
    // still reactivate a child that resumes directly into an approval gate.
    return;
  }
  if ((wasTerminal || agent.status === "idle") && (status === "running" || status === "pending")) {
    // Reactivation: same identity, new run. Clear the previous run's terminal
    // detail so a live card never shows the prior run's output.
    agent.activationCount += 1;
    agent.result = null;
    agent.error = null;
    agent.completedAt = null;
    if (status === "running") {
      agent.startedAt = at;
    }
  }
  if (status === "running" && agent.startedAt === null) {
    agent.startedAt = at;
  }
  if (isTerminal && agent.completedAt === null) {
    agent.completedAt = at;
  }
  agent.status = status;
}

// Map, not object literal: payloads aren't schema-validated on the read
// path, so a status like "toString" must miss instead of resolving an
// inherited Function through the prototype chain.
const TASK_COMPLETED_STATUS: ReadonlyMap<string, RuntimeSubagentStatus> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["stopped", "interrupted"],
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function asRuntimeStatus(value: unknown): RuntimeSubagentStatus | undefined {
  return typeof value === "string" && KNOWN_STATUSES.has(value)
    ? (value as RuntimeSubagentStatus)
    : undefined;
}

/**
 * Folds a thread's persisted activities into subagent state. Tolerant by
 * construction: malformed rows are skipped individually; unknown kinds are
 * ignored. Pure — memoize by activity-list identity at the atom layer.
 *
 * sessionLive=false derives interruption: background tasks die with their
 * provider session, so agents whose terminal rows were lost (server
 * restart, crash) must not read as running forever (review finding: a dead
 * session left a panel full of "Working" agents while the sidebar showed
 * nothing). Idle is preserved — a resumable Codex child stays resumable.
 */
export function foldSubagentActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: {
    readonly sessionLive?: boolean;
    /**
     * Agent ids that must survive the roster cap (e.g. the transcript the
     * user currently has open). Without this, live activity pushing an old
     * settled agent past the cap silently slams the open transcript shut.
     */
    readonly protectedAgentIds?: ReadonlyArray<string>;
  },
): ReadonlyArray<RuntimeSubagent> {
  const agents = new Map<string, MutableAgent>();

  for (const activity of activities) {
    if (typeof activity.payload !== "object" || activity.payload === null) {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    const at = activity.createdAt;

    switch (activity.kind) {
      case "task.started": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Only real agents join the roster. Shells, monitors, and plan-mode
        // tasks are background work — they render in the ordinary work log,
        // not the Agents surface (a "Run 12s stall" shell is not a subagent).
        if (isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        // Order-robustness: a start row arriving after a terminal state is a
        // late/out-of-order delivery and only fills metadata — it must not
        // reopen the run. Reactivation comes exclusively from explicit
        // status transitions (task.updated / progress status). Guard on the
        // status itself, not activationCount: a task first seen via a
        // terminal task.updated has zero activations but is still settled
        // (review finding: a late start reopened a failed child).
        if (agent.activationCount === 0 && !isTerminalSubagentStatus(agent.status)) {
          agent.activationCount = 1;
          agent.startedAt = agent.startedAt ?? at;
          agent.status = "running";
        } else if (agent.status === "idle") {
          applyStatus(agent, "running", at);
        }
        const detail = asString(payload.detail);
        if (detail && agent.title === agent.id) agent.title = detail;
        agent.updatedAt = at;
        break;
      }
      case "task.progress": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Membership is sticky per taskId: rows after the first (terminal
        // rows often carry only taskId+status, no marker fields) inherit the
        // first row's classification instead of being re-judged.
        const existed = agents.has(taskId);
        if (!existed && isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        if (agent.activationCount === 0) agent.activationCount = 1;
        const explicitStatus = asRuntimeStatus(payload.status);
        if (explicitStatus) {
          applyStatus(agent, explicitStatus, at);
        } else if (
          (payload.usageSnapshot !== true || !existed) &&
          !isTerminalSubagentStatus(agent.status) &&
          agent.status !== "idle"
        ) {
          applyStatus(agent, "running", at);
        }
        const summary = asString(payload.summary);
        if (summary) {
          agent.progress = bounded(summary);
          agent.recentActivity = appendActivity(agent.recentActivity, at, summary);
        }
        const lastToolName = asString(payload.lastToolName);
        if (lastToolName) {
          agent.lastToolName = lastToolName;
          if (!summary) {
            agent.recentActivity = appendActivity(agent.recentActivity, at, `▸ ${lastToolName}`);
          }
        }
        const error = asString(payload.error);
        if (error) agent.error = bounded(error);
        agent.usage = mergeUsageMax(agent.usage, asUsage(payload.typedUsage));
        agent.updatedAt = at;
        break;
      }
      case "task.updated": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Membership is sticky per taskId: rows after the first (terminal
        // rows often carry only taskId+status, no marker fields) inherit the
        // first row's classification instead of being re-judged.
        if (!agents.has(taskId) && isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        // A task first seen via task.updated (start row aged out) has run at
        // least once — zero activations would misreport "run 0" and let a
        // later start row treat it as never-started (review finding).
        if (agent.activationCount === 0) agent.activationCount = 1;
        const wasTerminal = isTerminalSubagentStatus(agent.status);
        const status = asRuntimeStatus(payload.status);
        if (status) applyStatus(agent, status, at);
        const error = asString(payload.error);
        if (error) agent.error = bounded(error);
        // Provider end time beats ingestion time for the transition that
        // actually settled the run (applyStatus fills completedAt with the
        // activity timestamp first, so check the transition, not null).
        const endedAt = asString(payload.endedAt);
        if (endedAt && !wasTerminal && isTerminalSubagentStatus(agent.status)) {
          agent.completedAt = endedAt;
        }
        agent.updatedAt = at;
        break;
      }
      case "task.completed": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Membership is sticky per taskId: rows after the first (terminal
        // rows often carry only taskId+status, no marker fields) inherit the
        // first row's classification instead of being re-judged.
        if (!agents.has(taskId) && isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        if (agent.activationCount === 0) agent.activationCount = 1;
        // Already-terminal: status and timestamps are frozen (first write
        // wins, duplicates must not slide them) but the completion still
        // ENRICHES — Claude commonly emits terminal task.updated before
        // task.completed, and the completion carries the result summary and
        // final usage the update lacked (review finding: the early return
        // dropped both). Fill-if-missing keeps duplicate completions from
        // replacing the first result.
        const summary = asString(payload.summary) ?? asString(payload.detail);
        if (isTerminalSubagentStatus(agent.status)) {
          if (summary) {
            if (agent.status === "failed") {
              agent.error = agent.error ?? bounded(summary);
            } else {
              agent.result = agent.result ?? bounded(summary);
            }
          }
          agent.usage = mergeUsageMax(agent.usage, asUsage(payload.typedUsage));
          break;
        }
        const status = TASK_COMPLETED_STATUS.get(asString(payload.status) ?? "") ?? "completed";
        applyStatus(agent, status, at);
        if (summary) {
          if (status === "failed") {
            agent.error = agent.error ?? bounded(summary);
          } else {
            agent.result = bounded(summary);
          }
        }
        agent.usage = mergeUsageMax(agent.usage, asUsage(payload.typedUsage));
        agent.updatedAt = at;
        break;
      }
      case "tool.progress": {
        // Agent-owned heartbeat: "what it's doing right now".
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const agent = agents.get(taskId);
        if (!agent) break;
        const toolName = asString(payload.toolName);
        if (toolName) {
          agent.lastToolName = toolName;
          agent.recentActivity = appendActivity(agent.recentActivity, at, `▸ ${toolName}`);
        }
        agent.updatedAt = at;
        break;
      }
      default:
        break;
    }
  }

  // Consistency pass: when a workflow coordinator has settled, members that
  // never received their own terminal row cannot still be in-flight — the
  // run is over. Cascade the coordinator's outcome so stalled member rows
  // don't read as working forever (live-test finding: statuses drifted
  // whenever member terminal rows were lost or never emitted).
  for (const agent of agents.values()) {
    if (agent.kind !== "workflow" || !isTerminalSubagentStatus(agent.status)) {
      continue;
    }
    for (const member of agents.values()) {
      if (member.parentAgentId !== agent.id) {
        continue;
      }
      if (isTerminalSubagentStatus(member.status) || member.status === "idle") {
        continue;
      }
      member.status = agent.status === "completed" ? "completed" : "interrupted";
      member.completedAt = member.completedAt ?? agent.completedAt ?? agent.updatedAt;
      member.updatedAt = agent.updatedAt;
    }
  }

  // Session death orphans every live agent: no process remains to finish
  // them. Mirrors the server-side liveness registry clearing on
  // session.exited, so panel and sidebar can never disagree.
  if (options?.sessionLive === false) {
    for (const agent of agents.values()) {
      if (isActiveSubagentStatus(agent.status)) {
        agent.status = "interrupted";
        agent.completedAt = agent.completedAt ?? agent.updatedAt;
      }
    }
  }

  let roster = Array.from(agents.values());
  if (roster.length > ROSTER_LIMIT) {
    // Prefer live, then waiting/idle, then newest settled. Protected ids
    // (the open transcript) always survive the cut.
    const protectedIds =
      options?.protectedAgentIds !== undefined && options.protectedAgentIds.length > 0
        ? new Set(options.protectedAgentIds)
        : null;
    const rank = (agent: MutableAgent): number =>
      isActiveSubagentStatus(agent.status) ? 0 : agent.status === "idle" ? 1 : 2;
    roster = roster
      .slice()
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
      .filter((agent, index) => index < ROSTER_LIMIT || protectedIds?.has(agent.id));
  }

  return roster.map((agent) => ({ ...agent }));
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

/**
 * Source-neutral view model. When the orchestration-v2 subagent projection
 * exists for the thread, pass it as v2Projection and it wins outright — the
 * two sources are never merged (duplicate-agents failure mode). Until v2
 * lands, callers pass null and the native fold output is used.
 */
export function deriveAgentPanelModel({
  agents,
  v2Projection,
}: {
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly v2Projection?: ReadonlyArray<RuntimeSubagent> | null;
}): AgentPanelModel {
  const source = v2Projection ?? agents;
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
 * (`deriveWorkLogEntries`, `deriveTurnPlans`, `deriveLatestContextWindowSnapshot`)
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
      asString(payload.agentId) !== agentId ||
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

/**
 * Rows that belong to the PARENT conversation's own surfaces (its work log,
 * its plan chip, its context meter).
 *
 * A row the server attributed to a subagent is that agent's, and the parent
 * must skip it rather than render it or — worse for single-value surfaces like
 * the context meter and the plan chip — read a child's value as its own.
 */
export function isParentScopedActivity(activity: OrchestrationThreadActivity): boolean {
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
    if (!payload || asString(payload.taskId) !== agentId) continue;
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

function normalizedReplyKey(agentId: string, text: string): string {
  return `${agentId} ${text.trim()}`;
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
/**
 * Statuses that end one of a subagent's turns. A child that goes idle has
 * finished answering; a terminal one obviously has.
 */
const REPLY_BOUNDARY_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function deriveSubagentReplies(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  messages: ReadonlyArray<OrchestrationMessage> = [],
): ReadonlyArray<SubagentReplyEntry> {
  // Launching tool call -> the agent it launched, and each agent's best title.
  const agentIdByToolUseId = new Map<string, string>();
  const agentIdByAlias = new Map<string, string>();
  const titleByAgentId = new Map<string, string>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = asRecord(activity.payload);
    const taskId = payload ? asString(payload.taskId) : undefined;
    if (!payload || !taskId) continue;
    const toolUseId = asString(payload.toolUseId);
    if (toolUseId) agentIdByToolUseId.set(toolUseId, taskId);
    const title = asString(payload.title) ?? asString(payload.description);
    if (title && !isOpaqueSubagentTitle(title, taskId)) titleByAgentId.set(taskId, title);
    agentIdByAlias.set(taskId.toLowerCase(), taskId);
    const pathAlias = agentPathLeaf(payload.agentPath);
    if (pathAlias) agentIdByAlias.set(pathAlias.toLowerCase(), taskId);
    if (title) agentIdByAlias.set(title.toLowerCase(), taskId);
  }

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
    const ownerAgentId = asString(payload.agentId) ?? null;
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
    // `agentId` on a task row names the conversation that OWNS the task, which
    // is exactly the conversation its report is addressed to.
    const ownerAgentId = asString(payload.agentId) ?? null;
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

  // Third source, for providers whose collaboration protocol carries no result
  // payload at all: the child's own turn-final message.
  //
  // Codex is the case in point — its `collabAgentToolCall` thread item has
  // fields for the prompt, the receivers, the model and the status, but none
  // for output, so the parent's call cannot carry the child's answer. What the
  // parent read is the last thing the child said before it went idle.
  //
  // Applied ONLY to agents that produced no reply from the two authoritative
  // sources above. That partitions cleanly by provider (a Claude agent always
  // returns a tool result or a task summary; a Codex child never does) and
  // makes double-rendering the same report structurally impossible rather than
  // dependent on comparing texts that a provider may have reformatted.
  const agentsWithExplicitReplies = new Set(replies.map((reply) => reply.agentId));
  const boundariesByAgent = new Map<
    string,
    Array<{
      createdAt: string;
      turnId: OrchestrationThreadActivity["turnId"];
      owner: string | null;
    }>
  >();
  for (const activity of activities) {
    if (activity.kind !== "task.updated" && activity.kind !== "task.completed") continue;
    const payload = asRecord(activity.payload);
    const taskId = payload ? asString(payload.taskId) : undefined;
    if (!payload || !taskId || agentsWithExplicitReplies.has(taskId)) continue;
    if (isBackgroundTaskActivity(payload)) continue;
    const status = asString(payload.status);
    if (!status || !REPLY_BOUNDARY_STATUSES.has(status)) continue;
    const boundaries = boundariesByAgent.get(taskId) ?? [];
    boundaries.push({
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      owner: asString(payload.agentId) ?? null,
    });
    boundariesByAgent.set(taskId, boundaries);
  }

  for (const [agentId, boundaries] of boundariesByAgent) {
    const agentMessages = messages
      .filter((message) => message.agentId === agentId && message.role === "assistant")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (agentMessages.length === 0) continue;
    const ordered = [...boundaries].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    let nextUnclaimed = 0;
    for (const boundary of ordered) {
      let claimed = -1;
      for (let index = nextUnclaimed; index < agentMessages.length; index += 1) {
        if (agentMessages[index]!.createdAt.localeCompare(boundary.createdAt) <= 0) {
          claimed = index;
        } else {
          break;
        }
      }
      // Nothing new since the previous boundary: repeated idle rows (a status
      // patch and a turn completion often both land) must not re-send the same
      // message.
      if (claimed < nextUnclaimed) continue;
      const message = agentMessages[claimed]!;
      nextUnclaimed = claimed + 1;
      const text = message.text.trim();
      if (text.length === 0) continue;
      replies.push({
        id: `subagent-reply:message:${message.id}`,
        activityId: message.id,
        agentId,
        agentTitle: titleByAgentId.get(agentId) ?? null,
        ownerAgentId: boundary.owner,
        turnId: message.turnId,
        text,
        createdAt: boundary.createdAt,
      });
    }
  }

  // Mobile Hermes does not provide the ES2023 change-by-copy array methods.
  return replies.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
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
  return replies.filter((reply) => reply.ownerAgentId === ownerAgentId);
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
