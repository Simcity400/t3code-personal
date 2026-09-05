import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  type TaskState,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryPersistenceError } from "./provider/Errors.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import type { CrossProviderAgentRecord } from "./provider/CrossProviderAgentRecovery.ts";
import { updateTaskState } from "./orchestration/taskState.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const updatedAt = "2026-08-20T12:00:00.000Z";
const emptyRecoveryDirectory: ProviderSessionDirectory.ProviderSessionDirectory["Service"] = {
  getBinding: () => Effect.succeed(Option.none()),
  getProvider: () => Effect.die("unused"),
  upsert: () => Effect.die("startup must not write recovery bindings"),
  listBindings: () => Effect.die("startup must not scan recovery bindings"),
  listThreadIds: () => Effect.die("startup must not enumerate hidden sessions"),
};

it.effect(
  "settles lost bridge executions without losing task identity and cancels requests truthfully",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("bridge-root");
      const state = updateTaskState(undefined, {
        id: EventId.make("original"),
        kind: "task.updated",
        tone: "info",
        summary: "Reviewer",
        turnId: null,
        createdAt: updatedAt,
        payload: {
          taskId: "child",
          taskType: "cross_provider",
          title: "Reviewer",
          model: "child-model",
          executionOwner: "cross-provider",
          status: "running",
          canStop: true,
        },
      })!;
      const commands: OrchestrationCommand[] = [];
      yield* ServerRuntimeStartup.reconcileCrossProviderExecutions.pipe(
        Effect.provideService(
          ProviderSessionDirectory.ProviderSessionDirectory,
          emptyRecoveryDirectory,
        ),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCrossProviderRecovery: () =>
            Effect.succeed({
              tasks: [{ threadId, state }],
              requests: [
                {
                  threadId,
                  activity: {
                    id: EventId.make("question"),
                    createdAt: updatedAt,
                    kind: "user-input.requested",
                    tone: "info",
                    summary: "Question",
                    turnId: null,
                    payload: { requestId: "question", bridgeAgentId: "child", agentId: "child" },
                  },
                },
              ],
            }),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      );
      assert.equal(commands.length, 2);
      const request = commands[0];
      const task = commands[1];
      assert.ok(
        request?.type === "thread.activity.append" && task?.type === "thread.activity.append",
      );
      if (request?.type !== "thread.activity.append" || task?.type !== "thread.activity.append")
        return;
      assert.equal(request.activity.summary, "User input cancelled after server restart");
      assert.equal((request.activity.payload as { cancelled: boolean }).cancelled, true);
      assert.equal(task.activity.kind, "task.state");
      assert.deepEqual(task.activity.payload, {
        ...state,
        status: "interrupted",
        canStop: false,
        canResume: false,
        waitReason: null,
        waitingSince: null,
        completedAt: task.createdAt,
        updatedAt: task.createdAt,
        error:
          "The child provider session did not survive a server restart. Start a new child to continue.",
      });
    }),
);

