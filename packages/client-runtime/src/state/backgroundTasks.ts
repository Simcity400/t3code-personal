/** Background-task presentation and wait relationships from server-owned task state. */
import {
  readTaskStates,
  MONITOR_TASK_TYPES,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type { RuntimeSubagentStatus } from "./subagentRuntime.ts";

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
  /**
   * Shell command line, when the provider exposed the launching call. Shell
   * rows lead with it: a provider description humanizes ("Running tests"),
   * and with five test shells in flight only the command tells them apart.
   */
  readonly command: string | null;
  /** MCP server / tool behind a monitor or backgrounded MCP task. */
  readonly server: string | null;
  readonly tool: string | null;
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function foldBackgroundTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly sessionLive?: boolean },
): ReadonlyArray<RuntimeBackgroundTask> {
  return readTaskStates(activities)
    .filter((task) => task.agentKind === "background")
    .map((task) => ({
      id: task.id,
      kind: backgroundTaskKind(task.taskType),
      taskType: task.taskType,
      label: task.command ?? task.title,
      command: task.command,
      server: task.server,
      tool: task.tool,
      ownerAgentId: task.parentAgentId,
      status:
        options?.sessionLive === false && isActiveBackgroundTaskStatus(task.status)
          ? "interrupted"
          : task.status,
      startedAt: task.startedAt,
      endedAt:
        task.completedAt ??
        (options?.sessionLive === false && isActiveBackgroundTaskStatus(task.status)
          ? task.updatedAt
          : null),
      progress: task.progress,
      result: task.result,
      error: task.error,
      backgrounded: task.backgrounded,
      ambient: task.ambient,
      firstSeenAt: task.firstSeenAt,
      updatedAt: task.updatedAt,
    }))
    .sort((left, right) => right.firstSeenAt.localeCompare(left.firstSeenAt));
}

/* -------------------------------------------------------------------------
 * Wait states
 * ---------------------------------------------------------------------- */

/** What an agent is blocked on, most user-actionable first. */
export type AgentWaitKind = "approval" | "user-input" | "compacting" | "agents" | "tasks";

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

/** The provider's current named wait, retained independently of work-log history. */
export function deriveAgentWaitReasons(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, AgentNamedWait> {
  return new Map(
    readTaskStates(activities).flatMap((task) =>
      task.status === "waiting" && task.waitReason && task.waitingSince
        ? [[task.id, { reason: task.waitReason, since: task.waitingSince }] as const]
        : [],
    ),
  );
}

/**
 * When the provider started compacting its own context, or null when it is
 * not compacting.
 *
 * Compaction is the one long pause a thread hits that nothing else on this
 * surface can explain: no task is running, no request is open, the turn is
 * simply stopped while the provider rewrites its history. It is a MACHINE
 * wait — no user action shortens it — so the strip names it without tinting.
 *
 * Read from the single `session.compacting` row ingestion rewrites on each
 * compaction edge; `since` is that row's timestamp, which is when compaction
 * began (the row is only rewritten when the state actually flips). Only
 * Claude reports it today; every other provider's threads simply have no such
 * row and get no line.
 */
export function deriveCompactingSince(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  let since: string | null = null;
  for (const activity of activities) {
    if (activity.kind !== "session.compacting") continue;
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    if (typeof payload.agentId === "string") continue;
    // Latest edge wins. Rows are scanned in order rather than filtered-and-
    // sorted because the caller already hands them over ordered, and a
    // rewritten row keeps one position.
    since = payload.compacting === true ? activity.createdAt : null;
  }
  return since;
}

/** Detached tasks and asynchronous child agents are not implied parent dependencies. */
export function deriveDetachedTaskIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  return new Set(
    readTaskStates(activities)
      .filter((task) => task.backgrounded || task.asynchronous)
      .map((task) => task.id),
  );
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
   * From deriveCompactingSince. A compacting provider blocks the main agent
   * outright, whatever else is or is not running under it.
   */
  readonly compactingSince?: string | null | undefined;
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
  const compactingSince = input.compactingSince ?? null;
  if (mainRequests && mainRequests.length > 0) {
    rows.push(requestRow(null, "Main", mainRequests));
  } else if (compactingSince !== null) {
    // Compaction outranks every machine wait below it and does NOT depend on
    // mainTurnActive: the provider compacts between turns as readily as
    // during one, and it is precisely then — turn over, nothing running, the
    // thread apparently frozen — that a reader needs to be told why. It sits
    // below an open request because only a request needs the user.
    rows.push({
      ownerId: null,
      ownerLabel: "Main",
      kind: "compacting",
      label: "Compacting context",
      since: compactingSince,
      blockingIds: [],
      needsUser: false,
    });
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
 * Where a monitor's work actually happens: `server · tool`.
 *
 * Returns null for rows that have neither, and the one it has when only one
 * arrived — a partially-recovered row should still say what it can. Shared by
 * both panels so the separator and the fallback do not drift between them.
 */
export function backgroundTaskSourceLabel(task: RuntimeBackgroundTask): string | null {
  if (task.server !== null && task.tool !== null) return `${task.server} · ${task.tool}`;
  return task.server ?? task.tool;
}

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
