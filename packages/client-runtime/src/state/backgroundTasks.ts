/**
 * Background-task observability: the exact complement of the subagent fold.
 *
 * `foldSubagentActivities` keeps the task.* rows ingestion stamped
 * `agentKind: "agent"` and drops everything else. Everything else is real
 * work the user cares about — background shells, Monitor watch loops,
 * plan-mode bookkeeping, a subagent's own internal shells — and until this
 * module existed it had no home but the ordinary work log, where a
 * long-running `pnpm test --watch` was one grey line that never updated.
 *
 * This fold keeps the rows the subagent fold drops, deciding membership from
 * EVIDENCE rather than from the stamp alone (see pass 1 of
 * foldBackgroundTasks). Both read the same durable `thread.activities`, so
 * the panel survives reload, resume and reconnect with no extra persistence.
 *
 * The two folds agree on every row the providers actually emit. They can
 * still disagree in one residual case: if a task's identity is lost
 * server-side (a resumed session whose registry is empty) AND the roster
 * snapshot that repairs it has not arrived yet, a terminal row carries no
 * taskType, ingestion defaults it to "agent", and the untouched subagent fold
 * will build a phantom agent from it. This fold refuses to compound that by
 * also dropping the real task. Closing it for good means making the stamp
 * authoritative inside subagentRuntime.ts, which is deliberately not modified
 * here; ClaudeAdapter's roster rehydration removes the usual cause.
 *
 * The wait model is deliberately provider-neutral: it is derived from the
 * shared request pipeline (`approval.requested` / `user-input.requested`,
 * which every adapter feeds) plus task ownership, so a provider that exposes
 * no task lifecycle at all still gets correct "waiting on" lines.
 */
