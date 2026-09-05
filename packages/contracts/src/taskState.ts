import * as Schema from "effect/Schema";
import { RuntimeTaskUsage, TaskRunHandles, TaskWorkflowPhase } from "./providerRuntime.ts";

export const TaskStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** One current record per provider task, persisted independently of transcript pagination. */
export const TaskState = Schema.Struct({
  id: Schema.String,
  agentKind: Schema.Literals(["agent", "background"]),
  kind: Schema.Literals(["subagent", "workflow", "workflow_agent"]),
  taskType: Schema.NullOr(Schema.String),
  toolUseId: Schema.optional(Schema.String),
  agentPath: Schema.optional(Schema.String),
  title: Schema.String,
  role: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  status: TaskStatus,
  waitReason: Schema.NullOr(Schema.Literals(["approval", "user-input"])),
  waitingSince: Schema.NullOr(Schema.String),
  asynchronous: Schema.Boolean,
  activationCount: Schema.Number,
  usage: Schema.NullOr(RuntimeTaskUsage),
  progress: Schema.NullOr(Schema.String),
  lastToolName: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  outputFile: Schema.NullOr(Schema.String),
  parentAgentId: Schema.NullOr(Schema.String),
  agentIndex: Schema.NullOr(Schema.Number),
  phaseIndex: Schema.NullOr(Schema.Number),
  phaseTitle: Schema.NullOr(Schema.String),
  attempt: Schema.NullOr(Schema.Number),
  workflowName: Schema.NullOr(Schema.String),
  phases: Schema.Array(TaskWorkflowPhase),
  runHandles: Schema.NullOr(TaskRunHandles),
  recentActivity: Schema.Array(Schema.Struct({ at: Schema.String, summary: Schema.String })),
  command: Schema.NullOr(Schema.String),
  server: Schema.NullOr(Schema.String),
  tool: Schema.NullOr(Schema.String),
  canStop: Schema.Boolean,
  backgrounded: Schema.Boolean,
  ambient: Schema.Boolean,
  firstSeenAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type TaskState = typeof TaskState.Type;

export const isTaskState = Schema.is(TaskState);

export const isUnnamedTask = (title: string, id: string): boolean =>
  title === id || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(title);

/** Use the assignment's opening line when a provider only supplies an agent id. */
export function taskAssignmentTitle(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (/^gAAAAA[A-Za-z0-9_-]{74,}={0,2}$/.test(trimmed)) return null;
  const line = trimmed
    .split(/\r?\n/, 1)[0]
    ?.replace(/^\s*(?:#+\s+|[-*]\s+)/, "")
    .trim();
  if (!line) return null;
  if (line.length <= 80) return line;
  const prefix = line.slice(0, 79);
  const boundary = prefix.lastIndexOf(" ");
  return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}…`;
}

export function readTaskStates(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt?: string;
  }>,
): ReadonlyArray<TaskState> {
  const tasks = activities.flatMap((activity) =>
    activity.kind === "task.state" && isTaskState(activity.payload) ? [activity.payload] : [],
  );
  const unnamed = new Set(
    tasks
      .filter((task) => task.agentKind === "agent" && isUnnamedTask(task.title, task.id))
      .map((task) => task.id),
  );
  if (unnamed.size === 0) return tasks;

  // Older saved rosters can have UUID titles even though their assignments
  // are already retained. Recover those labels without new provider activity.
  const assignments = new Map<string, { title: string; createdAt: string }>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    if (
      !("taskId" in payload) ||
      typeof payload.taskId !== "string" ||
      !unnamed.has(payload.taskId)
    )
      continue;
    if (!("prompt" in payload) || typeof payload.prompt !== "string") continue;
    const createdAt = activity.createdAt ?? "";
    const previous = assignments.get(payload.taskId);
    if (previous && previous.createdAt <= createdAt) continue;
    const title = taskAssignmentTitle(payload.prompt);
    if (title) assignments.set(payload.taskId, { title, createdAt });
  }
  return tasks.map((task) => {
    const assignment = assignments.get(task.id);
    return assignment ? { ...task, title: assignment.title } : task;
  });
}