it.effect(
  "offers durable wrapper recovery without resuming or scanning history, including closed sessions",
  () =>
    Effect.gen(function* () {
      const root = ThreadId.make("durable-root");
      const cases = [
        { id: "running", status: "running", resumable: true },
        { id: "completed", status: "completed", resumable: true },
        { id: "failed", status: "failed", resumable: true },
        { id: "interrupted", status: "interrupted", resumable: true },
        { id: "idle", status: "idle", resumable: true },
        { id: "closed", status: "completed", resumable: true },
        { id: "deleted", status: "interrupted", resumable: false },
        { id: "legacy", status: "running", resumable: false },
        { id: "missing", status: "running", resumable: false },
        { id: "invalid", status: "running", resumable: false },
        { id: "wrong-root", status: "running", resumable: false },
        { id: "native", status: "running", resumable: false },
      ] as const;
      let tasks = cases.map(({ id, status }) => ({
        threadId: root,
        state: updateTaskState(undefined, {
          id: EventId.make(id),
          kind: "task.updated",
          tone: "info",
          summary: id,
          turnId: null,
          createdAt: updatedAt,
          payload: {
            taskId: id,
            taskType: id === "native" ? "local_agent" : "cross_provider",
            executionOwner: "cross-provider",
            status,
            title: id,
            canResume: id === "deleted" || id === "native",
            canStop: true,
          },
        })!,
      }));
      const reads: ThreadId[] = [];
      const commands: OrchestrationCommand[] = [];
      const directory = {
        ...emptyRecoveryDirectory,
        getBinding: (threadId: ThreadId) =>
          Effect.sync(() => {
            reads.push(threadId);
            const id = threadId.slice("cross-provider-session:".length);
            if (id === "missing") return Option.none();
            const record: CrossProviderAgentRecord = {
              version: 1,
              id,
              root: id === "wrong-root" ? ThreadId.make("other-root") : root,
              provider: ProviderDriverKind.make("codex"),
              instance: providerInstanceId,
              sourceSession: {
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId,
                threadId: root,
                status: "closed",
                runtimeMode: "full-access",
                createdAt: updatedAt,
                updatedAt,
              },
              title: id,
              providerName: "Codex",
              status: "completed",
              manualStop: true,
              closed: id === "closed",
              deleted: id === "deleted",
              generation: 1,
              assignment: "Review",
              context: "Saved context",
              reply: "",
              turnAccepted: true,
              forceFresh: true,
            };
            return Option.some({
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              runtimePayload:
                id === "legacy"
                  ? {}
                  : { crossProviderRecovery: id === "invalid" ? { id } : record },
            });
          }),
      } satisfies ProviderSessionDirectory.ProviderSessionDirectory["Service"];
      const reconcile = ServerRuntimeStartup.reconcileCrossProviderExecutions.pipe(
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCrossProviderRecovery: () => Effect.sync(() => ({ tasks, requests: [] })),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              commands.push(command);
              assert.equal(command.type, "thread.activity.append");
              if (command.type === "thread.activity.append") {
                const state = command.activity.payload as TaskState;
                tasks = tasks.map((entry) =>
                  entry.state.id === state.id ? { ...entry, state } : entry,
                );
              }
              return { sequence: commands.length };
            }),
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      );
      yield* reconcile;
      assert.equal(commands.length, cases.length);
      assert.ok(reads.every((id) => id !== "cross-provider-session:native"));
      for (const fixture of cases) {
        const state = tasks.find((entry) => entry.state.id === fixture.id)!.state;
        assert.equal(state.canResume, fixture.resumable, fixture.id);
        assert.equal(state.canStop, false);
        assert.equal(
          state.status,
          fixture.status === "running" || fixture.status === "idle"
            ? "interrupted"
            : fixture.status,
        );
        if (fixture.resumable && (fixture.status === "running" || fixture.status === "idle"))
          assert.ok(state.error?.includes("Resume this agent"));
      }
      yield* reconcile;
      assert.equal(commands.length, cases.length, "second startup is idempotent");
    }),
);

const makeThread = (
  id: string,
  status: "starting" | "running" | "ready" | "stopped" | "error",
  activeTurnId: TurnId | null = null,
  archivedAt: string | null = null,
  deletedAt: string | null = null,
) => ({
  id: ThreadId.make(id),
  archivedAt,
  deletedAt,
  interactionMode: "default" as const,
  session: {
    threadId: ThreadId.make(id),
    status,
    providerName: "codex" as const,
    providerInstanceId,
    runtimeMode: "full-access" as const,
    activeTurnId,
    lastError: null,
    updatedAt,
  },
});

const makeProviderService = (liveThreadIds: ReadonlyArray<ThreadId> = []) =>
  ({
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as never)),
    getCapabilities: () => Effect.die("unused"),
    assertConversationRollbackSupported: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    uploadFeedback: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }) satisfies ProviderService.ProviderService["Service"];

const queryWithThreads = (threads: ReadonlyArray<ReturnType<typeof makeThread>>) =>
  ({
    getCrossProviderRecovery: () => Effect.succeed({ tasks: [], requests: [] }),
    getUserInputActivity: () => Effect.die("unused"),
    getTaskState: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.succeed({ threads } as never),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const runReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof makeThread>>;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
  readonly providerService?: ProviderService.ProviderService["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
}) =>
  ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads(input.threads),
    ),
    Effect.provideService(
      ProviderService.ProviderService,
      input.providerService ?? makeProviderService(input.liveThreadIds),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: input.dispatch,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );

it.effect("marks active running sessions that have persisted resume state", () => {
  const active = makeThread("thread-mark-active", "running", TurnId.make("turn-mark-active"));
  const archived = makeThread(
    "thread-mark-archived",
    "running",
    TurnId.make("turn-mark-archived"),
    updatedAt,
  );
  const ready = makeThread("thread-mark-ready", "ready");
  const manual = makeThread("thread-manual-stop", "running", TurnId.make("turn-manual"));
  const missingResumeState = makeThread(
    "thread-mark-missing-resume-state",
    "running",
    TurnId.make("turn-mark-missing-resume-state"),
  );
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return ServerRuntimeStartup.markRunningProviderSessionsForContinuation.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads([active, archived, ready, missingResumeState, manual]),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: (threadId) =>
        Effect.sync(() => bindingReads.push(threadId)).pipe(
          Effect.as(
            Option.some({
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              ...(threadId === active.id || threadId === manual.id
                ? { resumeCursor: { threadId } }
                : {}),
              runtimePayload: {
                activeTurnId: "turn-mark-active",
                ...(threadId === manual.id ? { manualStopped: true } : {}),
              },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    }),
    Effect.tap((marked) =>
      Effect.sync(() => {
        assert.deepStrictEqual(bindingReads, [active.id, missingResumeState.id, manual.id]);
        assert.deepStrictEqual(marked, [active.id]);
        assert.deepStrictEqual(upserts[0]?.runtimePayload, {
          activeTurnId: "turn-mark-active",
          continueAfterServerUpdate: active.session.activeTurnId,
        });
      }),
    ),
  );
});

it.effect("continues marked sessions after activation with provider-specific input", () =>
  Effect.gen(function* () {
    const codex = makeThread(
      "thread-continue-codex",
      "running",
      TurnId.make("turn-continue-codex"),
    );
    const fallback = makeThread("thread-continue-fallback", "starting");
    const fallbackContinuationTurnId = TurnId.make("turn-continue-fallback");
    const fallbackProviderInstanceId = ProviderInstanceId.make("claudeAgent");
    const continuationSent = yield* Deferred.make<void>();
    const continuationCleared = yield* Deferred.make<void>();
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>(
      [codex, fallback].map((thread) => [
        thread.id,
        {
          threadId: thread.id,
          provider:
            thread.id === codex.id
              ? ProviderDriverKind.make("codex")
              : ProviderDriverKind.make("claudeAgent"),
          providerInstanceId:
            thread.id === codex.id ? providerInstanceId : fallbackProviderInstanceId,
          status: "running" as const,
          runtimePayload: {
            continueAfterServerUpdate:
              thread.id === codex.id ? codex.session.activeTurnId : fallbackContinuationTurnId,
          },
        },
      ]),
    );
    const providerService: ProviderService.ProviderService["Service"] = {
      ...makeProviderService(),
      getCapabilities: (instanceId) =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          ...(instanceId === providerInstanceId ? { promptlessTurnContinuation: true } : {}),
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          sends.push(input);
          if (sends.length === 2) {
            yield* Deferred.succeed(continuationSent, undefined);
          }
          return {
            threadId: input.threadId,
            turnId: TurnId.make(`continued-${String(input.threadId)}`),
          };
        }),
    };

    yield* runReconciliation({
      threads: [codex, fallback],
      providerService,
      directory: {
        getBinding: (threadId) =>
          Effect.sync(() => {
            const binding = bindings.get(threadId);
            return binding === undefined ? Option.none() : Option.some(binding);
          }),
        upsert: (binding) =>
          Effect.sync(() => {
            bindings.set(binding.threadId, binding);
            upserts.push(binding);
            const clearedCount = upserts.filter((candidate) => {
              const payload = candidate.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                "continueAfterServerUpdate" in payload &&
                payload.continueAfterServerUpdate === null
              );
            }).length;
            return clearedCount === 1;
          }).pipe(
            Effect.flatMap((firstMarkerCleared) =>
              firstMarkerCleared ? Deferred.succeed(continuationCleared, undefined) : Effect.void,
            ),
          ),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.die("unused"),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    });
    yield* Deferred.await(continuationSent);
    yield* Deferred.await(continuationCleared);

    assert.deepStrictEqual(
      sends.toSorted((left, right) => String(left.threadId).localeCompare(String(right.threadId))),
      [
        { threadId: codex.id, continuation: true, interactionMode: "default" },
        {
          threadId: fallback.id,
          input: "Continue where you left off.",
          interactionMode: "default",
        },
      ],
    );
    assert.deepStrictEqual(
      dispatched.map((command) =>
        command.type === "thread.session.set"
          ? {
              threadId: command.threadId,
              status: command.session.status,
              activeTurnId: command.session.activeTurnId,
            }
          : null,
      ),
      [
        {
          threadId: codex.id,
          status: "starting",
          activeTurnId: null,
        },
        {
          threadId: fallback.id,
          status: "starting",
          activeTurnId: fallback.session.activeTurnId,
        },
      ],
    );
    for (const [thread, continuationTurnId] of [
      [codex, codex.session.activeTurnId],
      [fallback, fallbackContinuationTurnId],
    ] as const) {
      assert.deepStrictEqual(
        upserts
          .filter((binding) => binding.threadId === thread.id)
          .map((binding) => binding.runtimePayload)[0],
        {
          continueAfterServerUpdate: continuationTurnId,
          activeTurnId: null,
        },
      );
    }
    assert.equal(
      upserts.some((binding) => {
        const payload = binding.runtimePayload;
        return (
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          "continueAfterServerUpdate" in payload &&
          payload.continueAfterServerUpdate === null
        );
      }),
      true,
    );
  }),
);