import { MONITOR_TASK_TYPES, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { isBackgroundTaskActivity, type RuntimeSubagentStatus } from "./subagentRuntime.ts";

/**
 * Presentation bucket for a background task. Derived from the provider's
 * task_type once, at fold time, so the UI never re-parses provider
 * vocabulary. Unknown types land in "other" rather than being dropped: a new
 * SDK task type must degrade to a visible row, not an invisible one.
 */
export type BackgroundTaskKind = "shell" | "monitor" | "plan" | "other";

/** Same vocabulary as subagents so one status legend serves both sections. */
export type BackgroundTaskStatus = RuntimeSubagentStatus;

export interface RuntimeBackgroundTask {
  readonly id: string;
  readonly kind: BackgroundTaskKind;
  /** Raw provider task_type when known — kept for diagnostics and tooltips. */
  readonly taskType: string | null;
  /** Command line, monitor name, or description, whichever the provider gave. */
  readonly label: string;
  /** Owning subagent's task id; null means the main agent launched it. */
  readonly ownerAgentId: string | null;
  readonly status: BackgroundTaskStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Latest progress line, already length-bounded. */
  readonly progress: string | null;
  readonly result: string | null;
  readonly error: string | null;
  /**
   * The provider explicitly detached this task from its turn (Claude's
   * `is_backgrounded`). A backgrounded task outlives the turn that started
   * it, which is exactly the case the panel exists for.
   */
  readonly backgrounded: boolean;
  /**
   * SDK `skip_transcript`: ambient housekeeping the provider asks clients to
   * hide from the inline transcript while noting it "may still appear in a
   * tasks panel". Rendered, but de-emphasized and sorted last.
   */
  readonly ambient: boolean;
  /** First retained observation — the list's stable display order. */
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalBackgroundTaskStatus(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Live = still consuming the machine. Idle is settled-but-resumable. */
export function isActiveBackgroundTaskStatus(status: BackgroundTaskStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

const SHELL_TASK_TYPES: ReadonlySet<string> = new Set(["local_bash", "shell"]);
const PLAN_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

/**
 * task_type → presentation bucket. MONITOR_TASK_TYPES is the contracts-owned
 * watch-loop set and deliberately lumps background shells in with monitors
 * (a shell that outlives its turn is a watch loop in practice); the panel
 * still wants them visually distinct, so shells are split back out here.
 */
export function backgroundTaskKind(taskType: string | null | undefined): BackgroundTaskKind {
  if (taskType === null || taskType === undefined) return "other";
  if (SHELL_TASK_TYPES.has(taskType)) return "shell";
  if (PLAN_TASK_TYPES.has(taskType)) return "plan";
  if (MONITOR_TASK_TYPES.has(taskType)) return "monitor";
  return "other";
}

const SUMMARY_CHAR_LIMIT = 180;
const TASK_LIMIT = 200;

function bounded(value: string): string {
  return value.length <= SUMMARY_CHAR_LIMIT ? value : `${value.slice(0, SUMMARY_CHAR_LIMIT - 1)}…`;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function asStatus(value: unknown): BackgroundTaskStatus | undefined {
  return typeof value === "string" && RUNTIME_STATUSES.has(value)
    ? (value as BackgroundTaskStatus)
    : undefined;
}

/** task.completed's three-value status → the shared vocabulary. */
const COMPLETED_STATUS: ReadonlyMap<string, BackgroundTaskStatus> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["stopped", "cancelled"],
]);

interface MutableTask {
  id: string;
  kind: BackgroundTaskKind;
  taskType: string | null;
  label: string;
  ownerAgentId: string | null;
  status: BackgroundTaskStatus;
  startedAt: string | null;
  endedAt: string | null;
  progress: string | null;
  result: string | null;
  error: string | null;
  backgrounded: boolean;
  ambient: boolean;
  firstSeenAt: string;
  updatedAt: string;
}

function getOrCreate(tasks: Map<string, MutableTask>, taskId: string, at: string): MutableTask {
  const existing = tasks.get(taskId);
  if (existing) return existing;
  const created: MutableTask = {
    id: taskId,
    kind: "other",
    taskType: null,
    label: taskId,
    ownerAgentId: null,
    status: "running",
    startedAt: null,
    endedAt: null,
    progress: null,
    result: null,
    error: null,
    backgrounded: false,
    ambient: false,
    firstSeenAt: at,
    updatedAt: at,
  };
  tasks.set(taskId, created);
  return created;
}

/**
 * Identity fields ride on every row (ingestion repeats the linkage bundle),
 * so metadata fills in from whichever row survived activity retention.
 * Fill-if-absent: a later thinner row must never blank a known field.
 */
function fillMetadata(task: MutableTask, payload: Record<string, unknown>): void {
  const taskType = asString(payload.taskType);
  if (taskType && task.taskType === null) {
    task.taskType = taskType;
    task.kind = backgroundTaskKind(taskType);
  }
  const owner = asString(payload.agentId);
  if (owner && task.ownerAgentId === null) task.ownerAgentId = owner;
  // `detail` is ingestion's truncated copy of the provider description; for a
  // shell that is the command line, which is the only label a shell ever gets.
  const label =
    asString(payload.title) ?? asString(payload.description) ?? asString(payload.detail);
  if (label && task.label === task.id) task.label = bounded(label);
  if (payload.isBackgrounded === true) task.backgrounded = true;
  else if (payload.isBackgrounded === false) task.backgrounded = false;
  if (payload.skipTranscript === true) task.ambient = true;
}

/**
 * First terminal write wins for the settle timestamp — duplicate terminal
 * rows (Claude emits a terminal task.updated then a task.completed) must not
 * slide the clock. A non-terminal status after a terminal one is a genuine
 * restart and clears the previous outcome.
 */
function applyStatus(task: MutableTask, status: BackgroundTaskStatus, at: string): void {
  const wasTerminal = isTerminalBackgroundTaskStatus(task.status);
  // Terminal -> idle is late metadata, not a transition: a settled task did
  // not become resumable. Applying it left the old endedAt, result and error
  // hanging off a row now claiming to be idle. The roster fold ignores it for
  // the same reason.
  if (wasTerminal && status === "idle") return;
  const wasResting = wasTerminal || task.status === "idle";
  task.status = status;
  if (isTerminalBackgroundTaskStatus(status)) {
    if (!wasTerminal) task.endedAt = at;
    return;
  }
  if (wasResting && isActiveBackgroundTaskStatus(status)) {
    task.endedAt = null;
    task.result = null;
    task.error = null;
    // A resumed task times its NEW run. Keeping the original start made a
    // watch loop that woke up claim an elapsed time spanning the whole
    // interval it spent settled or idle.
    task.startedAt = at;
    return;
  }
  if (task.startedAt === null) task.startedAt = at;
}

/**
 * Folds a thread's persisted activities into background-task state.
 *
 * Tolerant by construction (malformed rows skipped individually, unknown
 * kinds ignored) and pure, so callers memoize on activity-list identity.
 *
 * sessionLive=false marks still-running tasks interrupted: background work
 * dies with its provider session, so a server restart must not leave a panel
 * full of shells that claim to be running. Idle survives — it is already
 * settled.
 */
export function foldBackgroundTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly sessionLive?: boolean },
): ReadonlyArray<RuntimeBackgroundTask> {
  const tasks = new Map<string, MutableTask>();

  // Pass 1 decides membership for a whole task id at once, on EVIDENCE.
  //
  // Per-row stickiness let a legacy unstamped row be claimed here while a
  // later stamped row was claimed by the subagent fold, so one task rendered
  // in both sections. But trusting the stamp alone is just as wrong in the
  // other direction: a thin terminal row (a reconnect drops the adapter's
  // remembered linkage, so a notification carries only taskId + status) has
  // no taskType, and classifyTaskAgentKind defaults those to "agent". Letting
  // that evidence-free stamp flip a known background shell would make the
  // shell vanish from this panel the moment it finished.
  //
  // So a stamp only counts when the row carries something agent-shaped to
  // back it up, and a task is claimed here only when some row positively
  // describes background work. An id with no evidence either way is left to
  // the roster rather than duplicated into both surfaces.
  const AGENT_EVIDENCE_KEYS = [
    "taskType",
    "role",
    "workflowName",
    "parentAgentId",
    "agentIndex",
    "phaseIndex",
  ] as const;
  const DESCRIPTIVE_KEYS = ["taskType", "detail", "description", "title", "summary"] as const;

  const agentTaskIds = new Set<string>();
  const backgroundTaskIds = new Set<string>();
  for (const activity of activities) {
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    const taskId = asString(payload.taskId);
    if (!taskId) continue;
    if (isBackgroundTaskActivity(payload)) {
      if (DESCRIPTIVE_KEYS.some((key) => payload[key] !== undefined)) {
        backgroundTaskIds.add(taskId);
      }
    } else if (
      payload.timelineBypass === true ||
      AGENT_EVIDENCE_KEYS.some((key) => payload[key] !== undefined)
    ) {
      agentTaskIds.add(taskId);
    }
  }

  for (const activity of activities) {
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    const taskId = asString(payload.taskId);
    // Contradictory evidence resolves to agent, matching the subagent fold.
    if (!taskId || agentTaskIds.has(taskId) || !backgroundTaskIds.has(taskId)) continue;
    const at = activity.createdAt;

    switch (activity.kind) {
      case "task.started": {
        const task = getOrCreate(tasks, taskId, at);
        fillMetadata(task, payload);
        // Order-robustness mirrors the subagent fold: a start row arriving
        // after a terminal row is a late delivery and only fills metadata.
        // Reopening comes exclusively from an explicit status transition.
        if (task.startedAt === null && !isTerminalBackgroundTaskStatus(task.status)) {
          task.startedAt = at;
          task.status = "running";
        } else if (task.status === "idle") {
          applyStatus(task, "running", at);
        }
        task.updatedAt = at;
        break;
      }
      case "task.progress": {
        const task = getOrCreate(tasks, taskId, at);
        fillMetadata(task, payload);
        const status = asStatus(payload.status);
        if (status) applyStatus(task, status, at);
        // A task first seen through progress (its start row aged out) still
        // needs an origin, or the row renders with no elapsed time at all.
        if (task.startedAt === null && !isTerminalBackgroundTaskStatus(task.status)) {
          task.startedAt = at;
        }
        const progress = asString(payload.summary) ?? asString(payload.detail);
        if (progress) task.progress = bounded(progress);
        const error = asString(payload.error);
        if (error) task.error = bounded(error);
        task.updatedAt = at;
        break;
      }
      case "task.updated": {
        const task = getOrCreate(tasks, taskId, at);
        fillMetadata(task, payload);
        const wasTerminal = isTerminalBackgroundTaskStatus(task.status);
        const status = asStatus(payload.status);
        // First terminal write wins, exactly as task.completed does: two
        // terminal rows disagreeing (a `killed` patch after a `failed` one)
        // must not let event kind or arrival order decide the outcome. A
        // non-terminal status is a genuine restart and still applies.
        if (status && !(wasTerminal && isTerminalBackgroundTaskStatus(status))) {
          applyStatus(task, status, at);
        }
        const error = asString(payload.error);
        if (error) task.error = bounded(error);
        // The provider's own end time beats the ingestion timestamp for the
        // transition that actually settled the task.
        const endedAt = asString(payload.endedAt);
        if (endedAt && !wasTerminal && isTerminalBackgroundTaskStatus(task.status)) {
          task.endedAt = endedAt;
        }
        task.updatedAt = at;
        break;
      }
      case "task.completed": {
        const task = getOrCreate(tasks, taskId, at);
        fillMetadata(task, payload);
        const summary = asString(payload.summary) ?? asString(payload.detail);
        const status = COMPLETED_STATUS.get(asString(payload.status) ?? "") ?? "completed";
        if (isTerminalBackgroundTaskStatus(task.status)) {
          // Already settled by an earlier terminal row: timestamps freeze,
          // but the completion still carries the result the update lacked.
          if (summary) {
            if (task.status === "failed") task.error = task.error ?? bounded(summary);
            else task.result = task.result ?? bounded(summary);
          }
          break;
        }
        applyStatus(task, status, at);
        if (summary) {
          if (status === "failed") task.error = task.error ?? bounded(summary);
          else task.result = bounded(summary);
        }
        task.updatedAt = at;
        break;
      }
      default:
        break;
    }
  }

  const sessionLive = options?.sessionLive ?? true;
  const rows = [...tasks.values()].map<RuntimeBackgroundTask>((task) => {
    const orphaned = !sessionLive && isActiveBackgroundTaskStatus(task.status);
    return {
      ...task,
      status: orphaned ? "interrupted" : task.status,
      endedAt: orphaned ? (task.endedAt ?? task.updatedAt) : task.endedAt,
    };
  });

  // Newest first: a background panel is read top-down for "what is running
  // now". The cap drops the oldest settled rows, never a live one.
  rows.sort(
    (left, right) =>
      right.firstSeenAt.localeCompare(left.firstSeenAt) || right.id.localeCompare(left.id),
  );
  if (rows.length <= TASK_LIMIT) return rows;
  // Retention priority, then newest-first inside each band. Splitting merely
  // on terminal-vs-not let 200 idle rows evict a live shell or a recent
  // failure, which are the two things the panel exists to show.
  const band = (row: RuntimeBackgroundTask): number => {
    if (isActiveBackgroundTaskStatus(row.status)) return 0;
    if (row.status === "failed") return 1;
    if (row.status === "interrupted") return 2;
    if (row.status === "idle") return 3;
    return 4;
  };
  return rows
    .slice()
    .sort(
      (left, right) =>
        band(left) - band(right) || right.firstSeenAt.localeCompare(left.firstSeenAt),
    )
    .slice(0, TASK_LIMIT);
}

/* -------------------------------------------------------------------------
 * Wait states
 * ---------------------------------------------------------------------- */

/** What an agent is blocked on, most user-actionable first. */
export type AgentWaitKind = "approval" | "user-input" | "agents" | "tasks";

export interface OpenRequestWait {
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
  /** Human label, e.g. "Command approval". */
  readonly label: string;
  readonly since: string;
  /** Owning subagent when a child raised it; null means the main agent. */
  readonly ownerId: string | null;
}

/** A wait the provider itself named, with the instant it began. */
export interface AgentNamedWait {
  readonly reason: "approval" | "user-input";
  readonly since: string;
}

export interface AgentWaitState {
  /** Owning agent's task id; null is the main agent. */
  readonly ownerId: string | null;
  readonly ownerLabel: string;
  readonly kind: AgentWaitKind;
  /** One-line description of the blocker(s). */
  readonly label: string;
  /** When the wait began, for the ticking elapsed timer. */
  readonly since: string | null;
  /** Blocking task/agent ids, so the row can link into the roster. */
  readonly blockingIds: ReadonlyArray<string>;
  /** True when only the user can unblock this — the panel highlights those. */
  readonly needsUser: boolean;
}

/**
 * Mirrors the web app's `isStalePendingRequestFailureDetail`: these details
 * mean the provider no longer knows the request, so the pending state is
 * dead. Every other failure detail is transport noise and leaves the request
 * open.
 */
function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

const APPROVAL_LABELS: Readonly<Record<string, string>> = {
  command: "Command approval",
  "file-read": "File-read approval",
  "file-change": "File-change approval",
  "mcp-elicitation": "App access approval",
};

/**
 * Open approval / user-input requests, from the same durable activity stream
 * every other derivation reads.
 *
 * This is intentionally a narrower sibling of the web app's
 * `derivePendingApprovals`, which additionally decodes options, appName and
 * question schemas to render the answer card. The panel needs only "who is
 * blocked, on what, since when", and living in client-runtime lets mobile
 * reuse it.
 */
export function deriveOpenRequestWaits(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OpenRequestWait> {
  const open = new Map<string, OpenRequestWait>();

  for (const activity of activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = payload ? asString(payload.requestId) : undefined;
    if (!requestId) continue;

    switch (activity.kind) {
      case "approval.requested": {
        const requestKind = asString(payload?.requestKind);
        open.set(requestId, {
          requestId,
          kind: "approval",
          label: (requestKind ? APPROVAL_LABELS[requestKind] : undefined) ?? "Approval",
          since: activity.createdAt,
          ownerId: asString(payload?.agentId) ?? null,
        });
        break;
      }
      case "user-input.requested":
        open.set(requestId, {
          requestId,
          kind: "user-input",
          label: "Your answer",
          since: activity.createdAt,
          ownerId: asString(payload?.agentId) ?? null,
        });
        break;
      case "approval.resolved":
      case "user-input.resolved":
        open.delete(requestId);
        break;
      // A respond failure closes the wait ONLY when the provider says it has
      // already forgotten the request. Ordinary transport failures also land
      // here, and treating those as resolutions made the strip vanish while
      // the answer card was still on screen waiting to be answered.
      case "provider.approval.respond.failed":
      case "provider.user-input.respond.failed":
        if (isStalePendingRequestFailureDetail(asString(payload?.detail))) {
          open.delete(requestId);
        }
        break;
      default:
        break;
    }
  }

  return [...open.values()].toSorted((left, right) => left.since.localeCompare(right.since));
}

/**
 * Per-agent wait reasons, for providers that name them.
 *
 * Only Codex does today: its `collabAgent/statusChanged` activeFlags
 * distinguish waitingOnApproval from waitingOnUserInput, which the adapter
 * forwards as `waitReason` on task.updated. Read straight from the activity
 * stream rather than from `RuntimeSubagent` so the subagent fold stays
 * untouched. A later non-waiting status clears the reason: a resumed child is
 * not still waiting on the thing that blocked it.
 */
export function deriveAgentWaitReasons(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, AgentNamedWait> {
  const reasons = new Map<string, AgentNamedWait>();
  for (const activity of activities) {
    if (activity.kind !== "task.updated") continue;
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    const taskId = asString(payload.taskId);
    if (!taskId) continue;
    const status = asStatus(payload.status);
    if (status === undefined) continue;
    if (status !== "waiting") {
      reasons.delete(taskId);
      continue;
    }
    const reason = payload.waitReason;
    if (reason === "approval" || reason === "user-input") {
      // `since` is when the WAIT started, not when the agent did: a child
      // that worked for an hour and has been blocked for ten seconds must
      // not report an hour of waiting. Re-entering the same reason keeps the
      // original instant so the timer does not restart on every repeat.
      const existing = reasons.get(taskId);
      reasons.set(taskId, {
        reason,
        since: existing?.reason === reason ? existing.since : activity.createdAt,
      });
    } else {
      reasons.delete(taskId);
    }
  }
  return reasons;
}

/**
 * Task ids that cannot block whoever started them: work the provider
 * explicitly detached (Claude's `is_backgrounded`) and work that is
 * asynchronous by protocol (Codex child agents). In both cases the launching
 * tool call returned immediately and the turn carried on, so presenting them
 * as a dependency would assert a relationship no provider reports.
 *
 * Read from the activity stream because `RuntimeSubagent` carries no such
 * field and this module deliberately does not modify the subagent fold.
 */
export function deriveDetachedTaskIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const detached = new Set<string>();
  for (const activity of activities) {
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    const taskId = asString(payload.taskId);
    if (!taskId) continue;
    // Codex child agents are asynchronous by protocol: spawnAgent returns
    // immediately and the parent only blocks if it calls the separate wait
    // tool, which nothing on the wire reports. An active child therefore
    // never proves the parent is waiting.
    //
    // agentPath is the marker, NOT timelineBypass: Claude stamps that on
    // workflow members too, purely to keep synthetic rows out of the parent
    // timeline, and a workflow coordinator genuinely does block its parent.
    if (payload.timelineBypass === true && asString(payload.agentPath) !== undefined) {
      detached.add(taskId);
      continue;
    }
    if (payload.isBackgrounded === true) detached.add(taskId);
    else if (payload.isBackgrounded === false) detached.delete(taskId);
  }
  return detached;
}

/** Minimal shape the wait derivation needs from a roster agent. */
export interface WaitStateAgent {
  readonly id: string;
  readonly title: string;
  readonly status: BackgroundTaskStatus;
  readonly startedAt: string | null;
  /**
   * The agent this one reports to — a workflow coordinator for its members.
   * Members block their coordinator, not the main agent; without this one
   * workflow inflated main's line to "Reviewer + 7 more agents".
   */
  readonly parentAgentId?: string | null | undefined;
}

function joinLabels(labels: ReadonlyArray<string>, noun: string): string {
  if (labels.length === 1) return labels[0] as string;
  if (labels.length === 2) return `${labels[0]} + 1 more ${noun}`;
  return `${labels[0]} + ${labels.length - 1} more ${noun}s`;
}

function earliest(values: ReadonlyArray<string | null>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || value.localeCompare(best) < 0) best = value;
  }
  return best;
}

