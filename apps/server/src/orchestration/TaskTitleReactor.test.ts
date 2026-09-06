import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type TaskState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as TaskTitleReactor from "./TaskTitleReactor.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

const NOW = "2026-09-06T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("task-title-project");
const THREAD_ID = ThreadId.make("task-title-thread");
const ASSIGNMENT = "Review the diff for correctness bugs.\nReport only findings, no fixes.";

type AppendCommand = Extract<OrchestrationCommand, { readonly type: "thread.activity.append" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeTaskState(overrides: Partial<TaskState> & Pick<TaskState, "id">): TaskState {
  return {
    agentKind: "agent",
    kind: "subagent",
    taskType: null,
    title: overrides.id,
    role: null,
    model: null,
    effort: null,
    status: "running",
    waitReason: null,
    waitingSince: null,
    asynchronous: true,
    activationCount: 1,
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
    canStop: true,
    backgrounded: false,
    ambient: false,
    firstSeenAt: NOW,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeActivity(
  kind: string,
  payload: Record<string, unknown>,
  id = `${kind}:${String(payload.taskId)}`,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "info",
    summary: kind,
    turnId: null,
    createdAt: NOW,
    payload,
  };
}

function appended(activity: OrchestrationThreadActivity): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make(`evt:${activity.id}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: { threadId: THREAD_ID, activity },
  };
}

const codexChildRow = (taskId: string, prompt: string, kind = "task.started") =>
  makeActivity(kind, {
    taskId,
    prompt,
    agentKind: "agent",
    role: "marlow",
    agentPath: "/root/marlow",
    timelineBypass: true,
  });

interface HarnessOptions {
  readonly taskStates: ReadonlyArray<TaskState>;
  readonly generatedTitle?: string;
}

const makeHarness = Effect.fn("makeTaskTitleHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const taskStates = yield* Ref.make(
    new Map(options.taskStates.map((state) => [state.id, state] as const)),
  );
  const taskReads = yield* Queue.unbounded<string>();
  const commands = yield* Ref.make<ReadonlyArray<AppendCommand>>([]);
  const generations = yield* Ref.make<ReadonlyArray<string>>([]);
  // The real registry: every task under test is live, with no name yet.
  const liveness = ThreadBackgroundLiveness.make();
  for (const state of options.taskStates) {
    liveness.recordTaskLiveness({
      threadId: THREAD_ID,
      taskId: state.id,
      taskType: undefined,
      status: undefined,
      kind: "started",
      at: NOW,
    });
  }

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "thread.activity.append") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      // Mirror the decider: the rename row folds into the task's current title.
      Effect.andThen(
        Ref.update(taskStates, (states) => {
          const payload = command.activity.payload as { taskId: string; title: string };
          const previous = states.get(payload.taskId);
          if (!previous) return states;
          const next = new Map(states);
          next.set(payload.taskId, { ...previous, title: payload.title });
          return next;
        }),
      ),
      Effect.as({ sequence: 1 }),
    );
  };

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getTaskState: ({ taskId }) =>
        Ref.get(taskStates).pipe(
          Effect.tap(() => Queue.offer(taskReads, taskId)),
          Effect.map((states) => Option.fromUndefinedOr(states.get(taskId))),
        ),
      getThreadShellById: () => Effect.succeed(Option.some(makeThread())),
      getProjectShellById: () => Effect.succeed(Option.some(makeProject())),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(TextGeneration)({
      generateThreadTitle: (input) =>
        Ref.update(generations, (recorded) => [...recorded, input.message]).pipe(
          Effect.as({ title: options.generatedTitle ?? "Review diff for correctness" }),
        ),
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.succeed(ThreadBackgroundLiveness.ThreadBackgroundLivenessService, liveness),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    events,
    taskReads,
    commands,
    generations,
    liveness,
    layer: TaskTitleReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

/** Publish rows, wait until the worker has read task state `reads` times, then drain. */
const runRows = Effect.fn("runTaskTitleRows")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  rows: ReadonlyArray<OrchestrationThreadActivity>,
  reads: number,
) {
  const reactor = yield* TaskTitleReactor.TaskTitleReactor;
  yield* reactor.start();
  yield* Deferred.succeed(harness.activation, undefined);
  for (const row of rows) {
    yield* PubSub.publish(harness.events, appended(row));
  }
  for (let index = 0; index < reads; index += 1) {
    yield* Queue.take(harness.taskReads);
  }
  yield* reactor.drain;
});

describe("resolveTaskTitleRequest", () => {
  it("asks to name an agent that arrived with an assignment but no title", () => {
    const request = TaskTitleReactor.resolveTaskTitleRequest(
      THREAD_ID,
      codexChildRow("child-1", ASSIGNMENT),
    );
    assert.deepStrictEqual(request, {
      threadId: THREAD_ID,
      taskId: "child-1",
      source: ASSIGNMENT,
      linkage: { agentKind: "agent", agentPath: "/root/marlow", timelineBypass: true },
    });
  });

  it("leaves a provider-titled task alone", () => {
    assert.isNull(
      TaskTitleReactor.resolveTaskTitleRequest(
        THREAD_ID,
        makeActivity("task.started", {
          taskId: "claude-1",
          title: "Explore auth flow",
          prompt: "Explore how authentication works in this repo.",
          agentKind: "agent",
        }),
      ),
    );
  });

  it("names a background shell from its command when nothing else describes it", () => {
    const request = TaskTitleReactor.resolveTaskTitleRequest(
      THREAD_ID,
      makeActivity("task.started", {
        taskId: "shell-1",
        command: "pnpm test --watch",
        agentKind: "background",
        taskType: "local_bash",
      }),
    );
    assert.strictEqual(request?.source, "pnpm test --watch");
    assert.deepStrictEqual(request?.linkage, { agentKind: "background", taskType: "local_bash" });
  });

  it("never names an agent after its transient progress line", () => {
    // Later rows carry the status line as detail; only the start row's
    // detail is the provider's description of the work.
    assert.isNull(
      TaskTitleReactor.resolveTaskTitleRequest(
        THREAD_ID,
        makeActivity("task.progress", {
          taskId: "child-1",
          title: "child-1",
          detail: "Reading src/components/Sidebar.tsx",
          agentKind: "agent",
        }),
      ),
    );
    assert.strictEqual(
      TaskTitleReactor.resolveTaskTitleRequest(
        THREAD_ID,
        makeActivity("task.started", {
          taskId: "shell-2",
          detail: "Tail the deploy logs",
          agentKind: "background",
          taskType: "monitor",
        }),
      )?.source,
      "Tail the deploy logs",
    );
  });

  it("ignores terminal rows, id-only rows and encrypted assignments", () => {
    assert.isNull(
      TaskTitleReactor.resolveTaskTitleRequest(
        THREAD_ID,
        makeActivity("task.completed", { taskId: "child-1", prompt: ASSIGNMENT }),
      ),
    );
    assert.isNull(
      TaskTitleReactor.resolveTaskTitleRequest(
        THREAD_ID,
        makeActivity("task.started", { taskId: "child-1", agentKind: "agent" }),
      ),
    );
    assert.isNull(
      TaskTitleReactor.resolveTaskTitleRequest(
        THREAD_ID,
        codexChildRow("child-1", `gAAAAA${"x".repeat(90)}`),
      ),
    );
  });
});

describe("isTaskAlreadyNamed", () => {
  const request = { taskId: "child-1", source: ASSIGNMENT };

  it("treats the id and the assignment's opening line as placeholders", () => {
    assert.isFalse(TaskTitleReactor.isTaskAlreadyNamed(undefined, request));
    assert.isFalse(TaskTitleReactor.isTaskAlreadyNamed(makeTaskState({ id: "child-1" }), request));
    assert.isFalse(
      TaskTitleReactor.isTaskAlreadyNamed(
        makeTaskState({ id: "child-1", title: "Review the diff for correctness bugs." }),
        request,
      ),
    );
  });

  it("recognises a real name, whoever wrote it", () => {
    assert.isTrue(
      TaskTitleReactor.isTaskAlreadyNamed(
        makeTaskState({ id: "child-1", title: "Review diff for correctness" }),
        request,
      ),
    );
  });
});

describe("TaskTitleReactor", () => {
  it.effect("names a Codex child from its assignment and stamps the row with its identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({
          taskStates: [
            makeTaskState({ id: "child-1", title: "Review the diff for correctness bugs." }),
          ],
        });
        yield* runRows(harness, [codexChildRow("child-1", ASSIGNMENT)], 2).pipe(
          Effect.provide(harness.layer),
        );

        assert.deepStrictEqual(yield* Ref.get(harness.generations), [ASSIGNMENT]);
        const commands = yield* Ref.get(harness.commands);
        assert.strictEqual(commands.length, 1);
        const activity = commands[0]!.activity;
        assert.strictEqual(activity.kind, "task.updated");
        assert.strictEqual(activity.id, TaskTitleReactor.taskTitleActivityId(THREAD_ID, "child-1"));
        assert.deepStrictEqual(activity.payload, {
          taskId: "child-1",
          title: "Review diff for correctness",
          agentKind: "agent",
          agentPath: "/root/marlow",
          timelineBypass: true,
        });
        // The "Waiting on …" line reads the liveness registry, not task.state.
        assert.deepStrictEqual(harness.liveness.getThreadBackgroundWait(THREAD_ID), {
          count: 1,
          label: "Review diff for correctness",
          since: NOW,
          monitorOnly: false,
        });
      }),
    ),
  );

  it.effect("does not rename a task the provider already named", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({
          taskStates: [makeTaskState({ id: "child-1", title: "Reviewer" })],
        });
        yield* runRows(harness, [codexChildRow("child-1", ASSIGNMENT)], 1).pipe(
          Effect.provide(harness.layer),
        );

        assert.deepStrictEqual(yield* Ref.get(harness.generations), []);
        assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
        assert.strictEqual(harness.liveness.getThreadBackgroundWait(THREAD_ID)?.label, "1 agent");
      }),
    ),
  );

  it.effect("names each agent once, so a follow-up instruction keeps the name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* makeHarness({
          taskStates: [
            makeTaskState({ id: "child-1", title: "Review the diff for correctness bugs." }),
          ],
        });
        yield* runRows(
          harness,
          [
            codexChildRow("child-1", ASSIGNMENT),
            codexChildRow("child-1", "Also check the tests you find.", "task.progress"),
          ],
          3,
        ).pipe(Effect.provide(harness.layer));

        assert.deepStrictEqual(yield* Ref.get(harness.generations), [ASSIGNMENT]);
        assert.strictEqual((yield* Ref.get(harness.commands)).length, 1);
      }),
    ),
  );
});