it.effect("does not continue archived, deleted, or manually stopped marked sessions", () => {
  const archived = makeThread(
    "thread-continue-archived",
    "running",
    TurnId.make("turn-continue-archived"),
    updatedAt,
  );
  const deleted = makeThread(
    "thread-continue-deleted",
    "running",
    TurnId.make("turn-continue-deleted"),
    null,
    updatedAt,
  );
  const sends: ProviderSendTurnInput[] = [];
  const dispatched: OrchestrationCommand[] = [];

  return runReconciliation({
    threads: [
      archived,
      deleted,
      makeThread("manual-marked", "running", TurnId.make("manual-turn")),
    ],
    providerService: {
      ...makeProviderService(),
      sendTurn: (input) =>
        Effect.sync(() => {
          sends.push(input);
          return {
            threadId: input.threadId,
            turnId: TurnId.make("unexpected-archived-turn"),
          };
        }),
    },
    directory: {
      getBinding: (threadId) => {
        const thread = threadId === archived.id ? archived : deleted;
        return Effect.succeed(
          Option.some({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { cursor: threadId },
            runtimePayload: {
              continueAfterServerUpdate:
                threadId === "manual-marked" ? "manual-turn" : thread.session.activeTurnId,
              ...(threadId === "manual-marked" ? { manualStopped: true } : {}),
            },
          }),
        );
      },
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(sends, []);
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? { threadId: command.threadId, status: command.session.status }
              : null,
          ),
          [
            { threadId: archived.id, status: "error" },
            { threadId: deleted.id, status: "error" },
            { threadId: ThreadId.make("manual-marked"), status: "error" },
          ],
        );
      }),
    ),
  );
});

it.effect("retries continuation preparation before settling a persistent failure", () => {
  const thread = makeThread(
    "thread-continuation-preparation-failure",
    "running",
    TurnId.make("turn-continuation-preparation-failure"),
  );
  const dispatched: OrchestrationCommand[] = [];
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated continuation preparation failure",
  });

  return runReconciliation({
    threads: [thread],
    directory: {
      getBinding: () =>
        Effect.succeed(
          Option.some({
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { cursor: thread.id },
            runtimePayload: {
              continueAfterServerUpdate: thread.session.activeTurnId,
            },
          }),
        ),
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      dispatched.push(command);
      return command.session.status === "starting"
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: dispatched.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.deepStrictEqual(
          dispatched.map(
            (command) => command.type === "thread.session.set" && command.session.status,
          ),
          ["starting", "starting", "error"],
        ),
      ),
    ),
  );
});

