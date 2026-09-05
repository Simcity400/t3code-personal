import {
  classifyTaskAgentKind,
  EventId,
  isUnnamedTask,
  readTaskStates,
  taskAssignmentTitle,
  RuntimeTaskUsage,
  TaskRunHandles,
  TaskWorkflowPhase,
  TaskStatus,
  type TaskState,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isPhases = Schema.is(Schema.Array(TaskWorkflowPhase));
const isRunHandles = Schema.is(TaskRunHandles);
const isStatus = Schema.is(TaskStatus);
const isUsage = Schema.is(RuntimeTaskUsage);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const bounded = (value: string): string => value.slice(0, 180);
export const isActiveTask = (status: TaskState["status"]): boolean =>
  status === "pending" || status === "running" || status === "waiting";
const terminal = (status: TaskState["status"]): boolean =>
  !isActiveTask(status) && status !== "idle";

/** Applied once, in event order, before the activity window is trimmed. */
export function updateTaskState(
  previous: TaskState | undefined,
  activity: OrchestrationThreadActivity,
): TaskState | undefined {
  if (
    !/^task\.(started|updated|progress|completed)$/.test(activity.kind) &&
    activity.kind !== "tool.progress"
  )
    return;
  if (typeof activity.payload !== "object" || activity.payload === null) return;
  const payload = activity.payload as Record<string, unknown>;
  const id = text(payload.taskId);
  if (!id || (activity.kind === "tool.progress" && !previous)) return;
  const at = activity.createdAt;
  const authoritativeBridgeUpdate =
    activity.kind === "task.updated" &&
    (payload.executionOwner ?? previous?.executionOwner) === "cross-provider" &&
    (text(payload.taskType) ?? previous?.taskType) === "cross_provider";
  if (authoritativeBridgeUpdate && previous && at < previous.updatedAt) return previous;
  const state: { -readonly [K in keyof TaskState]: TaskState[K] } = previous
    ? { ...previous }
    : {
        id,
        agentKind: "background",
        kind: "subagent",
        taskType: null,
        title: id,
        role: null,
        model: null,
        effort: null,
        status: "pending",
        activationCount: 0,
        waitReason: null,
        waitingSince: null,
        asynchronous: false,
        usage: null,
        progress: null,
        lastToolName: null,
        result: null,
        error: null,
        outputFile: null,
        parentAgentId: null,
        agentIndex: null,
        phaseIndex: null,
        phaseTitle: null,
        attempt: null,
        workflowName: null,
        phases: [],
        runHandles: null,
        recentActivity: [],
        command: null,
        server: null,
        tool: null,
        canStop: false,
        backgrounded: false,
        ambient: false,
        firstSeenAt: at,
        startedAt: null,
        completedAt: null,
        updatedAt: at,
      };

  const taskType = text(payload.taskType);
  // Thin progress/completion frames inherit identity. They cannot turn a shell into an agent.
  if (taskType !== null || !previous) {
    state.agentKind =
      !taskType && (payload.agentKind === "background" || payload.agentKind === undefined)
        ? "background"
        : classifyTaskAgentKind({
            ...(taskType ? { taskType } : {}),
            ...(text(payload.agentId) ? { agentId: text(payload.agentId)! } : {}),
          });
  }
  if (
    !taskType &&
    state.taskType === null &&
    payload.agentKind === "agent" &&
    (text(payload.role) || text(payload.parentAgentId) || text(payload.agentPath))
  )
    state.agentKind = "agent";
  if (taskType) state.taskType = taskType;
  if (payload.executionOwner === "cross-provider") state.executionOwner = payload.executionOwner;
  for (const key of [
    "toolUseId",
    "agentPath",
    "role",
    "model",
    "effort",
    "phaseTitle",
    "workflowName",
    "outputFile",
    "command",
    "server",
    "tool",
  ] as const) {
    const value = text(payload[key]);
    if (value) state[key] = value;
  }
  const parent = text(payload.parentAgentId) ?? text(payload.agentId);
  if (parent && parent !== id) state.parentAgentId = parent;
  const title =
    text(payload.title) ??
    (isUnnamedTask(state.title, id) ? (text(payload.detail) ?? text(payload.description)) : null);
  if (title && (!isUnnamedTask(title, id) || isUnnamedTask(state.title, id))) state.title = title;
  const prompt = text(payload.prompt);
  if (state.agentKind === "agent" && isUnnamedTask(state.title, id) && prompt) {
    state.title = taskAssignmentTitle(prompt) ?? state.title;
  }
  for (const key of ["agentIndex", "phaseIndex", "attempt"] as const) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) state[key] = value;
  }
  if (state.taskType === "local_workflow") state.kind = "workflow";
  else if (state.workflowName || state.agentIndex !== null || state.phaseIndex !== null)
    state.kind = "workflow_agent";
  if (isPhases(payload.phases)) state.phases = payload.phases;
  if (isRunHandles(payload.runHandles)) {
    const { sessionUrl, ...handles } = payload.runHandles;
    state.runHandles = {
      ...state.runHandles,
      ...handles,
      ...(sessionUrl && /^https?:\/\//i.test(sessionUrl) ? { sessionUrl } : {}),
    };
  }
  if (payload.timelineBypass === true && text(payload.agentPath)) state.asynchronous = true;
  if (typeof payload.canStop === "boolean") state.canStop = payload.canStop;
  if (typeof payload.canResume === "boolean") state.canResume = payload.canResume;
  if (typeof payload.isBackgrounded === "boolean") state.backgrounded = payload.isBackgrounded;
  if (typeof payload.skipTranscript === "boolean") state.ambient = payload.skipTranscript;

  const explicit = isStatus(payload.status) ? payload.status : undefined;
  const nextStatus =
    activity.kind === "task.completed"
      ? payload.status === "stopped"
        ? "interrupted"
        : (explicit ?? "completed")
      : (explicit ??
        (activity.kind === "task.started" || (!previous && activity.kind === "task.progress")
          ? "running"
          : undefined));
  if (nextStatus !== undefined) {
    const lateStart = activity.kind === "task.started" && terminal(state.status);
    // Wrapper updates are bridge-owned current state, including a confirmed
    // stop that supersedes an initialization failure in the same activation.
    const correctedEnd =
      authoritativeBridgeUpdate &&
      terminal(state.status) &&
      terminal(nextStatus) &&
      state.status !== nextStatus;
    const duplicateEnd =
      !correctedEnd && terminal(state.status) && (terminal(nextStatus) || nextStatus === "idle");
    if (!lateStart && !duplicateEnd) {
      if (correctedEnd) {
        state.completedAt = text(payload.endedAt) ?? at;
        state.error = null;
        state.result = null;
      }
      if ((terminal(state.status) || state.status === "idle") && isActiveTask(nextStatus)) {
        state.activationCount += 1;
        state.startedAt = at;
        state.completedAt = null;
        state.result = null;
        state.error = null;
      }
      if (state.activationCount === 0) state.activationCount = 1;
      if (isActiveTask(nextStatus) && state.startedAt === null) state.startedAt = at;
      if (terminal(nextStatus) && state.completedAt === null)
        state.completedAt = text(payload.endedAt) ?? at;
      state.status = nextStatus;
    }
  }
  if (state.status !== "waiting") {
    state.waitReason = null;
    state.waitingSince = null;
  } else if (payload.status === "waiting") {
    const reason =
      payload.waitReason === "approval" || payload.waitReason === "user-input"
        ? payload.waitReason
        : null;
    if (reason !== state.waitReason) state.waitingSince = reason ? at : null;
    state.waitReason = reason;
  }
  const summary = text(payload.summary) ?? text(payload.detail);
  if (activity.kind === "task.completed" && summary) {
    if (state.status === "failed") state.error ??= bounded(summary);
    else state.result ??= bounded(summary);
  } else if (activity.kind === "task.progress" && summary) state.progress = bounded(summary);
  const error = text(payload.error);
  if (error) state.error = bounded(error);
  const toolName = text(payload.lastToolName) ?? text(payload.toolName);
  if (toolName) state.lastToolName = toolName;
  const recent =
    activity.kind === "task.progress"
      ? summary
      : activity.kind === "tool.progress"
        ? toolName
        : null;
  if (recent && state.recentActivity.at(-1)?.summary !== bounded(recent)) {
    state.recentActivity = [...state.recentActivity, { at, summary: bounded(recent) }].slice(-6);
  }
  if (isUsage(payload.typedUsage)) {
    const usage = { ...state.usage, ...payload.typedUsage };
    for (const key of [
      "totalTokens",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "toolUses",
      "durationMs",
    ] as const) {
      const value = payload.typedUsage[key];
      const old = state.usage?.[key];
      if (value !== undefined && old !== undefined) usage[key] = Math.max(old, value);
    }
    state.usage = usage;
  }
  state.updatedAt = at;
  return state;
}

