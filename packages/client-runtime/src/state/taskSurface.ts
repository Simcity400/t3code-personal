/**
 * Which surface owns a task id — the Agents roster, or the Tasks panel.
 *
 * The two folds that render those surfaces (`foldSubagentActivities` and
 * `foldBackgroundTasks`) used to decide this separately, and disagreed in one
 * real case: a resumed session loses a task's server-side identity, so a
 * terminal row arrives carrying only `taskId` + `status`. Ingestion's
 * `classifyTaskAgentKind` defaults a type-less row to "agent", and the
 * roster fold — which judged each row on its own stamp — built a phantom
 * agent out of it, while the tasks fold, judging the task id as a whole, kept
 * the real background shell. One task, two surfaces.
 *
 * The fix is not to pick a winner but to ask once. This module makes the
 * decision per TASK ID, from the evidence carried by every row that mentions
 * it, and both folds read the answer. A task id can therefore never appear on
 * both surfaces, whatever order its rows arrive in.
 *
 * The rule, in precedence order:
 *
 * 1. **Agent evidence** — a row stamped `agent` that also carries something
 *    agent-shaped (a taskType, a role, workflow membership, a synthesized
 *    child's timeline bypass). The stamp alone is not enough, because the
 *    evidence-free rows above carry it by default.
 * 2. **Background evidence** — a row NOT stamped `agent` that positively
 *    describes work (a taskType, a description, a title, a summary). Trusting
 *    the stamp alone in this direction is just as wrong: letting an
 *    evidence-free `agent` stamp override a known background shell would make
 *    the shell vanish from the Tasks panel the moment it finished.
 * 3. **A bare `agent` stamp**, with no evidence either way — the roster keeps
 *    it, which is what it did before this module existed.
 * 4. **Nothing at all** — legacy rows from before the stamp. Neither surface
 *    claims them; they render in the ordinary work log exactly as they always
 *    have.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/** The surface that owns a task id. `unclassified` means neither claims it. */
export type TaskSurface = "agent" | "background" | "unclassified";

/**
 * Fields that make a row agent-shaped. `taskType` counts because a stamped
 * agent row naming its own type is the provider saying what it is.
 */
const AGENT_EVIDENCE_KEYS = [
  "taskType",
  "role",
  "workflowName",
  "parentAgentId",
  "agentIndex",
  "phaseIndex",
] as const;

/**
 * Fields that make a row describe real work. A background row carrying any of
 * them is a task worth showing, whatever else is missing.
 */
const DESCRIPTIVE_KEYS = [
  "taskType",
  "detail",
  "description",
  "title",
  "summary",
  // Reader-facing detail recovered from the launching call: a shell command
  // line, or a monitor's MCP server/tool. A snapshot-repaired row can carry
  // these and nothing else.
  "command",
  "server",
  "tool",
] as const;

/**
 * True when this activity's payload does NOT belong on the Agents surface.
 *
 * Classification happens exactly once, server-side at ingestion
 * (`classifyTaskAgentKind` → the persisted `agentKind` stamp); the client only
 * reads it. Rows without a stamp — legacy threads, pre-stamp servers — are
 * background by definition.
 *
 * This is the single-row read. Prefer {@link deriveTaskSurfaces} for anything
 * that decides which surface renders a task: a single row cannot see the
 * evidence carried by the task's other rows.
 */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

function asTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface SurfaceEvidence {
  agentEvidence: boolean;
  backgroundEvidence: boolean;
  agentStamp: boolean;
}

/**
 * One pass over a thread's activities, yielding the owning surface for every
 * task id mentioned. Pure, so callers memoize on activity-list identity.
 */
export function deriveTaskSurfaces(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, TaskSurface> {
  const evidence = new Map<string, SurfaceEvidence>();

  for (const activity of activities) {
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as Record<string, unknown>;
    const taskId = asTaskId(payload.taskId);
    if (!taskId) continue;
    let entry = evidence.get(taskId);
    if (!entry) {
      entry = { agentEvidence: false, backgroundEvidence: false, agentStamp: false };
      evidence.set(taskId, entry);
    }
    if (isBackgroundTaskActivity(payload)) {
      if (DESCRIPTIVE_KEYS.some((key) => payload[key] !== undefined)) {
        entry.backgroundEvidence = true;
      }
      continue;
    }
    entry.agentStamp = true;
    if (
      payload.timelineBypass === true ||
      AGENT_EVIDENCE_KEYS.some((k) => payload[k] !== undefined)
    ) {
      entry.agentEvidence = true;
    }
  }

  const surfaces = new Map<string, TaskSurface>();
  for (const [taskId, entry] of evidence) {
    surfaces.set(
      taskId,
      entry.agentEvidence
        ? "agent"
        : entry.backgroundEvidence
          ? "background"
          : entry.agentStamp
            ? "agent"
            : "unclassified",
    );
  }
  return surfaces;
}