/**
 * One "waiting on" line per blocked agent, main first.
 *
 * Precedence is by who can unblock it: a request only the user can answer
 * outranks work the machine is already doing, because the first is a stalled
 * thread and the second is progress. Agents with nothing blocking them are
 * omitted entirely — an empty section is the correct rendering of "nothing is
 * stuck".
 *
 * Open requests are thread-scoped in every adapter's protocol (no adapter
 * stamps an owning agent on `request.opened`), so they are attributed to the
 * main agent. A subagent that reports its own wait does so through its task
 * status, which is handled below.
 */
export function deriveAgentWaitStates(input: {
  readonly tasks: ReadonlyArray<RuntimeBackgroundTask>;
  readonly agents: ReadonlyArray<WaitStateAgent>;
  readonly requests: ReadonlyArray<OpenRequestWait>;
  /** From deriveAgentWaitReasons; empty for providers that do not name them. */
  readonly agentWaitReasons?: ReadonlyMap<string, AgentNamedWait> | undefined;
  /** From deriveDetachedTaskIds — detached and async work blocks nobody. */
  readonly detachedIds?: ReadonlySet<string> | undefined;
  /**
   * Whether the main agent's turn is actually in flight. When it is not, the
   * main agent is not waiting on anything: whatever is still running was
   * detached and outlived the turn, and it is reported under Tasks instead.
   */
  readonly mainTurnActive?: boolean | undefined;
}): ReadonlyArray<AgentWaitState> {
  const { tasks, agents, requests } = input;
  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  const agentWaitReasons = input.agentWaitReasons;
  const detachedIds = input.detachedIds;
  const mainTurnActive = input.mainTurnActive ?? true;
  const rows: AgentWaitState[] = [];

  const isDetached = (id: string, backgrounded: boolean): boolean =>
    backgrounded || detachedIds?.has(id) === true;

  // Requests are grouped by whoever raised them. Every open request is a real
  // wait only the user can clear, so each owner gets a line — showing only the
  // first hid simultaneous approvals entirely. An unattributed request (every
  // provider but Codex, whose child threads identify themselves) belongs to
  // the main agent, and stands whether or not a turn is running: someone must
  // still answer it.
  const requestsByOwner = new Map<string | null, OpenRequestWait[]>();
  for (const request of requests) {
    // An owner we cannot see in the roster (aged out of the cap, a resume
    // race, or a thread id that is not a collab child) would otherwise get a
    // bucket that never renders a line, hiding an approval only the user can
    // answer. Unresolvable ownership falls back to main.
    const ownerId =
      request.ownerId !== null && knownAgentIds.has(request.ownerId) ? request.ownerId : null;
    const bucket = requestsByOwner.get(ownerId);
    if (bucket) bucket.push(request);
    else requestsByOwner.set(ownerId, [request]);
  }

  const requestRow = (
    ownerId: string | null,
    ownerLabel: string,
    owned: ReadonlyArray<OpenRequestWait>,
  ): AgentWaitState => {
    const first = owned[0] as OpenRequestWait;
    return {
      ownerId,
      ownerLabel,
      kind: first.kind,
      label:
        owned.length === 1
          ? first.label
          : `${first.label} + ${owned.length - 1} more request${owned.length > 2 ? "s" : ""}`,
      since: earliest(owned.map((request) => request.since)),
      blockingIds: [],
      needsUser: true,
    };
  };

  const activeAgents = agents.filter((agent) => isActiveBackgroundTaskStatus(agent.status));

  // Only work that actually holds someone up counts. Detached work does not:
  // the provider returned the tool call immediately and the turn moved on, so
  // rendering it as a dependency was the panel asserting a relationship no
  // provider reports.
  const blockingAgents = activeAgents.filter((agent) => !isDetached(agent.id, false));
  // Only top-level agents block main. A workflow's members are reported on
  // their coordinator's own line below.
  const isMember = (agent: WaitStateAgent): boolean =>
    typeof agent.parentAgentId === "string" &&
    agent.parentAgentId.length > 0 &&
    knownAgentIds.has(agent.parentAgentId);
  const topLevelBlockingAgents = blockingAgents.filter((agent) => !isMember(agent));
  const blockingTasks = tasks.filter(
    (task) => isActiveBackgroundTaskStatus(task.status) && !isDetached(task.id, task.backgrounded),
  );

  const mainRequests = requestsByOwner.get(null);
  if (mainRequests && mainRequests.length > 0) {
    rows.push(requestRow(null, "Main", mainRequests));
  } else if (mainTurnActive) {
    const mainTasks = blockingTasks.filter((task) => task.ownerAgentId === null);
    if (topLevelBlockingAgents.length > 0) {
      rows.push({
        ownerId: null,
        ownerLabel: "Main",
        kind: "agents",
        label: joinLabels(
          topLevelBlockingAgents.map((agent) => agent.title),
          "agent",
        ),
        since: earliest(topLevelBlockingAgents.map((agent) => agent.startedAt)),
        blockingIds: topLevelBlockingAgents.map((agent) => agent.id),
        needsUser: false,
      });
    } else if (mainTasks.length > 0) {
      rows.push({
        ownerId: null,
        ownerLabel: "Main",
        kind: "tasks",
        label: joinLabels(
          mainTasks.map((task) => task.label),
          "task",
        ),
        since: earliest(mainTasks.map((task) => task.startedAt)),
        blockingIds: mainTasks.map((task) => task.id),
        needsUser: false,
      });
    }
  }

  // Group each agent's blocking tasks once instead of re-filtering the whole
  // task list per agent.
  const blockingTasksByOwner = new Map<string, RuntimeBackgroundTask[]>();
  for (const task of blockingTasks) {
    if (task.ownerAgentId === null) continue;
    const bucket = blockingTasksByOwner.get(task.ownerAgentId);
    if (bucket) bucket.push(task);
    else blockingTasksByOwner.set(task.ownerAgentId, [task]);
  }

  // Members that block their coordinator, grouped once.
  const blockingMembersByParent = new Map<string, WaitStateAgent[]>();
  for (const agent of blockingAgents) {
    if (!isMember(agent)) continue;
    const parentId = agent.parentAgentId as string;
    const bucket = blockingMembersByParent.get(parentId);
    if (bucket) bucket.push(agent);
    else blockingMembersByParent.set(parentId, [agent]);
  }

  const reported = new Set<string>();
  for (const agent of agents) {
    if (!isActiveBackgroundTaskStatus(agent.status)) continue;
    // A request this agent raised is the most concrete answer there is, and
    // replaces the generic named flag rather than duplicating it.
    const owned = requestsByOwner.get(agent.id);
    if (owned && owned.length > 0) {
      reported.add(agent.id);
      rows.push(requestRow(agent.id, agent.title, owned));
      continue;
    }
    // A named wait reason outranks any machine progress under this agent:
    // precedence is by who can unblock it, and only the user can clear this.
    // A coordinator blocked on an approval while its members keep running is
    // stuck, not busy, and must read that way.
    const named = agent.status === "waiting" ? agentWaitReasons?.get(agent.id) : undefined;
    if (named) {
      reported.add(agent.id);
      rows.push({
        ownerId: agent.id,
        ownerLabel: agent.title,
        kind: named.reason,
        label: named.reason === "approval" ? "Approval" : "Your answer",
        since: named.since,
        blockingIds: [],
        needsUser: true,
      });
      continue;
    }
    // Otherwise a coordinator waits on the members still running under it.
    const members = blockingMembersByParent.get(agent.id);
    if (members && members.length > 0) {
      reported.add(agent.id);
      rows.push({
        ownerId: agent.id,
        ownerLabel: agent.title,
        kind: "agents",
        label: joinLabels(
          members.map((member) => member.title),
          "agent",
        ),
        since: earliest(members.map((member) => member.startedAt)),
        blockingIds: members.map((member) => member.id),
        needsUser: false,
      });
      continue;
    }
    const ownTasks = blockingTasksByOwner.get(agent.id);
    if (ownTasks && ownTasks.length > 0) {
      reported.add(agent.id);
      rows.push({
        ownerId: agent.id,
        ownerLabel: agent.title,
        kind: "tasks",
        label: joinLabels(
          ownTasks.map((task) => task.label),
          "task",
        ),
        since: earliest(ownTasks.map((task) => task.startedAt)),
        blockingIds: ownTasks.map((task) => task.id),
        needsUser: false,
      });
    }
  }

  // A foreground task can outlive the subagent that launched it. Its owner
  // is not waiting on it — the owner is gone — so it gets no wait line; the
  // Tasks section still lists it under that owner's group.

  return rows;
}