it.effect("reconciles multiple active and archived orphans but skips live sessions", () => {
  const starting = makeThread("thread-starting", "starting");
  const running = makeThread("thread-running", "running", TurnId.make("turn-running"));
  const staleActiveTurn = makeThread(
    "thread-stale-active-turn",
    "ready",
    TurnId.make("turn-stale-active"),
  );
  const archived = makeThread(
    "thread-archived",
    "running",
    TurnId.make("turn-archived"),
    updatedAt,
  );
  const live = makeThread("thread-live", "running", TurnId.make("turn-live"));
  const settled = makeThread("thread-ready", "ready");
  const dispatched: OrchestrationCommand[] = [];
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return runReconciliation({
    threads: [starting, running, staleActiveTurn, archived, live, settled],
    liveThreadIds: [live.id],
    directory: {
      getBinding: (candidate) =>
        Effect.sync(() => bindingReads.push(candidate)).pipe(
          Effect.as(
            Option.some({
              threadId: candidate,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: "running" as const,
              resumeCursor: { cursor: candidate },
              runtimePayload: {
                activeTurnId: "stale",
                unrelated: candidate,
                ...(candidate === staleActiveTurn.id
                  ? { continueAfterServerUpdate: "turn-from-an-earlier-update" }
                  : {}),
              },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const orphanIds = [starting.id, running.id, staleActiveTurn.id, archived.id];
        assert.deepStrictEqual(bindingReads, orphanIds);
        assert.deepStrictEqual(
          dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
          orphanIds,
        );
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? {
                  status: command.session.status,
                  activeTurnId: command.session.activeTurnId,
                }
              : null,
          ),
          orphanIds.map(() => ({ status: "error" as const, activeTurnId: null })),
        );
        assert.equal(upserts.length, orphanIds.length);
        for (const binding of upserts) {
          assert.equal(binding.status, "stopped");
          assert.deepStrictEqual(
            binding.runtimePayload,
            binding.threadId === staleActiveTurn.id
              ? {
                  activeTurnId: null,
                  unrelated: binding.threadId,
                  continueAfterServerUpdate: null,
                }
              : { activeTurnId: null, unrelated: binding.threadId },
          );
          assert.deepStrictEqual(binding.resumeCursor, { cursor: binding.threadId });
        }
      }),
    ),
  );
});

it.effect(
  "settles projections when directory bindings are absent, corrupt, or fail to upsert",
  () => {
    const absent = makeThread("thread-binding-absent", "starting");
    const corrupt = makeThread("thread-binding-corrupt", "running");
    const upsertFailure = makeThread("thread-binding-upsert-failure", "running");
    const dispatched: OrchestrationCommand[] = [];
    const corruptFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.getBinding",
      detail: "corrupt persisted binding",
    });
    const writeFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.upsert",
      detail: "failed binding write",
    });

    return runReconciliation({
      threads: [absent, corrupt, upsertFailure],
      directory: {
        getBinding: (candidate) =>
          candidate === absent.id
            ? Effect.succeed(Option.none())
            : candidate === corrupt.id
              ? Effect.fail(corruptFailure)
              : Effect.succeed(
                  Option.some({
                    threadId: candidate,
                    provider: ProviderDriverKind.make("codex"),
                    providerInstanceId,
                  }),
                ),
        upsert: () => Effect.fail(writeFailure),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.die("unused"),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
            [absent.id, corrupt.id, upsertFailure.id],
          );
        }),
      ),
    );
  },
);

it.effect("retries failed projections and continues after a persistent failure", () => {
  const transient = makeThread("thread-dispatch-transient-failure", "running");
  const persistent = makeThread("thread-dispatch-persistent-failure", "running");
  const later = makeThread("thread-dispatch-success", "running");
  const attempted: ThreadId[] = [];
  let transientAttempts = 0;
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated startup reconciliation failure",
  });

  return runReconciliation({
    threads: [transient, persistent, later],
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      attempted.push(command.threadId);
      if (command.threadId === transient.id && transientAttempts++ === 0) {
        return Effect.fail(failure);
      }
      return command.threadId === persistent.id
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: attempted.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.deepStrictEqual(attempted, [
          transient.id,
          transient.id,
          persistent.id,
          persistent.id,
          later.id,
        ]),
      ),
    ),
  );
});

it.effect("does not fail startup when the live provider session inventory cannot be read", () => {
  let queried = false;
  return ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getUserInputActivity: () => Effect.die("unused"),
      getTaskState: () => Effect.die("unused"),
      getCommandReadModel: () =>
        Effect.sync(() => {
          queried = true;
          return { threads: [] } as never;
        }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    Effect.provideService(ProviderService.ProviderService, {
      ...makeProviderService(),
      listSessions: () => Effect.die("provider inventory unavailable"),
    }),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: () => Effect.die("unused"),
      upsert: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    }),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
    Effect.tap(() => Effect.sync(() => assert.equal(queried, false))),
  );
});