export const taskStateActivityId = (threadId: ThreadId, taskId: string): EventId =>
  EventId.make(`task-state:${JSON.stringify([threadId, taskId])}`);

export function taskStateActivity(
  threadId: ThreadId,
  state: TaskState,
): OrchestrationThreadActivity {
  return {
    id: taskStateActivityId(threadId, state.id),
    kind: "task.state",
    tone: "info",
    summary: state.title,
    turnId: null,
    createdAt: state.updatedAt,
    payload: state,
  };
}

export function projectTaskActivity(
  threadId: ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationThreadActivity> {
  if (!activity.kind.startsWith("task.") && activity.kind !== "tool.progress") return [];
  const states = readTaskStates(activities);
  const payload = activity.payload as { taskId?: unknown } | null;
  let state = updateTaskState(
    states.find((entry) => entry.id === payload?.taskId),
    activity,
  );
  if (!state) return [];
  const coordinator = states.find(
    (entry) => entry.id === state?.parentAgentId && entry.kind === "workflow",
  );
  if (
    state.kind === "workflow_agent" &&
    isActiveTask(state.status) &&
    coordinator &&
    terminal(coordinator.status)
  ) {
    state = {
      ...state,
      status: coordinator.status === "completed" ? "completed" : "interrupted",
      waitReason: null,
      waitingSince: null,
      completedAt: coordinator.completedAt ?? coordinator.updatedAt,
    };
  }
  const updates = [taskStateActivity(threadId, state)];
  if (state.kind === "workflow" && terminal(state.status)) {
    for (const member of states) {
      if (member.parentAgentId !== state.id || !isActiveTask(member.status)) continue;
      updates.push(
        taskStateActivity(threadId, {
          ...member,
          status: state.status === "completed" ? "completed" : "interrupted",
          waitReason: null,
          waitingSince: null,
          completedAt: member.completedAt ?? state.completedAt,
          updatedAt: state.updatedAt,
        }),
      );
    }
  }
  return updates;
}