/* -------------------------------------------------------------------------
 * Panel model
 * ---------------------------------------------------------------------- */

export interface BackgroundTaskGroup {
  /** null = main agent. */
  readonly ownerId: string | null;
  readonly ownerLabel: string;
  readonly tasks: ReadonlyArray<RuntimeBackgroundTask>;
  readonly activeCount: number;
}

/** A settled row plus the owner name the flat list would otherwise lose. */
export interface BackgroundTaskFinishedEntry {
  readonly task: RuntimeBackgroundTask;
  readonly ownerLabel: string;
}

export interface BackgroundTasksPanelModel {
  /** Live, failed and interrupted work, grouped by owner — always visible. */
  readonly groups: ReadonlyArray<BackgroundTaskGroup>;
  /** Deliberate endings, flat and newest-first — behind a disclosure. */
  readonly finished: ReadonlyArray<BackgroundTaskFinishedEntry>;
  readonly activeCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly hasTasks: boolean;
}

const EMPTY_PANEL_MODEL: BackgroundTasksPanelModel = {
  groups: [],
  finished: [],
  activeCount: 0,
  failedCount: 0,
  totalCount: 0,
  hasTasks: false,
};

export function emptyBackgroundTasksPanelModel(): BackgroundTasksPanelModel {
  return EMPTY_PANEL_MODEL;
}

