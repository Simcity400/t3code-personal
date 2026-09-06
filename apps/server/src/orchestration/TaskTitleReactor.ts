/**
 * Names provider tasks that arrive without a name.
 *
 * Claude's Task tool hands every subagent and background shell a human-written
 * description, so those rows already carry a title and are left alone. Codex
 * child agents arrive with a nickname and their assignment, and a nickname says
 * nothing about the work. This reactor watches task rows that carry the
 * provider's words for the work (the assignment, else the start row's
 * description, else a command line) but no title, asks the thread-title
 * generator (the same model and settings that name threads) for a short
 * purpose-shaped name, and writes it back as a `task.updated` row. The decider
 * folds that into `task.state`, so the roster, transcript header and phone all
 * read one name without any client learning provider vocabulary. The same name
 * is fed to the in-memory liveness registry, which is what the thread view's
 * "Waiting on …" line reads while the agent's own turn is over.
 *
 * Naming runs one task at a time: a fleet of eight children means eight CLI
 * calls, and serializing them keeps a burst from tripping the very usage limit
 * that would leave the whole fleet unnamed.
 */
import {
  CommandId,
  EventId,
  isUnnamedTask,
  taskAssignmentTitle,
  type OrchestrationThreadActivity,
  type TaskState,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";
import { DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

export class TaskTitleReactor extends Context.Service<
  TaskTitleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/TaskTitleReactor") {}

export interface TaskTitleRequest {
  readonly threadId: ThreadId;
  readonly taskId: string;
  /** The provider's own words for the work, in preference order: assignment, description, command. */
  readonly source: string;
  /**
   * Identity copied from the row that asked for a name, so the rename row
   * classifies exactly like it (an agent's row stays an agent's row; a
   * bypassed Codex row stays out of the parent timeline).
   */
  readonly linkage: {
    readonly agentKind?: unknown;
    readonly taskType?: unknown;
    readonly agentId?: unknown;
    readonly agentPath?: unknown;
    readonly timelineBypass?: unknown;
  };
}

const LINKAGE_KEYS = ["agentKind", "taskType", "agentId", "agentPath", "timelineBypass"] as const;
const TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
]);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Which appended rows ask for a name: a task lifecycle row whose title is
 * missing or is just the task id, and which carries something to name it by.
 * Rows with a real provider title never qualify, which is what keeps Claude's
 * descriptions untouched. `detail` counts only on the start row, where it is
 * the provider's description; on later rows it is the transient status line,
 * and "Reading src/components…" must not become a permanent name.
 */
export function resolveTaskTitleRequest(
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): TaskTitleRequest | null {
  if (!TRIGGER_KINDS.has(activity.kind)) return null;
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const payload = activity.payload as Record<string, unknown>;
  const taskId = text(payload.taskId);
  if (!taskId) return null;
  const title = text(payload.title);
  if (title && !isUnnamedTask(title, taskId)) return null;
  const source =
    text(payload.prompt) ??
    (activity.kind === "task.started" ? text(payload.detail) : undefined) ??
    text(payload.command);
  // taskAssignmentTitle refuses an encrypted assignment; so does naming.
  if (!source || taskAssignmentTitle(source) === null) return null;
  const linkage: Record<string, unknown> = {};
  for (const key of LINKAGE_KEYS) {
    if (payload[key] !== undefined) linkage[key] = payload[key];
  }
  return { threadId, taskId, source, linkage };
}

/**
 * A task already carries a real name when its current title is neither its
 * id nor the placeholder the fold derives from the same source text. That
 * covers a provider that named it on a later row and a name this reactor
 * already wrote, without any in-memory bookkeeping to lose on restart.
 */
export function isTaskAlreadyNamed(
  state: TaskState | undefined,
  request: Pick<TaskTitleRequest, "taskId" | "source">,
): boolean {
  if (state === undefined) return false;
  if (isUnnamedTask(state.title, request.taskId)) return false;
  return state.title !== request.source && state.title !== taskAssignmentTitle(request.source);
}

export const taskTitleActivityId = (threadId: ThreadId, taskId: string): EventId =>
  EventId.make(`task-title:${JSON.stringify([threadId, taskId])}`);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const liveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;

  const currentTaskState = (request: TaskTitleRequest) =>
    snapshots
      .getTaskState({ threadId: request.threadId, taskId: request.taskId })
      .pipe(Effect.map(Option.getOrUndefined));

  const name = Effect.fn("TaskTitleReactor.name")(function* (request: TaskTitleRequest) {
    if (isTaskAlreadyNamed(yield* currentTaskState(request), request)) return;
    const thread = yield* snapshots
      .getThreadShellById(request.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) return;
    const project = yield* snapshots
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    const cwd =
      resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = yield* settingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message: request.source,
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE) return;
    // The provider may have named the task while the model was thinking.
    if (isTaskAlreadyNamed(yield* currentTaskState(request), request)) return;
    const now = DateTime.formatIso(yield* DateTime.now);
    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:task-title:${uuid}`),
      threadId: request.threadId,
      createdAt: now,
      activity: {
        id: taskTitleActivityId(request.threadId, request.taskId),
        kind: "task.updated",
        tone: "info",
        summary: "Task named",
        turnId: null,
        createdAt: now,
        payload: { taskId: request.taskId, title: generated.title, ...request.linkage },
      },
    });
    // The liveness registry only hears runtime events, so it learns the name
    // here. Same classification inputs as ingestion passes, and a status-free
    // update: a task that is no longer live stays out of the set.
    liveness.recordTaskLiveness({
      threadId: request.threadId,
      taskId: request.taskId,
      taskType: text(request.linkage.taskType),
      status: undefined,
      kind: "updated",
      agentId: text(request.linkage.agentId),
      label: generated.title,
    });
  });

  const worker = yield* makeDrainableWorker((request: TaskTitleRequest) =>
    name(request).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("task title generation skipped", {
              threadId: request.threadId,
              taskId: request.taskId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: TaskTitleReactor["Service"]["start"] = Effect.fn("TaskTitleReactor.start")(
    function* () {
      const domainEvents = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(domainEvents, (event) => {
          if (event.type !== "thread.activity-appended") return Effect.void;
          const request = resolveTaskTitleRequest(event.payload.threadId, event.payload.activity);
          return request ? worker.enqueue(request) : Effect.void;
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies TaskTitleReactor["Service"];
});

export const layer = Layer.effect(TaskTitleReactor, make);
