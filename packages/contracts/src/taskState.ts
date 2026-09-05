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
  executionOwner: Schema.optional(Schema.Literal("cross-provider")),
  canResume: Schema.optional(Schema.Boolean),
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

export function readTaskStates(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyArray<TaskState> {
  return activities.flatMap((activity) =>
    activity.kind === "task.state" && isTaskState(activity.payload) ? [activity.payload] : [],
  );
}