/**
 * Splits the fold into what the panel renders where.
 *
 * Failures never age out: a failed background shell is the single most
 * likely reason a thread is quietly wrong, so it stays in the visible group
 * next to live work until the user reads it. Successes collapse behind a
 * disclosure — they are receipts, not signals.
 *
 * `agentTitles` names owners from the subagent roster; an owner missing from
 * the roster (its rows aged out) falls back to its id rather than vanishing.
 */
export function deriveBackgroundTasksPanelModel(input: {
  readonly tasks: ReadonlyArray<RuntimeBackgroundTask>;
  readonly agentTitles?: ReadonlyMap<string, string> | undefined;
}): BackgroundTasksPanelModel {
  const { tasks } = input;
  if (tasks.length === 0) return EMPTY_PANEL_MODEL;
  const agentTitles = input.agentTitles;

  const visible: RuntimeBackgroundTask[] = [];
  const finished: BackgroundTaskFinishedEntry[] = [];
  const nameOwner = (task: RuntimeBackgroundTask): string =>
    task.ownerAgentId === null
      ? "Main"
      : (agentTitles?.get(task.ownerAgentId) ?? task.ownerAgentId);

  for (const task of tasks) {
    // Failures and interruptions stay beside live work. A failure explains a
    // thread that is quietly wrong; an interruption means the work died with
    // its session and may need restarting. Only deliberate endings —
    // completed, and stopped by the user — collapse away.
    if (
      !isTerminalBackgroundTaskStatus(task.status) ||
      task.status === "failed" ||
      task.status === "interrupted"
    ) {
      visible.push(task);
    } else {
      // Finished rows are flat, so each carries its owner's name; without it
      // a completed shell lost all attribution the moment it settled.
      finished.push({ task, ownerLabel: nameOwner(task) });
    }
  }

  const byOwner = new Map<string | null, RuntimeBackgroundTask[]>();
  for (const task of visible) {
    const bucket = byOwner.get(task.ownerAgentId);
    if (bucket) bucket.push(task);
    else byOwner.set(task.ownerAgentId, [task]);
  }

  const groups: BackgroundTaskGroup[] = [];
  const pushGroup = (ownerId: string | null, rows: ReadonlyArray<RuntimeBackgroundTask>) => {
    // Within a group: live work first, then failures, then the rest —
    // ambient housekeeping always last, since it is noise by the provider's
    // own admission.
    const ordered = [...rows].sort((left, right) => {
      if (left.ambient !== right.ambient) return left.ambient ? 1 : -1;
      const leftRank = isActiveBackgroundTaskStatus(left.status) ? 0 : 1;
      const rightRank = isActiveBackgroundTaskStatus(right.status) ? 0 : 1;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return right.firstSeenAt.localeCompare(left.firstSeenAt);
    });
    groups.push({
      ownerId,
      ownerLabel: ownerId === null ? "Main" : (agentTitles?.get(ownerId) ?? ownerId),
      tasks: ordered,
      activeCount: ordered.filter((task) => isActiveBackgroundTaskStatus(task.status)).length,
    });
  };

  const mainRows = byOwner.get(null);
  if (mainRows) pushGroup(null, mainRows);
  const ownerIds = [...byOwner.keys()].filter((ownerId): ownerId is string => ownerId !== null);
  ownerIds.sort((left, right) => {
    const leftLabel = agentTitles?.get(left) ?? left;
    const rightLabel = agentTitles?.get(right) ?? right;
    return leftLabel.localeCompare(rightLabel) || left.localeCompare(right);
  });
  for (const ownerId of ownerIds) pushGroup(ownerId, byOwner.get(ownerId) ?? []);

  return {
    groups,
    finished,
    activeCount: tasks.filter((task) => isActiveBackgroundTaskStatus(task.status)).length,
    failedCount: tasks.filter((task) => task.status === "failed").length,
    totalCount: tasks.length,
    hasTasks: true,
  };
}

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

/**
 * Compact elapsed label: `42s`, `7m 03s`, `2h 14m`. Shared by the tasks list
 * and the waiting-on lines so a duration reads the same everywhere.
 */
export function formatElapsedDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Elapsed between two ISO instants; `endIso: null` means "until `now`".
 * `now` is passed in rather than read here: this package forbids ambient
 * clock access, and the callers are ticking components that already hold the
 * current time. Returns "" for unparseable input so a bad timestamp renders
 * as nothing rather than "NaNs".
 */
export function formatElapsedBetween(startIso: string, endIso: string | null, now: number): string {
  const start = Date.parse(startIso);
  const end = endIso === null ? now : Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatElapsedDuration((end - start) / 1000);
}
