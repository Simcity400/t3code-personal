import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  RuntimeTaskStatus,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../mcp/McpProviderSession.ts";
import {
  makeCrossProviderAgentBridge,
  type CrossAgentSpawnInput,
} from "./CrossProviderAgentBridge.ts";
import {
  CrossProviderAgentRecord,
  type CrossProviderAgentRecoveryStore,
} from "./CrossProviderAgentRecovery.ts";
import {
  ProviderAdapterValidationError,
  ProviderValidationError,
  type ProviderAdapterError,
  type ProviderServiceError,
} from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import { makeAdapterRegistryMock } from "./testUtils/providerAdapterRegistryMock.ts";

const now = "2026-09-05T00:00:00.000Z";
const codexInstance = ProviderInstanceId.make("codex");
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const rootId = ThreadId.make("bridge-test-root");
const otherRootId = ThreadId.make("bridge-test-other-root");
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.Struct({
    agentId: Schema.String,
    providerInstanceId: ProviderInstanceId,
    status: RuntimeTaskStatus,
    closed: Schema.Boolean,
    manuallyStopped: Schema.Boolean,
    reply: Schema.String,
    queuedMessages: Schema.Number,
    pendingRequests: Schema.Array(Schema.String),
  }),
);
const decodeRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
const RecoveryJson = Schema.fromJsonString(CrossProviderAgentRecord);
const encodeRecovery = Schema.encodeEffect(RecoveryJson);
const decodeRecovery = Schema.decodeUnknownEffect(RecoveryJson);

const recoveryError = () =>
  new ProviderValidationError({
    operation: "test.recovery",
    issue: "Invalid serialized recovery record",
  });

const makeRecovery = (records: Map<string, string>): CrossProviderAgentRecoveryStore => ({
  save: Effect.fn("test.recovery.save")(function* (record) {
    records.set(record.id, yield* encodeRecovery(record).pipe(Effect.mapError(recoveryError)));
  }),
  load: Effect.fn("test.recovery.load")(function* (id) {
    const json = records.get(id);
    return json === undefined
      ? undefined
      : yield* decodeRecovery(json).pipe(Effect.mapError(recoveryError));
  }),
  list: Effect.fn("test.recovery.list")(function* (root) {
    const decoded = yield* Effect.forEach([...records.values()], (json) =>
      decodeRecovery(json).pipe(Effect.mapError(recoveryError)),
    );
    return decoded.filter((record) => record.root === root);
  }),
});

type CallReceipt<A> = { input: A; worker: Fiber.Fiber<unknown, unknown> };

const joinWorker = Effect.fn("test.joinWorker")(function* (worker: Fiber.Fiber<unknown, unknown>) {
  const result = yield* Fiber.await(worker);
  if (Exit.isFailure(result)) assert.fail(Cause.pretty(result.cause));
});

const makeAdapter = Effect.fn("test.makeAdapter")(function* (provider: ProviderDriverKind) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const starts = yield* Queue.unbounded<CallReceipt<ProviderSessionStartInput>>();
  const sends = yield* Queue.unbounded<
    CallReceipt<ProviderSendTurnInput> & {
      result: ProviderTurnStartResult;
    }
  >();
  const deliveries: ProviderSendTurnInput[] = [];
  const interruptions: Parameters<Adapter["interruptTurn"]>[] = [];
  const approvals: Parameters<Adapter["respondToRequest"]>[] = [];
  const answers: Parameters<Adapter["respondToUserInput"]>[] = [];
  const stoppedTasks: { threadId: ThreadId; taskId: string }[] = [];
  const stoppedSessions: ThreadId[] = [];
  const gates: {
    start: Effect.Effect<void, ProviderAdapterError>;
    send: Effect.Effect<void, ProviderAdapterError>;
    interrupt: Effect.Effect<void, ProviderAdapterError>;
    stopSession: Effect.Effect<void, ProviderAdapterError>;
  } = { start: Effect.void, send: Effect.void, interrupt: Effect.void, stopSession: Effect.void };
  const capabilities = {
    sessionModelSwitch: "in-session" as const,
    supportsInputSteering: false,
  };
  let turnSequence = 0;
  let sessionSequence = 0;
  const adapter: Adapter = {
    provider,
    capabilities,
    startSession: (input) =>
      Effect.withFiber((worker) =>
        Effect.gen(function* () {
          yield* Queue.offer(starts, { input, worker });
          yield* gates.start;
          const session: ProviderSession = {
            provider,
            providerInstanceId: input.providerInstanceId ?? ProviderInstanceId.make(provider),
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            status: "ready",
            cwd: input.cwd ?? "/bridge-test",
            createdAt: now,
            updatedAt: now,
            resumeCursor: input.resumeCursor ?? {
              sessionId: `native-session-${++sessionSequence}`,
            },
          };
          sessions.set(input.threadId, session);
          return session;
        }),
      ),
    sendTurn: (input) =>
      Effect.withFiber((worker) =>
        Effect.gen(function* () {
          const result = {
            threadId: input.threadId,
            turnId: TurnId.make(`turn-${++turnSequence}`),
            resumeCursor: sessions.get(input.threadId)?.resumeCursor,
          };
          yield* Queue.offer(sends, { input, worker, result });
          yield* gates.send;
          deliveries.push(input);
          return result;
        }),
      ),
    interruptTurn: (...args) =>
      Effect.gen(function* () {
        interruptions.push(args);
        yield* gates.interrupt;
      }),
    respondToRequest: (...args) =>
      Effect.sync(() => {
        approvals.push(args);
      }),
    respondToUserInput: (...args) =>
      Effect.sync(() => {
        answers.push(args);
      }),
    stopTask: (threadId, taskId) =>
      Effect.sync(() => {
        stoppedTasks.push({ threadId, taskId });
      }),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        stoppedSessions.push(threadId);
        yield* gates.stopSession;
        sessions.delete(threadId);
      }),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    listSessions: () => Effect.sync(() => [...sessions.values()]),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () =>
      Effect.sync(() => {
        sessions.clear();
      }),
    streamEvents: Stream.empty,
  };
  // A receipt exposes the bridge's dispatch worker, so joining it proves that
  // bookkeeping after the adapter call has finished as well as delivery itself.
  const nextTurn = Effect.gen(function* () {
    const receipt = yield* Queue.take(sends);
    yield* joinWorker(receipt.worker);
    return receipt;
  });
  return {
    adapter,
    capabilities,
    sessions,
    starts,
    sends,
    deliveries,
    interruptions,
    approvals,
    answers,
    stoppedTasks,
    stoppedSessions,
    gates,
    nextTurn,
  };
});

const makeHarness = Effect.fn("test.makeHarness")(function* (records = new Map<string, string>()) {
  const recovery = makeRecovery(records);
  const bridgeScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(bridgeScope, Exit.void));
  const codex = yield* makeAdapter(ProviderDriverKind.make("codex"));
  const claude = yield* makeAdapter(ProviderDriverKind.make("claudeAgent"));
  const events: ProviderRuntimeEvent[] = [];
  const touches: ThreadId[] = [];
  const cleared: ThreadId[] = [];
  const registered = new Set<ThreadId>();
  const stoppedRoots = new Set<ThreadId>();
  const gates: {
    prepare: Effect.Effect<void>;
    publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    registry: (instance: ProviderInstanceId) => Effect.Effect<void>;
    save: (record: CrossProviderAgentRecord) => Effect.Effect<void, ProviderServiceError>;
  } = {
    prepare: Effect.void,
    publish: () => Effect.void,
    registry: () => Effect.void,
    save: () => Effect.void,
  };
  const caller = (threadId: ThreadId, providerInstanceId = codexInstance): McpInvocationScope => ({
    environmentId: EnvironmentId.make("bridge-test-environment"),
    threadId,
    providerInstanceId,
    providerSessionId: `mcp:${threadId}`,
    capabilities: new Set(["preview"]),
    issuedAt: 0,
  });
  const register = (
    threadId: ThreadId,
    instance: ProviderInstanceId,
    visibleThreadId?: ThreadId,
  ) => {
    const invocation = caller(threadId, instance);
    setMcpProviderSession({
      ...invocation,
      ...(visibleThreadId ? { visibleThreadId } : {}),
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer test-only",
    });
    registered.add(threadId);
    return invocation;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const threadId of registered) clearMcpProviderSession(threadId);
    }),
  );
  const root = register(rootId, codexInstance);
  const otherRoot = register(otherRootId, codexInstance);
  const registry = makeAdapterRegistryMock({
    [codex.adapter.provider]: codex.adapter,
    [claude.adapter.provider]: claude.adapter,
  });
  const dependencies = {
    recovery: {
      ...recovery,
      save: (record: CrossProviderAgentRecord) =>
        Effect.suspend(() => gates.save(record)).pipe(Effect.andThen(recovery.save(record))),
    },
    registry: {
      ...registry,
      getByInstance: (instance: ProviderInstanceId) =>
        gates.registry(instance).pipe(Effect.andThen(registry.getByInstance(instance))),
    },
    publish: (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        events.push(event);
        yield* gates.publish(event);
      }),
    prepare: (threadId: ThreadId, instance: ProviderInstanceId, visibleThreadId: ThreadId) =>
      Effect.gen(function* () {
        register(threadId, instance, visibleThreadId);
        yield* gates.prepare;
      }),
    touch: (threadId: ThreadId) =>
      Effect.sync(() => {
        touches.push(threadId);
      }),
    clear: (threadId: ThreadId) =>
      Effect.sync(() => {
        cleared.push(threadId);
        clearMcpProviderSession(threadId);
      }),
    root: (threadId: ThreadId) =>
      Effect.succeed({
        session: {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstance,
          threadId,
          runtimeMode: "full-access",
          status: "ready",
          cwd: "/bridge-test",
          createdAt: now,
          updatedAt: now,
        },
        interactionMode: "default",
      }),
    rootStopped: (threadId: ThreadId) => Effect.sync(() => stoppedRoots.has(threadId)),
    enabled: Effect.succeed(true),
  } satisfies Parameters<typeof makeCrossProviderAgentBridge>[0];
  const bridge = yield* makeCrossProviderAgentBridge(dependencies).pipe(
    Effect.provideService(Scope.Scope, bridgeScope),
  );
  const crash = Scope.close(bridgeScope, Exit.void).pipe(
    Effect.andThen(
      Effect.sync(() => {
        for (const threadId of registered) clearMcpProviderSession(threadId);
        registered.clear();
      }),
    ),
  );
  const spawn = Effect.fn("test.spawn")(function* (
    input: Partial<typeof CrossAgentSpawnInput.Type> = {},
    invocation = root,
  ) {
    return yield* bridge
      .spawn(invocation, {
        providerInstanceId: claudeInstance,
        prompt: "Do the child assignment",
        ...input,
      })
      .pipe(Effect.flatMap(decodeSnapshot));
  });
  const emit = Effect.fn("test.emit")(function* (
    threadId: ThreadId,
    input: {
      type: ProviderRuntimeEvent["type"];
      payload: unknown;
      turnId?: TurnId;
      itemId?: string;
      requestId?: string;
    },
    adapter = claude.adapter,
  ) {
    const event = yield* decodeRuntimeEvent({
      eventId: `native-event-${events.length}`,
      provider: adapter.provider,
      providerInstanceId: ProviderInstanceId.make(adapter.provider),
      createdAt: now,
      threadId,
      ...input,
    });
    assert.isTrue(yield* bridge.onEvent(event, adapter));
  });
  const complete = (turn: ProviderTurnStartResult, adapter = claude.adapter) =>
    emit(
      turn.threadId,
      {
        type: "turn.completed",
        turnId: turn.turnId,
        payload: { state: "completed" },
      },
      adapter,
    );
  return {
    bridge,
    crash,
    recovery,
    records,
    codex,
    claude,
    root,
    otherRoot,
    caller,
    register,
    spawn,
    emit,
    complete,
    events,
    touches,
    cleared,
    stoppedRoots,
    gates,
  };
});

const expectRefused = Effect.fn("test.expectRefused")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const result = yield* Effect.result(effect);
  assert.strictEqual(result._tag, "Failure");
  if (result._tag === "Failure") assert.instanceOf(result.failure, ProviderValidationError);
});

it.layer(NodeCrypto.layer)("CrossProviderAgentBridge", (it) => {
  it.effect(
    "failed manual Stop at the provider boundary fences rollback of an older suspended activation save",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.complete(turn.result);
        assert.isFalse((yield* h.bridge.wait(h.root, { agentId: child.agentId })).manuallyStopped);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.gates.save = () => {
          h.gates.save = () => Effect.void;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.fail(
                new ProviderValidationError({
                  operation: "test.recovery.save",
                  issue: "Older activation save failed",
                }),
              ),
            ),
          );
        };
        const resuming = yield* h.bridge
          .stopTask(rootId, child.agentId, true)
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        h.claude.gates.interrupt = Effect.fail(
          new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "interruptTurn",
            issue: "The runtime cannot confirm Stop",
          }),
        );
        const stopFinished = yield* Deferred.make<void>();
        const stopping = yield* h.bridge
          .stopTask(rootId, child.agentId)
          .pipe(
            Effect.exit,
            Effect.ensuring(Deferred.succeed(stopFinished, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* TestClock.adjust(60_000);
        assert.isTrue(yield* Deferred.isDone(stopFinished));
        assert.isTrue(Exit.isFailure(yield* Fiber.join(stopping)));
        assert.isTrue((yield* h.bridge.wait(h.root, { agentId: child.agentId })).manuallyStopped);
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(resuming)));
        const afterRollback = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.isTrue(
          afterRollback.manuallyStopped,
          "An older failed Resume must not erase the newer failed manual Stop",
        );
        assert.strictEqual(afterRollback.queuedMessages, 0);
        assert.lengthOf(h.claude.deliveries, 1);
        yield* expectRefused(
          h.bridge.send(h.root, { agentId: child.agentId, prompt: "Bypass the failed Stop" }),
        );
      }),
  );

  it.effect(
    "an async answer can be resubmitted after its pre-dispatch save fails, and resolves only on accepted retry delivery",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "retry-answer",
          payload: { questions: [], responseMode: "message" },
        });
        yield* h.complete(turn.result);
        const requestId = `${child.agentId}:0:request:retry-answer`;
        const failedWorker = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        h.gates.save = () =>
          Effect.withFiber((worker) =>
            Deferred.succeed(failedWorker, worker).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderValidationError({
                    operation: "test.recovery.save",
                    issue: "Answer could not be journaled",
                  }),
                ),
              ),
            ),
          );
        assert.isTrue(
          yield* h.bridge.respond(rootId, requestId, { answers: { choice: "first answer" } }),
        );
        yield* joinWorker(yield* Deferred.await(failedWorker));
        assert.include(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          requestId,
        );
        assert.lengthOf(h.claude.deliveries, 1);
        assert.lengthOf(
          h.events.filter((event) => event.type === "user-input.resolved"),
          0,
        );
        h.gates.save = () => Effect.void;
        const releaseSend = yield* Deferred.make<void>();
        h.claude.gates.send = Deferred.await(releaseSend);
        assert.isTrue(
          yield* h.bridge.respond(rootId, requestId, {
            answers: { choice: "corrected retry answer" },
          }),
        );
        const retry = yield* Queue.take(h.claude.sends);
        assert.include(retry.input.input ?? "", "corrected retry answer");
        assert.notInclude(retry.input.input ?? "", "first answer");
        assert.include(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          requestId,
        );
        assert.lengthOf(
          h.events.filter((event) => event.type === "user-input.resolved"),
          0,
        );
        yield* Deferred.succeed(releaseSend, undefined);
        yield* joinWorker(retry.worker);
        assert.deepEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          [],
        );
        const resolved = h.events.filter((event) => event.type === "user-input.resolved");
        assert.lengthOf(resolved, 1);
        assert.strictEqual(resolved[0]?.requestId, requestId);
        assert.deepEqual(resolved[0]?.payload.answers, { choice: "corrected retry answer" });
        assert.lengthOf(h.claude.deliveries, 2);
      }),
  );

  it.effect.each(["self", "tree"] as const)(
    "confirmed %s Stop publishes interrupted/canResume and wakes existing waiters even when every save fails",
    (scope) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const waitFinished = yield* Deferred.make<void>();
        const waiting = yield* h.bridge
          .wait(h.root, { agentId: child.agentId, timeoutMs: 60_000 })
          .pipe(
            Effect.ensuring(Deferred.succeed(waitFinished, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        assert.isFalse(yield* Deferred.isDone(waitFinished));
        h.gates.save = () =>
          Effect.fail(
            new ProviderValidationError({
              operation: "test.recovery.save",
              issue: "Stop status could not be persisted",
            }),
          );
        const stopped = yield* Effect.exit(
          scope === "self"
            ? h.bridge.stopTask(rootId, child.agentId).pipe(Effect.asVoid)
            : h.bridge.stopTree(rootId),
        );
        assert.isTrue(Exit.isFailure(stopped));
        if (Exit.isFailure(stopped))
          assert.include(Cause.pretty(stopped.cause), "Stop status could not be persisted");
        assert.deepEqual(h.claude.interruptions, [[turn.input.threadId]]);
        const status = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(status?.payload.status, "interrupted");
        assert.strictEqual(status?.payload.canResume, true);
        assert.isTrue(
          yield* Deferred.isDone(waitFinished),
          "A confirmed stop must signal waiters without waiting for their timeout or durable storage",
        );
        const result = yield* Fiber.join(waiting);
        assert.strictEqual(result.status, "interrupted");
        assert.isTrue(result.manuallyStopped);
        assert.lengthOf(h.claude.deliveries, 1);
      }),
  );

  it.effect(
    "failed activation removes only its own queued instruction and preserves a concurrent message for explicit retry",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        yield* h.claude.nextTurn;
        yield* h.bridge.stopTask(rootId, child.agentId);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.gates.save = () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.fail(
                new ProviderValidationError({
                  operation: "test.recovery.save",
                  issue: "test storage offline",
                }),
              ),
            ),
          );
        const resuming = yield* h.bridge
          .stopTask(rootId, child.agentId, true)
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        yield* h.bridge.send(h.root, {
          agentId: child.agentId,
          prompt: "Preserve this separately queued instruction",
        });
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(resuming)));
        const failed = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(failed.status, "failed");
        assert.isTrue(failed.manuallyStopped);
        assert.strictEqual(failed.queuedMessages, 1);
        assert.strictEqual(yield* Queue.size(h.claude.sends), 0);
        assert.lengthOf(h.claude.deliveries, 1);
        h.gates.save = () => Effect.void;
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        const retained = yield* h.claude.nextTurn;
        assert.strictEqual(retained.input.input, "Preserve this separately queued instruction");
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
          1,
        );
        yield* h.complete(retained.result);
        yield* h.claude.nextTurn;
        assert.lengthOf(h.claude.deliveries, 3);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
          0,
        );
      }),
  );

  it.effect.each(["stopped", "closed"] as const)(
    "a failed activation save releases the %s child's reservation for explicit same-ID Resume after storage recovers",
    (lifecycle) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        yield* h.claude.nextTurn;
        if (lifecycle === "closed")
          yield* h.bridge.control(h.root, { agentId: child.agentId }, "close");
        else yield* h.bridge.stopTask(rootId, child.agentId);
        const durableBeforeFailure = h.records.get(child.agentId);
        let failedSaves = 0;
        h.gates.save = () =>
          Effect.suspend(() => {
            failedSaves++;
            return Effect.fail(
              new ProviderValidationError({
                operation: "test.recovery.save",
                issue: "test storage offline",
              }),
            );
          });
        const attempted = yield* Effect.exit(h.bridge.stopTask(rootId, child.agentId, true));
        assert.isTrue(Exit.isFailure(attempted));
        if (Exit.isFailure(attempted))
          assert.include(Cause.pretty(attempted.cause), "test storage offline");
        const failed = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(failed.status, "failed");
        assert.include(failed.error ?? "", "test storage offline");
        assert.strictEqual(failed.manuallyStopped, lifecycle === "stopped");
        assert.strictEqual(failed.closed, lifecycle === "closed");
        assert.strictEqual(failed.queuedMessages, 0);
        const status = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(status?.payload.status, "failed");
        assert.strictEqual(status?.payload.canResume, true);
        assert.include(status?.payload.error ?? "", "test storage offline");
        assert.strictEqual(
          h.records.get(child.agentId),
          durableBeforeFailure,
          "Publishing a failed status must not pretend the failed save persisted",
        );
        assert.strictEqual(
          failedSaves,
          1,
          "A database failure must not automatically retry activation",
        );
        assert.lengthOf(h.claude.deliveries, 1);
        h.gates.save = () => Effect.void;
        if (lifecycle === "stopped")
          yield* expectRefused(
            h.bridge.send(h.root, { agentId: child.agentId, prompt: "Bypass the failed Resume" }),
          );
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        yield* h.claude.nextTurn;
        const resumed = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(resumed.agentId, child.agentId);
        assert.strictEqual(resumed.status, "running");
        assert.isFalse(resumed.manuallyStopped);
        assert.isNull(resumed.error);
        assert.lengthOf(h.claude.deliveries, 2);
        assert.strictEqual(h.records.size, 1);
      }),
  );

  it.effect.each(["task", "instruction"] as const)(
    "an initial drain %s save failure releases dispatch ownership and only explicit same-ID Resume retries the assignment",
    (boundary) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const failedWorker = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        let armed = false;
        let failedSaves = 0;
        h.gates.publish = (event) =>
          Effect.sync(() => {
            if (armed || event.type !== "task.updated" || event.payload.status !== "pending")
              return;
            armed = true;
            h.gates.save = (record) =>
              boundary === "task" || record.context.includes("Instruction:")
                ? Effect.withFiber((worker) =>
                    Effect.gen(function* () {
                      failedSaves++;
                      yield* Deferred.succeed(failedWorker, worker);
                      return yield* new ProviderValidationError({
                        operation: "test.recovery.save",
                        issue: "test storage offline",
                      });
                    }),
                  )
                : Effect.void;
          });
        const child = yield* h.spawn({ prompt: "Keep the unstarted durable assignment" });
        yield* joinWorker(yield* Deferred.await(failedWorker));
        const failed = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(failed.status, "failed");
        assert.include(failed.error ?? "", "test storage offline");
        assert.strictEqual(failed.queuedMessages, 0);
        const status = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(status?.payload.status, "failed");
        assert.strictEqual(status?.payload.canResume, true);
        assert.include(status?.payload.error ?? "", "test storage offline");
        assert.strictEqual(
          (yield* h.recovery.load(child.agentId))?.status,
          "pending",
          "The UI failure is not a claim that the failed save reached durable storage",
        );
        assert.strictEqual(failedSaves, 1);
        assert.deepEqual(h.claude.deliveries, []);
        assert.strictEqual(yield* Queue.size(h.claude.starts), 0);
        h.gates.save = () => Effect.void;
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        const resumed = yield* h.claude.nextTurn;
        assert.include(resumed.input.input ?? "", "Keep the unstarted durable assignment");
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.agentId, child.agentId);
        assert.strictEqual(state.status, "running");
        assert.isNull(state.error);
        assert.lengthOf(h.claude.deliveries, 1);
        assert.strictEqual(h.records.size, 1);
      }),
  );

  it.effect(
    "missing-history recovery still dispatches once when the old process exits before the recovery registry lookup completes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn({
          prompt: "Recover the assignment after the old process exits",
        });
        const original = yield* h.claude.nextTurn;
        const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const release = yield* Deferred.make<void>();
        h.gates.registry = () =>
          Effect.withFiber((worker) =>
            Deferred.succeed(entered, worker).pipe(Effect.andThen(Deferred.await(release))),
          );
        yield* h.emit(original.input.threadId, {
          type: "runtime.error",
          turnId: original.result.turnId,
          payload: { message: "No conversation found with session ID: dying-original-process" },
        });
        const recoveryWorker = yield* Deferred.await(entered);
        yield* h.emit(original.input.threadId, {
          type: "session.exited",
          turnId: original.result.turnId,
          payload: { reason: "Missing-history process exited", recoverable: false },
        });
        yield* Deferred.succeed(release, undefined);
        yield* joinWorker(recoveryWorker);
        assert.lengthOf(
          h.claude.deliveries,
          2,
          "The old process exit must not strand the already requested recovery",
        );
        const recovered = yield* h.claude.nextTurn;
        assert.notStrictEqual(recovered.input.threadId, original.input.threadId);
        assert.include(
          recovered.input.input ?? "",
          "Recover the assignment after the old process exits",
        );
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.agentId, child.agentId);
        assert.strictEqual(state.queuedMessages, 0);
      }),
  );

  it.effect(
    "concurrent Resume cannot enqueue twice while the first activation save is suspended",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        yield* h.claude.nextTurn;
        yield* h.bridge.stopTask(rootId, child.agentId);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.gates.save = (record) =>
          record.id === child.agentId && !record.manualStop
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void;
        const first = yield* h.bridge
          .stopTask(rootId, child.agentId, true)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const second = yield* Effect.result(h.bridge.stopTask(rootId, child.agentId, true)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(yield* Fiber.join(first));
        const duplicate = yield* Fiber.join(second);
        assert.strictEqual(duplicate._tag, "Failure");
        if (duplicate._tag === "Failure")
          assert.instanceOf(duplicate.failure, ProviderValidationError);
        const resumed = yield* h.claude.nextTurn;
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
          0,
        );
        yield* h.complete(resumed.result);
        assert.strictEqual(yield* Queue.size(h.claude.sends), 0);
        assert.lengthOf(h.claude.deliveries, 2);
      }),
  );

  it.effect.each([false, true])(
    "Stop all fences a closed child's pending registry-gated activation after restart=%s",
    (restart) =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const child = yield* first.spawn();
        yield* first.claude.nextTurn;
        yield* first.bridge.control(first.root, { agentId: child.agentId }, "close");
        if (restart) yield* first.crash;
        const h = restart ? yield* makeHarness(first.records) : first;
        assert.isTrue((yield* h.bridge.wait(h.root, { agentId: child.agentId })).closed);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.gates.registry = () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        const resuming = yield* Effect.result(h.bridge.stopTask(rootId, child.agentId, true)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(entered);
        const beforeStop = h.claude.deliveries.length;
        yield* h.bridge.stopTree(rootId);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(resuming);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.instanceOf(result.failure, ProviderValidationError);
        h.bridge.releaseRootStop(rootId);
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.isTrue(state.manuallyStopped);
        assert.isTrue(state.closed);
        assert.strictEqual(state.queuedMessages, 0);
        assert.lengthOf(h.claude.deliveries, beforeStop);
        assert.isTrue((yield* h.recovery.load(child.agentId))?.manualStop);
      }),
  );

  it.effect.each([
    { scope: "self", persistence: "fail" },
    { scope: "self", persistence: "stall" },
    { scope: "tree", persistence: "fail" },
    { scope: "tree", persistence: "stall" },
  ] as const)(
    "$scope stop still cancels actual provider work within a bound when persistence can $persistence",
    ({ scope, persistence }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const sibling = yield* h.spawn({ prompt: "Other work in the same tree" });
        const siblingTurn = yield* h.claude.nextTurn;
        const saveEntered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        h.gates.save = () =>
          Deferred.succeed(saveEntered, undefined).pipe(
            Effect.andThen(
              persistence === "stall"
                ? Deferred.await(release)
                : Effect.fail(
                    new ProviderValidationError({
                      operation: "test.recovery.save",
                      issue: "Durable storage is unavailable",
                    }),
                  ),
            ),
          );
        const stopping = yield* (
          scope === "self"
            ? h.bridge.stopTask(rootId, child.agentId).pipe(Effect.asVoid)
            : h.bridge.stopTree(rootId)
        ).pipe(
          Effect.exit,
          Effect.ensuring(Deferred.succeed(finished, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(saveEntered);
        yield* TestClock.adjust(60_000);
        assert.deepEqual(
          h.claude.interruptions,
          scope === "self"
            ? [[turn.input.threadId]]
            : [[turn.input.threadId], [siblingTurn.input.threadId]],
        );
        assert.isTrue(
          yield* Deferred.isDone(finished),
          "The stop receipt must be bounded despite unavailable persistence",
        );
        yield* Fiber.join(stopping);
        h.gates.save = () => Effect.void;
        yield* Deferred.succeed(release, undefined);
        h.bridge.releaseRootStop(rootId);
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.isTrue(state.manuallyStopped);
        assert.strictEqual(state.status, "interrupted");
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: sibling.agentId })).status,
          scope === "self" ? "running" : "interrupted",
        );
        assert.lengthOf(h.claude.deliveries, 2);
      }),
  );

  it.effect.each(["native-child", "settled-turn", "other-turn"] as const)(
    "a missing-history runtime error belonging to %s cannot recover or replace the wrapper",
    (owner) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const original = yield* h.claude.nextTurn;
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* h.bridge.stopTask(rootId, child.agentId, true);
        const current = yield* h.claude.nextTurn;
        if (owner === "native-child")
          yield* h.emit(current.input.threadId, {
            type: "task.started",
            payload: { taskId: "native-owner", taskType: "local_agent", agentKind: "agent" },
          });
        const before = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        yield* h.emit(current.input.threadId, {
          type: "runtime.error",
          turnId:
            owner === "settled-turn"
              ? original.result.turnId
              : owner === "other-turn"
                ? TurnId.make("unrelated-old-turn")
                : current.result.turnId,
          payload: {
            message: "No conversation found with session ID: not-the-wrapper",
            ...(owner === "native-child" ? { agentId: "native-owner" } : {}),
          },
        });
        assert.deepEqual(yield* h.bridge.wait(h.root, { agentId: child.agentId }), before);
        assert.isFalse((yield* h.recovery.load(child.agentId))?.forceFresh);
        assert.deepEqual(h.claude.stoppedSessions, []);
        assert.lengthOf(h.claude.deliveries, 2);
        yield* h.emit(current.input.threadId, {
          type: "content.delta",
          turnId: current.result.turnId,
          payload: { streamKind: "assistant_text", delta: "The real wrapper continues" },
        });
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).reply,
          "The real wrapper continues",
        );
      }),
  );

  it.effect(
    "partial streaming reply survives Stop, restart, and missing-history recovery without item completion",
    () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const child = yield* first.spawn({ prompt: "Continue the migration safely" });
        const turn = yield* first.claude.nextTurn;
        yield* first.emit(turn.input.threadId, {
          type: "content.delta",
          turnId: turn.result.turnId,
          itemId: "unfinished-message",
          payload: {
            streamKind: "assistant_text",
            delta: "The migration committed successfully; ",
          },
        });
        yield* first.emit(turn.input.threadId, {
          type: "content.delta",
          turnId: turn.result.turnId,
          itemId: "unfinished-message",
          payload: { streamKind: "assistant_text", delta: "only validation remains" },
        });
        yield* first.bridge.stopTask(rootId, child.agentId);
        yield* first.crash;
        const restarted = yield* makeHarness(first.records);
        restarted.claude.gates.start = Effect.suspend(() => {
          restarted.claude.gates.start = Effect.void;
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: "claudeAgent",
              operation: "startSession",
              issue: "No conversation found with session ID: lost-on-restart",
            }),
          );
        });
        assert.isTrue(yield* restarted.bridge.stopTask(rootId, child.agentId, true));
        const recovered = yield* restarted.claude.nextTurn;
        assert.include(recovered.input.input ?? "", "Continue the migration safely");
        assert.include(
          recovered.input.input ?? "",
          "The migration committed successfully; only validation remains",
        );
        assert.strictEqual(
          (yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId })).agentId,
          child.agentId,
        );
        assert.lengthOf(restarted.claude.deliveries, 1);
      }),
  );

  it.effect(
    "keeps server-owned child startup and work alive after its parent wait is cancelled",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const releaseStart = yield* Deferred.make<void>();
        const spawned = yield* Deferred.make<string>();
        const beginWait = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        h.claude.gates.start = Deferred.await(releaseStart);
        const parent = yield* Effect.gen(function* () {
          const child = yield* h.spawn();
          yield* Deferred.succeed(spawned, child.agentId);
          yield* Deferred.await(beginWait);
          yield* Deferred.succeed(waiting, undefined);
          return yield* h.bridge.wait(h.root, { agentId: child.agentId, timeoutMs: 60_000 });
        }).pipe(Effect.forkChild({ startImmediately: true }));
        const agentId = yield* Deferred.await(spawned);
        const starting = yield* Queue.take(h.claude.starts);
        yield* Deferred.succeed(beginWait, undefined);
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(parent);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(parent)));
        assert.deepEqual(h.claude.interruptions, []);
        yield* Deferred.succeed(releaseStart, undefined);
        yield* joinWorker(starting.worker);
        const delivered = yield* h.claude.nextTurn;
        assert.strictEqual(delivered.input.input, "Do the child assignment");
        yield* h.emit(delivered.input.threadId, {
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "Finished independently" },
        });
        yield* h.complete(delivered.result);
        const state = yield* h.bridge.wait(h.root, { agentId });
        assert.strictEqual(state.status, "completed");
        assert.strictEqual(state.reply, "Finished independently");
      }),
  );

  it.effect("refuses same-provider delegation and advertises the native alternative", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* expectRefused(
        h.bridge.spawn(h.root, { providerInstanceId: codexInstance, prompt: "Delegate" }),
      );
      const targets = yield* h.bridge.targets(h.root);
      assert.deepEqual(
        targets.find((target) => target.providerInstanceId === codexInstance),
        {
          providerInstanceId: codexInstance,
          provider: ProviderDriverKind.make("codex"),
          name: undefined,
          available: false,
          reason: "Use native subagent tools for this provider.",
          delivery: "queued",
          recovery: "durable-agent-id",
        },
      );
      assert.strictEqual(h.codex.sessions.size, 0);
      assert.deepEqual(h.events, []);
    }),
  );

  it.effect(
    "stops only the selected execution by default and uses tree scope only for Stop all",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const parent = yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const nested = yield* h.spawn(
          { providerInstanceId: codexInstance },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        const nestedTurn = yield* h.codex.nextTurn;
        yield* h.bridge.stopTask(rootId, parent.agentId);
        assert.deepEqual(h.claude.interruptions, [[parentTurn.input.threadId]]);
        assert.deepEqual(h.codex.interruptions, []);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: nested.agentId })).status,
          "running",
        );
        yield* h.bridge.stopTree(rootId);
        assert.deepEqual(h.claude.interruptions, [
          [parentTurn.input.threadId],
          [parentTurn.input.threadId],
        ]);
        assert.deepEqual(h.codex.interruptions, [[nestedTurn.input.threadId]]);
        assert.deepEqual(h.claude.stoppedSessions, []);
        assert.deepEqual(h.codex.stoppedSessions, []);
      }),
  );

  it.effect("does not broaden a failed individual stop into session or tree termination", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const child = yield* h.spawn();
      const turn = yield* h.claude.nextTurn;
      const failure = new ProviderAdapterValidationError({
        provider: "claudeAgent",
        operation: "interrupt",
        issue: "Cannot isolate this execution",
      });
      h.claude.gates.interrupt = Effect.fail(failure);
      const stopped = yield* Effect.result(h.bridge.stopTask(rootId, child.agentId));
      assert.strictEqual(stopped._tag, "Failure");
      if (stopped._tag === "Failure") assert.strictEqual(stopped.failure, failure);
      assert.deepEqual(h.claude.interruptions, [[turn.input.threadId]]);
      assert.deepEqual(h.claude.stoppedSessions, []);
      yield* expectRefused(h.bridge.send(h.root, { agentId: child.agentId, prompt: "Do more" }));
    }),
  );

  it.effect(
    "latches manual stop against agent sends and allows only explicit user resume to dispatch again",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* expectRefused(h.bridge.send(h.root, { agentId: child.agentId, prompt: "Continue" }));
        yield* expectRefused(
          h.bridge.send(h.root, { agentId: child.agentId, prompt: "Continue", interrupt: true }),
        );
        yield* expectRefused(
          h.bridge.send(h.caller(turn.input.threadId, claudeInstance), {
            agentId: "parent",
            prompt: "Resume me",
          }),
        );
        yield* expectRefused(
          h.bridge.spawn(h.caller(turn.input.threadId, claudeInstance), {
            providerInstanceId: codexInstance,
            prompt: "Escape stop",
          }),
        );
        assert.strictEqual(h.claude.deliveries.length, 1);
        assert.isTrue((yield* h.bridge.wait(h.root, { agentId: child.agentId })).manuallyStopped);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        const resumed = yield* h.claude.nextTurn;
        assert.strictEqual(resumed.input.threadId, turn.input.threadId);
        assert.include(resumed.input.input ?? "", "Continue the interrupted assignment");
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "running");
        assert.isFalse(state.manuallyStopped);
      }),
  );

  it.effect("rejects cross-root and sibling access even when the caller has a valid session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const first = yield* h.spawn();
      const firstTurn = yield* h.claude.nextTurn;
      const sibling = yield* h.spawn();
      yield* h.claude.nextTurn;
      for (const invocation of [h.otherRoot, h.caller(firstTurn.input.threadId, claudeInstance)]) {
        yield* expectRefused(
          h.bridge.send(invocation, { agentId: sibling.agentId, prompt: "Unauthorized" }),
        );
        yield* expectRefused(h.bridge.wait(invocation, { agentId: sibling.agentId }));
        yield* expectRefused(
          h.bridge.control(invocation, { agentId: sibling.agentId }, "interrupt"),
        );
        yield* expectRefused(h.bridge.control(invocation, { agentId: sibling.agentId }, "close"));
      }
      assert.isFalse(yield* h.bridge.stopTask(otherRootId, first.agentId));
      assert.deepEqual(h.claude.interruptions, []);
      assert.deepEqual(h.claude.stoppedSessions, []);
    }),
  );

  it.effect("deduplicates concurrent spawn request keys and rejects changed arguments", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const release = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      h.gates.publish = (event) =>
        event.type === "task.updated" && event.payload.status === "pending"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void;
      const input = { providerInstanceId: claudeInstance, prompt: "Once", requestKey: "spawn-key" };
      const first = yield* h.bridge
        .spawn(h.root, input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const duplicate = yield* h.bridge
        .spawn(h.root, input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const conflict = yield* Effect.result(
        h.bridge.spawn(h.root, { ...input, prompt: "Different" }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const original = yield* Fiber.join(first).pipe(Effect.flatMap(decodeSnapshot));
      assert.deepEqual(yield* Fiber.join(duplicate).pipe(Effect.flatMap(decodeSnapshot)), original);
      const rejected = yield* Fiber.join(conflict);
      assert.strictEqual(rejected._tag, "Failure");
      if (rejected._tag === "Failure") assert.instanceOf(rejected.failure, ProviderValidationError);
      yield* h.claude.nextTurn;
      assert.strictEqual(h.claude.sessions.size, 1);
      assert.strictEqual(h.claude.deliveries.length, 1);
    }),
  );

  it.effect(
    "retains parent messages while main is stopped until delivery IDs are explicitly confirmed",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const caller = h.caller(turn.input.threadId, claudeInstance);
        h.stoppedRoots.add(rootId);
        const input = {
          agentId: "parent",
          prompt: "Finished the assignment",
          requestKey: "parent-message",
        };
        const accepted = yield* h.bridge.send(caller, input);
        assert.deepEqual(yield* h.bridge.send(caller, input), accepted);
        const firstBatch = h.bridge.rootMessages(rootId);
        assert.lengthOf(firstBatch, 1);
        assert.include(firstBatch[0]?.prompt ?? "", "Finished the assignment");
        assert.deepEqual(h.bridge.rootMessages(otherRootId), []);
        assert.deepEqual(h.codex.deliveries, []);
        yield* h.bridge.send(caller, { agentId: "parent", prompt: "One more detail" });
        h.bridge.confirmRootMessages(
          rootId,
          firstBatch.map((message) => message.id),
        );
        const remaining = h.bridge.rootMessages(rootId);
        assert.lengthOf(remaining, 1);
        assert.include(remaining[0]?.prompt ?? "", "One more detail");
        h.bridge.confirmRootMessages(
          rootId,
          remaining.map((message) => message.id),
        );
        assert.deepEqual(h.bridge.rootMessages(rootId), []);
        assert.deepEqual(h.codex.deliveries, []);
      }),
  );

  it.effect(
    "deduplicates concurrent sends and actually delivers the queued message after the current turn",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const firstTurn = yield* h.claude.nextTurn;
        const input = {
          agentId: child.agentId,
          prompt: "Second assignment",
          requestKey: "send-key",
        };
        const [first, duplicate, conflict] = yield* Effect.all(
          [
            h.bridge.send(h.root, input),
            h.bridge.send(h.root, input),
            Effect.result(h.bridge.send(h.root, { ...input, prompt: "Conflicting assignment" })),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(first, duplicate);
        assert.strictEqual(conflict._tag, "Failure");
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
          1,
        );
        assert.deepEqual(
          h.claude.deliveries.map((input) => input.input),
          ["Do the child assignment"],
        );
        yield* h.complete(firstTurn.result);
        const secondTurn = yield* h.claude.nextTurn;
        assert.strictEqual(secondTurn.input.input, "Second assignment");
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
          0,
        );
        assert.strictEqual(h.claude.deliveries.length, 2);
      }),
  );

  it.effect(
    "projects root and native identities without collisions and routes native task stop to original IDs",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "content.delta",
          itemId: "message-1",
          payload: { streamKind: "assistant_text", delta: "Child text" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "content.delta",
          itemId: "message-1",
          payload: { streamKind: "assistant_text", delta: "Native text", agentId: "native-1" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native-1", taskType: "local_agent", title: "Native child" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native-2", taskType: "local_agent", parentAgentId: "native-1" },
        });
        const content = h.events.filter((event) => event.type === "content.delta");
        assert.deepEqual(
          content.map((event) => ({
            threadId: event.threadId,
            bridgeAgentId: event.bridgeAgentId,
            turnId: event.turnId,
            itemId: event.itemId,
            agentId: event.payload.agentId,
          })),
          [
            {
              threadId: rootId,
              bridgeAgentId: child.agentId,
              turnId: undefined,
              itemId: RuntimeItemId.make(`${child.agentId}:0:message-1`),
              agentId: child.agentId,
            },
            {
              threadId: rootId,
              bridgeAgentId: child.agentId,
              turnId: undefined,
              itemId: RuntimeItemId.make(`${child.agentId}:native:native-1:message-1`),
              agentId: `${child.agentId}:native:native-1`,
            },
          ],
        );
        const tasks = h.events.filter((event) => event.type === "task.started");
        assert.deepEqual(
          tasks.map((event) => ({
            taskId: event.payload.taskId,
            parent: event.payload.parentAgentId,
            owner: event.payload.executionOwner,
          })),
          [
            {
              taskId: RuntimeTaskId.make(`${child.agentId}:native:native-1`),
              parent: child.agentId,
              owner: "cross-provider",
            },
            {
              taskId: RuntimeTaskId.make(`${child.agentId}:native:native-2`),
              parent: `${child.agentId}:native:native-1`,
              owner: "cross-provider",
            },
          ],
        );
        assert.isTrue(yield* h.bridge.stopTask(rootId, `${child.agentId}:native:native-2`));
        assert.deepEqual(h.claude.stoppedTasks, [
          { threadId: turn.input.threadId, taskId: "native-2" },
        ]);
      }),
  );

  it.effect(
    "routes approvals and blocking questions to the original hidden session and native request IDs",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "request.opened",
          requestId: "approval-1",
          payload: { requestType: "command_execution_approval", agentId: "native-1" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "question-1",
          payload: { questions: [] },
        });
        const approvalId = `${child.agentId}:0:request:approval-1`;
        const questionId = `${child.agentId}:0:request:question-1`;
        assert.isFalse(yield* h.bridge.respond(otherRootId, approvalId, { decision: "accept" }));
        assert.deepEqual(h.claude.approvals, []);
        assert.isTrue(yield* h.bridge.respond(rootId, approvalId, { decision: "accept" }));
        assert.isTrue(yield* h.bridge.respond(rootId, questionId, { answers: { choice: "yes" } }));
        assert.deepEqual(h.claude.approvals, [
          [turn.input.threadId, ApprovalRequestId.make("approval-1"), "accept"],
        ]);
        assert.deepEqual(h.claude.answers, [
          [turn.input.threadId, ApprovalRequestId.make("question-1"), { choice: "yes" }],
        ]);
        yield* h.emit(turn.input.threadId, {
          type: "request.resolved",
          requestId: "approval-1",
          payload: {
            requestType: "command_execution_approval",
            decision: "accept",
            agentId: "native-1",
          },
        });
        yield* h.emit(turn.input.threadId, {
          type: "user-input.resolved",
          requestId: "question-1",
          payload: { answers: { choice: "yes" } },
        });
        assert.deepEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          [],
        );
      }),
  );

  it.effect(
    "keeps a queued asynchronous answer pending until the adapter actually accepts delivery",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "async-1",
          payload: { questions: [], responseMode: "message" },
        });
        const requestId = `${child.agentId}:0:request:async-1`;
        const releaseDelivery = yield* Deferred.make<void>();
        h.claude.gates.send = Deferred.await(releaseDelivery);
        assert.isTrue(yield* h.bridge.respond(rootId, requestId, { answers: { choice: "ship" } }));
        yield* expectRefused(
          h.bridge.respond(rootId, requestId, { answers: { choice: "duplicate" } }),
        );
        assert.include(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          requestId,
        );
        assert.lengthOf(
          h.events.filter((event) => event.type === "user-input.resolved"),
          0,
        );
        assert.lengthOf(h.claude.deliveries, 1);
        yield* h.complete(turn.result);
        const delivering = yield* Queue.take(h.claude.sends);
        assert.include(delivering.input.input ?? "", '"choice":"ship"');
        assert.include(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          requestId,
        );
        assert.lengthOf(
          h.events.filter((event) => event.type === "user-input.resolved"),
          0,
        );
        yield* Deferred.succeed(releaseDelivery, undefined);
        yield* joinWorker(delivering.worker);
        assert.deepEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          [],
        );
        const resolved = h.events.filter((event) => event.type === "user-input.resolved");
        assert.lengthOf(resolved, 1);
        assert.strictEqual(resolved[0]?.requestId, requestId);
        assert.deepEqual(resolved[0]?.payload.answers, { choice: "ship" });
        assert.deepEqual(h.claude.answers, []);
      }),
  );

  it.effect(
    "cancels stale requests and queued answers on stop without delivering them on resume",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "stale-question",
          payload: { questions: [], responseMode: "message" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "request.opened",
          requestId: "stale-approval",
          payload: { requestType: "command_execution_approval" },
        });
        const questionId = `${child.agentId}:0:request:stale-question`;
        const approvalId = `${child.agentId}:0:request:stale-approval`;
        yield* h.bridge.respond(rootId, questionId, { answers: { choice: "stale answer" } });
        yield* h.bridge.stopTask(rootId, child.agentId);
        assert.isFalse(
          yield* h.bridge.respond(rootId, questionId, { answers: { choice: "late answer" } }),
        );
        assert.isFalse(yield* h.bridge.respond(rootId, approvalId, { decision: "accept" }));
        const cancelled = h.events.filter((event) => event.type === "user-input.resolved");
        assert.lengthOf(cancelled, 1);
        assert.isTrue(cancelled[0]?.payload.cancelled);
        assert.strictEqual(
          h.events.find((event) => event.type === "request.resolved")?.payload.decision,
          "cancel",
        );
        yield* h.bridge.stopTask(rootId, child.agentId, true);
        yield* h.claude.nextTurn;
        assert.lengthOf(h.claude.deliveries, 2);
        assert.isFalse(h.claude.deliveries.some((input) => input.input?.includes("stale answer")));
        assert.deepEqual(h.claude.approvals, []);
        assert.deepEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          [],
        );
      }),
  );

  it.effect(
    "continues publishing native descendants and their questions after the bridge parent is stopped",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native-1", taskType: "local_agent" },
        });
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* h.emit(turn.input.threadId, {
          type: "task.updated",
          payload: { taskId: "native-1", status: "running" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "Still working", agentId: "native-1" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "request.opened",
          requestId: "native-approval",
          payload: { requestType: "command_execution_approval", agentId: "native-1" },
        });
        const approval = h.events.find((event) => event.type === "request.opened");
        assert.isDefined(approval?.requestId);
        assert.isTrue(
          yield* h.bridge.respond(rootId, approval?.requestId ?? "missing", { decision: "accept" }),
        );
        yield* h.emit(turn.input.threadId, {
          type: "task.completed",
          payload: { taskId: "native-1", status: "stopped" },
        });
        assert.isTrue(
          h.events.some(
            (event) =>
              event.type === "content.delta" &&
              event.payload.agentId === `${child.agentId}:native:native-1`,
          ),
        );
        assert.isTrue(
          h.events.some(
            (event) =>
              event.type === "task.completed" &&
              event.payload.taskId === `${child.agentId}:native:native-1` &&
              event.payload.status === "stopped",
          ),
        );
        assert.isTrue((yield* h.bridge.wait(h.root, { agentId: child.agentId })).manuallyStopped);
      }),
  );

  it.effect.each(["prepare", "start"] as const)(
    "does not send user work when stopped during %s",
    (phase) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const release = yield* Deferred.make<void>();
        const gate = Effect.withFiber((worker) =>
          Deferred.succeed(entered, worker).pipe(Effect.andThen(Deferred.await(release))),
        );
        if (phase === "prepare") h.gates.prepare = gate;
        else h.claude.gates.start = gate;
        const child = yield* h.spawn();
        const worker = yield* Deferred.await(entered);
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* Deferred.succeed(release, undefined);
        yield* joinWorker(worker);
        assert.deepEqual(h.claude.deliveries, []);
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "interrupted");
        assert.isTrue(state.manuallyStopped);
      }),
  );

  it.effect("does not send user work when delayed startup completes after Stop all", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const releaseStart = yield* Deferred.make<void>();
      h.claude.gates.start = Deferred.await(releaseStart);
      const child = yield* h.spawn();
      const starting = yield* Queue.take(h.claude.starts);
      yield* h.bridge.stopTree(rootId);
      yield* Deferred.succeed(releaseStart, undefined);
      yield* joinWorker(starting.worker);
      assert.deepEqual(h.claude.deliveries, []);
      assert.deepEqual(h.codex.deliveries, []);
      const lastTask = h.events
        .filter((event) => event.type === "task.updated")
        .findLast((event) => event.payload.taskId === child.agentId);
      assert.strictEqual(lastTask?.payload.status, "interrupted");
      yield* expectRefused(
        h.bridge.send(h.root, { agentId: child.agentId, prompt: "Restart behind the stop" }),
      );
    }),
  );

  it.effect(
    "Stop all attempts other agents after an adapter failure and reports the original failure",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const parent = yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const nested = yield* h.spawn(
          { providerInstanceId: codexInstance },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        const nestedTurn = yield* h.codex.nextTurn;
        const failure = new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "interrupt",
          issue: "Cannot confirm tree termination",
        });
        h.claude.gates.interrupt = Effect.fail(failure);
        const result = yield* Effect.result(h.bridge.stopTree(rootId));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, ProviderValidationError);
          assert.include(result.failure.issue, "Cannot confirm tree termination");
        }
        assert.deepEqual(h.claude.interruptions, [[parentTurn.input.threadId]]);
        assert.deepEqual(h.codex.interruptions, [[nestedTurn.input.threadId]]);
        const failedTask = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === parent.agentId);
        assert.include(failedTask?.payload.error ?? "", "Could not confirm Stop all");
        const stoppedTask = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === nested.agentId);
        assert.strictEqual(stoppedTask?.payload.status, "interrupted");
        yield* expectRefused(
          h.bridge.send(h.root, { agentId: parent.agentId, prompt: "Keep running" }),
        );
        yield* expectRefused(
          h.bridge.send(h.root, { agentId: nested.agentId, prompt: "Keep running" }),
        );
        assert.lengthOf(h.claude.deliveries, 1);
        assert.lengthOf(h.codex.deliveries, 1);
        assert.deepEqual(h.claude.stoppedSessions, []);
        assert.deepEqual(h.codex.stoppedSessions, []);
      }),
  );

  it.effect.each([true, false])(
    "delivers to an active Codex child according to supportsInputSteering=%s",
    (supportsInputSteering) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.codex.capabilities.supportsInputSteering = supportsInputSteering;
        yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const child = yield* h.spawn(
          { providerInstanceId: codexInstance },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        const turn = yield* h.codex.nextTurn;
        const releaseDelivery = yield* Deferred.make<void>();
        h.codex.gates.send = Deferred.await(releaseDelivery);
        const sender = yield* h.bridge
          .send(h.root, {
            agentId: child.agentId,
            prompt: "Use the latest requirement",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        if (!supportsInputSteering) {
          yield* Fiber.join(sender);
          assert.strictEqual(
            (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
            1,
          );
          assert.lengthOf(h.codex.deliveries, 1);
          yield* h.complete(turn.result, h.codex.adapter);
        }
        const delivering = yield* Queue.take(h.codex.sends);
        assert.strictEqual(delivering.input.input, "Use the latest requirement");
        assert.lengthOf(h.codex.deliveries, 1);
        yield* Deferred.succeed(releaseDelivery, undefined);
        yield* joinWorker(delivering.worker);
        yield* Fiber.join(sender);
        assert.deepEqual(
          h.codex.deliveries.map((input) => input.input),
          ["Do the child assignment", "Use the latest requirement"],
        );
        assert.deepEqual(h.codex.interruptions, []);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).queuedMessages,
          0,
        );
      }),
  );

  it.effect(
    "individual stop reaches the child's own session while its native descendants run",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const latest = () =>
          h.events
            .filter((event) => event.type === "task.updated")
            .findLast((event) => event.payload.taskId === child.agentId);
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native-1", taskType: "local_agent", agentKind: "agent" },
        });
        // A child's native descendants belong to its session; they stop with
        // it through the adapter's ordinary interrupt, so the control stays on.
        assert.strictEqual(latest()?.payload.canStop, true);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId));
        assert.deepEqual(h.claude.interruptions, [[turn.input.threadId]]);
        assert.deepEqual(h.claude.stoppedSessions, []);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).status,
          "interrupted",
        );
      }),
  );

  it.effect(
    "advertises explicit resume for completed, interrupted, and closed agents but not active agents",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const latest = () =>
          h.events
            .filter((event) => event.type === "task.updated")
            .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(latest()?.payload.canResume, false);
        yield* h.complete(turn.result);
        assert.strictEqual(latest()?.payload.canResume, true);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        yield* h.claude.nextTurn;
        assert.strictEqual(latest()?.payload.canResume, false);
        yield* h.bridge.stopTask(rootId, child.agentId);
        assert.strictEqual(latest()?.payload.canResume, true);
        yield* h.bridge.stopTask(rootId, child.agentId, true);
        yield* h.claude.nextTurn;
        assert.strictEqual(latest()?.payload.canResume, false);
        yield* h.bridge.control(h.root, { agentId: child.agentId }, "close");
        assert.strictEqual(latest()?.payload.canResume, true);
        assert.strictEqual((yield* h.bridge.wait(h.root, { agentId: child.agentId })).closed, true);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        yield* h.claude.nextTurn;
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).closed,
          false,
        );
      }),
  );

  it.effect.each(["complete", "stop"] as const)(
    "keeps native turn segments open when the wrapper lifecycle is %s",
    (lifecycle) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const nativeTurn = TurnId.make("independent-native-turn");
        yield* h.emit(turn.input.threadId, {
          type: "content.delta",
          turnId: turn.result.turnId,
          itemId: "wrapper-message",
          payload: { streamKind: "assistant_text", delta: "Wrapper result" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "content.delta",
          turnId: nativeTurn,
          itemId: "native-message",
          payload: {
            streamKind: "assistant_text",
            delta: "Native still working",
            agentId: "native-1",
          },
        });
        const nativeContent = h.events
          .filter((event) => event.type === "content.delta")
          .find((event) => event.payload.agentId === `${child.agentId}:native:native-1`);
        assert.isDefined(nativeContent);
        assert.strictEqual(nativeContent?.threadId, rootId);
        assert.strictEqual(nativeContent?.turnId, undefined);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).reply,
          "Wrapper result",
        );
        if (lifecycle === "complete") yield* h.complete(turn.result);
        else yield* h.bridge.stopTask(rootId, child.agentId);
        const completed = h.events.filter(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        );
        assert.lengthOf(completed, 1);
        assert.strictEqual(
          completed[0]?.itemId,
          RuntimeItemId.make(`${child.agentId}:0:wrapper-message`),
        );
        yield* h.emit(turn.input.threadId, {
          type: "item.completed",
          turnId: nativeTurn,
          itemId: "native-message",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "Native result",
            agentId: "native-1",
          },
        });
        const nativeCompletion = h.events
          .filter((event) => event.type === "item.completed")
          .find((event) => event.payload.agentId === `${child.agentId}:native:native-1`);
        assert.isDefined(nativeCompletion);
        assert.strictEqual(nativeCompletion?.itemId, nativeContent?.itemId);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).reply,
          "Wrapper result",
        );
      }),
  );

  it.effect(
    "resolves native request aliases after wrapper stop and resume increment the generation",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const nativeTurn = TurnId.make("native-request-turn");
        yield* h.emit(turn.input.threadId, {
          type: "request.opened",
          turnId: nativeTurn,
          requestId: "approval-original",
          payload: { requestType: "command_execution_approval", agentId: "native-1" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          turnId: nativeTurn,
          requestId: "question-original",
          payload: { questions: [], agentId: "native-1" },
        });
        const approvalId = RuntimeRequestId.make(`${child.agentId}:0:request:approval-original`);
        const questionId = RuntimeRequestId.make(`${child.agentId}:0:request:question-original`);
        yield* h.bridge.stopTask(rootId, child.agentId);
        assert.deepEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          [approvalId, questionId],
        );
        yield* h.bridge.stopTask(rootId, child.agentId, true);
        yield* h.claude.nextTurn;
        assert.isTrue(yield* h.bridge.respond(rootId, approvalId, { decision: "accept" }));
        assert.isTrue(
          yield* h.bridge.respond(rootId, questionId, { answers: { choice: "proceed" } }),
        );
        assert.deepEqual(h.claude.approvals, [
          [turn.input.threadId, ApprovalRequestId.make("approval-original"), "accept"],
        ]);
        assert.deepEqual(h.claude.answers, [
          [turn.input.threadId, ApprovalRequestId.make("question-original"), { choice: "proceed" }],
        ]);
        yield* h.emit(turn.input.threadId, {
          type: "request.resolved",
          turnId: nativeTurn,
          requestId: "approval-original",
          payload: {
            requestType: "command_execution_approval",
            decision: "accept",
            agentId: "native-1",
          },
        });
        yield* h.emit(turn.input.threadId, {
          type: "user-input.resolved",
          turnId: nativeTurn,
          requestId: "question-original",
          payload: { answers: { choice: "proceed" }, agentId: "native-1" },
        });
        assert.deepEqual(
          h.events
            .filter(
              (event) => event.type === "request.resolved" || event.type === "user-input.resolved",
            )
            .map((event) => event.requestId),
          [approvalId, questionId],
        );
        assert.deepEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          [],
        );
      }),
  );

  it.effect.each(["streaming", "nonstreaming"] as const)(
    "keeps %s wrapper replies separate and publishes usage without synthesizing a parent reply",
    (mode) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        if (mode === "streaming") {
          yield* h.emit(turn.input.threadId, {
            type: "content.delta",
            itemId: "wrapper-answer",
            payload: { streamKind: "assistant_text", delta: "Wrapper answer" },
          });
        } else {
          yield* h.emit(turn.input.threadId, {
            type: "item.completed",
            itemId: "wrapper-answer",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              detail: "Wrapper answer",
            },
          });
        }
        yield* h.emit(turn.input.threadId, {
          type: "content.delta",
          itemId: "native-answer",
          turnId: TurnId.make("native-answer-turn"),
          payload: {
            streamKind: "assistant_text",
            delta: "Private native reasoning",
            agentId: "native-1",
          },
        });
        yield* h.emit(turn.input.threadId, {
          type: "item.completed",
          itemId: "native-answer",
          turnId: TurnId.make("native-answer-turn"),
          payload: {
            itemType: "assistant_message",
            detail: "Native answer",
            status: "completed",
            agentId: "native-1",
          },
        });
        const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
        yield* h.emit(turn.input.threadId, {
          type: "turn.completed",
          turnId: turn.result.turnId,
          payload: { state: "completed", usage },
        });
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.reply, "Wrapper answer");
        assert.strictEqual(state.status, "completed");
        const completion = h.events
          .filter((event) => event.type === "task.completed")
          .find((event) => event.payload.taskId === child.agentId);
        assert.isDefined(completion);
        assert.strictEqual(completion?.threadId, rootId);
        assert.strictEqual(completion?.bridgeAgentId, child.agentId);
        assert.strictEqual(completion?.payload.status, "completed");
        assert.isUndefined(completion?.payload.summary);
        assert.deepEqual(completion?.payload.usage, usage);
        const update = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(update?.payload.status, "completed");
      }),
  );

  it.effect("Stop all fences every child before awaiting the first adapter stop", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.spawn();
      const parentTurn = yield* h.claude.nextTurn;
      const releaseStart = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      h.codex.gates.start = Deferred.await(releaseStart);
      yield* h.spawn(
        { providerInstanceId: codexInstance },
        h.caller(parentTurn.input.threadId, claudeInstance),
      );
      const starting = yield* Queue.take(h.codex.starts);
      h.claude.gates.interrupt = Deferred.succeed(stopping, undefined).pipe(
        Effect.andThen(Deferred.await(releaseStop)),
      );
      const stop = yield* h.bridge
        .stopTree(rootId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(stopping);
      yield* Deferred.succeed(releaseStart, undefined);
      yield* joinWorker(starting.worker);
      const dispatchedWhileStopping = h.codex.deliveries.slice();
      yield* Deferred.succeed(releaseStop, undefined);
      yield* Fiber.join(stop);
      assert.deepEqual(dispatchedWhileStopping, []);
      assert.deepEqual(h.codex.deliveries, []);
    }),
  );

  it.effect("bounds a hung Stop all adapter call and still attempts the remaining children", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.spawn();
      const parentTurn = yield* h.claude.nextTurn;
      yield* h.spawn(
        { providerInstanceId: codexInstance },
        h.caller(parentTurn.input.threadId, claudeInstance),
      );
      const childTurn = yield* h.codex.nextTurn;
      const entered = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      h.claude.gates.interrupt = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const stopping = yield* Effect.result(h.bridge.stopTree(rootId)).pipe(
        Effect.tap(() => Deferred.succeed(finished, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(60_000);
      assert.isTrue(
        yield* Deferred.isDone(finished),
        "Stop all must settle within 60 seconds of virtual time",
      );
      const result = yield* Fiber.join(stopping);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(h.codex.interruptions, [[childTurn.input.threadId]]);
      assert.deepEqual(h.claude.stoppedSessions, []);
    }),
  );

  it.effect(
    "a timed-out individual stop clears the stopping latch so a later stop can succeed",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        const entered = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        h.claude.gates.interrupt = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
        );
        const stopping = yield* Effect.result(h.bridge.stopTask(rootId, child.agentId)).pipe(
          Effect.tap(() => Deferred.succeed(finished, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(60_000);
        assert.isTrue(
          yield* Deferred.isDone(finished),
          "Individual stop must settle within 60 seconds of virtual time",
        );
        assert.strictEqual((yield* Fiber.join(stopping))._tag, "Failure");
        h.claude.gates.interrupt = Effect.void;
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId));
        assert.deepEqual(h.claude.interruptions, [[turn.input.threadId], [turn.input.threadId]]);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).status,
          "interrupted",
        );
      }),
  );

  it.effect("failed disposal retains open capacity and retries all surviving sessions", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const children: string[] = [];
      for (let index = 0; index < 8; index++) {
        const child = yield* h.spawn({ prompt: `Assignment ${index}` });
        children.push(child.agentId);
        yield* h.claude.nextTurn;
      }
      h.claude.gates.stopSession = Effect.fail(
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "stopSession",
          issue: "The process is still alive",
        }),
      );
      const disposal = yield* Effect.result(h.bridge.disposeTree(rootId));
      assert.strictEqual(disposal._tag, "Failure");
      h.bridge.releaseRootStop(rootId);
      const states = yield* Effect.forEach(children, (agentId) => h.recovery.load(agentId));
      assert.isTrue(
        states.every((state) => state !== undefined && !state.closed && state.deleted),
        "A failed native stop must not free its bridge slot",
      );
      assert.deepEqual(h.cleared, []);
      for (let rootIndex = 0; rootIndex < 3; rootIndex++) {
        const caller = h.register(ThreadId.make(`capacity-root-${rootIndex}`), codexInstance);
        for (let index = 0; index < 8; index++) {
          yield* h.spawn({ prompt: `Other live root assignment ${index}` }, caller);
          yield* h.claude.nextTurn;
        }
      }
      const liveRoot = h.register(ThreadId.make("capacity-new-root"), codexInstance);
      const capacity = yield* Effect.result(h.spawn({}, liveRoot));
      assert.strictEqual(capacity._tag, "Failure");
      if (capacity._tag === "Failure") {
        assert.strictEqual(capacity.failure._tag, "ProviderValidationError");
        if (capacity.failure._tag === "ProviderValidationError")
          assert.include(capacity.failure.issue, "capacity");
      }
      h.claude.gates.stopSession = Effect.void;
      yield* h.bridge.disposeTree(rootId);
      assert.lengthOf(h.claude.stoppedSessions, 16);
      assert.strictEqual(h.claude.sessions.size, 24);
      h.bridge.releaseRootStop(rootId);
      yield* expectRefused(h.spawn({ prompt: "Deleted roots must not reopen" }));
      yield* expectRefused(h.bridge.stopTask(rootId, children[0]!, true));
      yield* h.spawn({ prompt: "A new assignment after confirmed disposal" }, liveRoot);
      yield* h.claude.nextTurn;
      assert.strictEqual(h.claude.sessions.size, 25);
      yield* h.crash;
      const restarted = yield* makeHarness(h.records);
      assert.isFalse(yield* restarted.bridge.stopTask(rootId, children[0]!, true));
      assert.deepEqual(restarted.claude.deliveries, []);
      assert.strictEqual(yield* Queue.size(restarted.claude.starts), 0);
    }),
  );

  it.effect(
    "rejects unsupported native message answers without sending work to the wrapper or resolving the question",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "native-message-question",
          payload: { questions: [], responseMode: "message", agentId: "native-1" },
        });
        const requestId = `${child.agentId}:0:request:native-message-question`;
        yield* expectRefused(
          h.bridge.respond(rootId, requestId, { answers: { answer: "Only for the native child" } }),
        );
        assert.lengthOf(h.claude.deliveries, 1);
        assert.deepEqual(h.claude.answers, []);
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.queuedMessages, 0);
        assert.include(state.pendingRequests, requestId);
        assert.deepEqual(
          h.events.filter((event) => event.type === "user-input.resolved"),
          [],
        );
      }),
  );

  it.effect.each(["interrupted", "completed"] as const)(
    "native blocking questions and their resolutions do not revive a %s wrapper",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        if (status === "interrupted") yield* h.bridge.stopTask(rootId, child.agentId);
        else yield* h.complete(turn.result);
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          turnId: TurnId.make("native-question-turn"),
          requestId: "native-blocking",
          payload: { questions: [], agentId: "native-1" },
        });
        const whilePending = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        yield* h.emit(turn.input.threadId, {
          type: "user-input.resolved",
          turnId: TurnId.make("native-question-turn"),
          requestId: "native-blocking",
          payload: { answers: { answer: "yes" }, agentId: "native-1" },
        });
        const afterResolution = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(whilePending.status, status);
        assert.strictEqual(afterResolution.status, status);
        assert.deepEqual(afterResolution.pendingRequests, []);
        assert.lengthOf(h.claude.deliveries, 1);
      }),
  );

  it.effect.each(["running", "interrupted"] as const)(
    "session exit cleans up native requests and segments for a %s wrapper while independent bridge descendants survive",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const parent = yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const grandchild = yield* h.spawn(
          { providerInstanceId: codexInstance },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        yield* h.codex.nextTurn;
        yield* h.emit(parentTurn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native-1", taskType: "local_agent", agentKind: "agent" },
        });
        yield* h.emit(parentTurn.input.threadId, {
          type: "content.delta",
          itemId: "live-native-segment",
          payload: {
            streamKind: "assistant_text",
            delta: "Unfinished native output",
            agentId: "native-1",
          },
        });
        yield* h.emit(parentTurn.input.threadId, {
          type: "request.opened",
          requestId: "native-approval",
          payload: { requestType: "command_execution_approval", agentId: "native-1" },
        });
        yield* h.emit(parentTurn.input.threadId, {
          type: "user-input.requested",
          requestId: "native-question",
          payload: { questions: [], agentId: "native-1" },
        });
        if (status === "interrupted") yield* h.bridge.stopTask(rootId, parent.agentId);
        yield* h.emit(parentTurn.input.threadId, {
          type: "session.exited",
          payload: { reason: "Provider process exited", recoverable: false },
        });
        const state = yield* h.bridge.wait(h.root, { agentId: parent.agentId });
        assert.deepEqual(state.pendingRequests, []);
        const resolvedApproval = h.events
          .filter((event) => event.type === "request.resolved")
          .find((event) => event.requestId === `${parent.agentId}:0:request:native-approval`);
        assert.strictEqual(resolvedApproval?.payload.decision, "cancel");
        const resolvedQuestion = h.events
          .filter((event) => event.type === "user-input.resolved")
          .find((event) => event.requestId === `${parent.agentId}:0:request:native-question`);
        assert.strictEqual(resolvedQuestion?.payload.cancelled, true);
        const segment = h.events
          .filter((event) => event.type === "item.completed")
          .find(
            (event) => event.itemId === `${parent.agentId}:native:native-1:live-native-segment`,
          );
        assert.strictEqual(segment?.payload.status, "completed");
        const nativeTerminal = h.events
          .filter((event) => event.type === "task.updated" || event.type === "task.completed")
          .findLast((event) => event.payload.taskId === `${parent.agentId}:native:native-1`);
        assert.include(["stopped", "interrupted", "cancelled"], nativeTerminal?.payload.status);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: grandchild.agentId })).status,
          "running",
        );
        assert.deepEqual(h.codex.interruptions, []);
        assert.deepEqual(h.codex.stoppedSessions, []);
        assert.strictEqual(h.codex.sessions.size, 1);
      }),
  );

  it.effect(
    "rejects a duplicate asynchronous answer while the original has left the queue but sendTurn is blocked",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "in-flight-answer",
          payload: { questions: [], responseMode: "message" },
        });
        const requestId = `${child.agentId}:0:request:in-flight-answer`;
        const release = yield* Deferred.make<void>();
        h.claude.gates.send = Deferred.await(release);
        yield* h.bridge.respond(rootId, requestId, { answers: { answer: "original" } });
        yield* h.complete(turn.result);
        const delivering = yield* Queue.take(h.claude.sends);
        const duplicate = yield* Effect.result(
          h.bridge.respond(rootId, requestId, { answers: { answer: "duplicate" } }),
        );
        const queuedDuringDelivery = (yield* h.bridge.wait(h.root, { agentId: child.agentId }))
          .queuedMessages;
        const resolvedBeforeDelivery = h.events.filter(
          (event) => event.type === "user-input.resolved",
        );
        yield* Deferred.succeed(release, undefined);
        yield* joinWorker(delivering.worker);
        assert.strictEqual(duplicate._tag, "Failure");
        assert.strictEqual(queuedDuringDelivery, 0);
        assert.deepEqual(resolvedBeforeDelivery, []);
        assert.lengthOf(h.claude.deliveries, 2);
        const resolved = h.events.filter((event) => event.type === "user-input.resolved");
        assert.lengthOf(resolved, 1);
        assert.deepEqual(resolved[0]?.payload.answers, { answer: "original" });
      }),
  );

  it.effect("a blocked provider send does not serialize spawning in an unrelated root", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.codex.capabilities.supportsInputSteering = true;
      yield* h.spawn();
      const parentTurn = yield* h.claude.nextTurn;
      const child = yield* h.spawn(
        { providerInstanceId: codexInstance },
        h.caller(parentTurn.input.threadId, claudeInstance),
      );
      yield* h.codex.nextTurn;
      const release = yield* Deferred.make<void>();
      h.codex.gates.send = Deferred.await(release);
      const sender = yield* h.bridge
        .send(h.root, {
          agentId: child.agentId,
          prompt: "A blocked steering message",
          requestKey: "blocked-steering",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const delivering = yield* Queue.take(h.codex.sends);
      const spawned = yield* Deferred.make<void>();
      const unrelated = yield* h.spawn({ prompt: "Independent root work" }, h.otherRoot).pipe(
        Effect.tap(() => Deferred.succeed(spawned, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(0);
      const finishedBeforeSend = yield* Deferred.isDone(spawned);
      yield* Deferred.succeed(release, undefined);
      yield* joinWorker(delivering.worker);
      yield* Fiber.join(sender);
      yield* Fiber.join(unrelated);
      const unrelatedTurn = yield* h.claude.nextTurn;
      assert.isTrue(finishedBeforeSend, "Unrelated roots must not wait for another provider's IO");
      assert.strictEqual(h.bridge.rootFor(unrelatedTurn.input.threadId), otherRootId);
    }),
  );

  it.effect(
    "Codex user-item echoes are deduplicated while repeated explicit instructions and native prompts remain visible",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const prompt = "Repeat this explicit assignment";
        const child = yield* h.spawn(
          { providerInstanceId: codexInstance, prompt },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        const firstTurn = yield* h.codex.nextTurn;
        for (const type of ["item.started", "item.completed"] as const) {
          yield* h.emit(
            firstTurn.input.threadId,
            {
              type,
              itemId: "native-user-echo-1",
              payload: { itemType: "user_message", detail: prompt, status: "completed" },
            },
            h.codex.adapter,
          );
        }
        yield* h.complete(firstTurn.result, h.codex.adapter);
        yield* h.bridge.send(h.root, { agentId: child.agentId, prompt });
        const secondTurn = yield* h.codex.nextTurn;
        for (const type of ["item.started", "item.completed"] as const) {
          yield* h.emit(
            secondTurn.input.threadId,
            {
              type,
              itemId: "native-user-echo-2",
              payload: { itemType: "user_message", detail: prompt, status: "completed" },
            },
            h.codex.adapter,
          );
        }
        yield* h.emit(
          secondTurn.input.threadId,
          {
            type: "item.completed",
            itemId: "native-user-echo-1",
            payload: {
              itemType: "user_message",
              detail: prompt,
              status: "completed",
              agentId: "native-1",
            },
          },
          h.codex.adapter,
        );
        const messages = h.events
          .filter((event) => event.type === "item.completed")
          .filter(
            (event) =>
              event.payload.itemType === "user_message" && event.bridgeAgentId === child.agentId,
          );
        assert.deepEqual(
          messages.map((event) => ({ agentId: event.payload.agentId, text: event.payload.detail })),
          [
            { agentId: child.agentId, text: prompt },
            { agentId: child.agentId, text: prompt },
            { agentId: `${child.agentId}:native:native-1`, text: prompt },
          ],
        );
        assert.strictEqual(new Set(messages.map((event) => event.itemId)).size, 3);
        assert.lengthOf(h.codex.deliveries, 2);
      }),
  );

  it.effect.each([true, false])(
    "touches hidden session authorization before every dispatch with steering=%s",
    (steering) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.claude.capabilities.supportsInputSteering = steering;
        h.claude.gates.send = Effect.sync(() => {
          assert.strictEqual(h.touches.length, h.claude.deliveries.length + 1);
        });
        const child = yield* h.spawn();
        const firstTurn = yield* h.claude.nextTurn;
        assert.deepEqual(h.touches, [firstTurn.input.threadId]);
        const sender = yield* h.bridge
          .send(h.root, { agentId: child.agentId, prompt: "Next assignment" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(sender);
        if (!steering) {
          assert.lengthOf(h.touches, 1);
          yield* h.complete(firstTurn.result);
        }
        yield* h.claude.nextTurn;
        assert.deepEqual(h.touches, [firstTurn.input.threadId, firstTurn.input.threadId]);
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* h.bridge.stopTask(rootId, child.agentId, true);
        yield* h.claude.nextTurn;
        assert.deepEqual(h.touches, [
          firstTurn.input.threadId,
          firstTurn.input.threadId,
          firstTurn.input.threadId,
        ]);
      }),
  );

  it.effect(
    "preserves a nested native task's own identity and immediate parent through thin updates and session exit",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native1", taskType: "local_agent", agentKind: "agent" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: {
            taskId: "native2",
            taskType: "local_agent",
            agentKind: "agent",
            parentAgentId: "native1",
          },
        });
        const taskId = RuntimeTaskId.make(`${child.agentId}:native:native2`);
        const parentAgentId = `${child.agentId}:native:native1`;
        const started = h.events
          .filter((event) => event.type === "task.started")
          .find((event) => event.payload.taskId === taskId);
        assert.strictEqual(started?.payload.agentId, taskId);
        assert.strictEqual(started?.payload.parentAgentId, parentAgentId);
        yield* h.emit(turn.input.threadId, {
          type: "task.updated",
          payload: { taskId: "native2", status: "running" },
        });
        const progress = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === taskId);
        assert.strictEqual(progress?.payload.agentId, taskId);
        assert.strictEqual(progress?.payload.parentAgentId, parentAgentId);
        yield* h.emit(turn.input.threadId, {
          type: "session.exited",
          payload: { reason: "Provider exited", recoverable: false },
        });
        const terminal = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === taskId);
        assert.strictEqual(terminal?.threadId, rootId);
        assert.strictEqual(terminal?.payload.status, "interrupted");
        assert.strictEqual(terminal?.payload.agentId, taskId);
        assert.strictEqual(terminal?.payload.parentAgentId, parentAgentId);
      }),
  );

  it.effect(
    "send failure during a pending stop never publishes failed and successful stop clears the prior error",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const releaseSend = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        const stopEntered = yield* Deferred.make<void>();
        const sendFailure = new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "sendTurn",
          issue: "Send failed as the provider stopped",
        });
        h.claude.gates.send = Deferred.await(releaseSend).pipe(
          Effect.andThen(Effect.fail(sendFailure)),
        );
        const child = yield* h.spawn();
        const sending = yield* Queue.take(h.claude.sends);
        h.claude.gates.interrupt = Effect.fail(
          new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "interruptTurn",
            issue: "First stop could not be confirmed",
          }),
        );
        assert.strictEqual(
          (yield* Effect.result(h.bridge.stopTask(rootId, child.agentId)))._tag,
          "Failure",
        );
        assert.isNotNull((yield* h.bridge.wait(h.root, { agentId: child.agentId })).error);
        h.claude.gates.interrupt = Deferred.succeed(stopEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStop)),
        );
        const stopping = yield* h.bridge
          .stopTask(rootId, child.agentId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(stopEntered);
        yield* Deferred.succeed(releaseSend, undefined);
        yield* joinWorker(sending.worker);
        yield* Deferred.succeed(releaseStop, undefined);
        assert.isTrue(yield* Fiber.join(stopping));
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "interrupted");
        assert.isNull(state.error);
        assert.isFalse(
          h.events.some(
            (event) =>
              event.type === "task.updated" &&
              event.payload.taskId === child.agentId &&
              event.payload.status === "failed",
          ),
        );
        assert.deepEqual(h.claude.deliveries, []);
      }),
  );

  it.effect(
    "a newer stop wins while resume is awaiting its original provider registry lookup",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.bridge.stopTask(rootId, child.agentId);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.gates.registry = (instance) =>
          instance === claudeInstance
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void;
        const resuming = yield* Effect.result(h.bridge.stopTask(rootId, child.agentId, true)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(entered);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(resuming);
        assert.strictEqual(result._tag, "Failure");
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.isTrue(state.manuallyStopped);
        assert.strictEqual(state.status, "interrupted");
        assert.strictEqual(state.queuedMessages, 0);
        assert.lengthOf(h.claude.deliveries, 1);
        assert.deepEqual(h.claude.interruptions, [[turn.input.threadId], [turn.input.threadId]]);
        yield* expectRefused(
          h.bridge.send(h.root, { agentId: child.agentId, prompt: "Bypass the newer stop" }),
        );
      }),
  );

  it.effect(
    "an active child with an unconfirmed manual stop cannot resume or clear the stop latch",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        yield* h.claude.nextTurn;
        h.claude.gates.interrupt = Effect.fail(
          new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "interruptTurn",
            issue: "The provider is still running",
          }),
        );
        assert.strictEqual(
          (yield* Effect.result(h.bridge.stopTask(rootId, child.agentId)))._tag,
          "Failure",
        );
        const beforeResume = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(beforeResume.status, "running");
        assert.isTrue(beforeResume.manuallyStopped);
        yield* expectRefused(h.bridge.stopTask(rootId, child.agentId, true));
        assert.deepEqual(yield* h.bridge.wait(h.root, { agentId: child.agentId }), beforeResume);
        assert.lengthOf(h.claude.deliveries, 1);
      }),
  );

  it.effect(
    "Claude task B owned by agent A does not overwrite A during native session-loss cleanup",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "A", taskType: "local_agent", agentKind: "agent", title: "Agent A" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: {
            taskId: "B",
            agentId: "A",
            taskType: "local_agent",
            agentKind: "agent",
            title: "Task B owned by A",
          },
        });
        const taskA = RuntimeTaskId.make(`${child.agentId}:native:A`);
        const taskB = RuntimeTaskId.make(`${child.agentId}:native:B`);
        const startedB = h.events
          .filter((event) => event.type === "task.started")
          .find((event) => event.payload.taskId === taskB);
        assert.strictEqual(startedB?.payload.agentId, taskA);
        assert.strictEqual(startedB?.payload.parentAgentId, taskA);
        yield* h.emit(turn.input.threadId, {
          type: "session.exited",
          payload: { reason: "Claude process lost", recoverable: false },
        });
        const updates = h.events.filter((event) => event.type === "task.updated");
        const interruptedA = updates.findLast((event) => event.payload.taskId === taskA);
        const interruptedB = updates.findLast((event) => event.payload.taskId === taskB);
        assert.strictEqual(interruptedA?.payload.status, "interrupted");
        assert.strictEqual(interruptedA?.payload.agentId, taskA);
        assert.strictEqual(interruptedA?.payload.parentAgentId, child.agentId);
        assert.strictEqual(interruptedB?.payload.status, "interrupted");
        assert.strictEqual(interruptedB?.payload.agentId, taskA);
        assert.strictEqual(interruptedB?.payload.parentAgentId, taskA);
      }),
  );

  it.effect(
    "retiring an adapter settles its native runtime without retiring a bridge grandchild on another adapter",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const parent = yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const grandchild = yield* h.spawn(
          { providerInstanceId: codexInstance },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        const grandchildTurn = yield* h.codex.nextTurn;
        yield* h.emit(parentTurn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native1", taskType: "local_agent", agentKind: "agent" },
        });
        yield* h.emit(parentTurn.input.threadId, {
          type: "content.delta",
          itemId: "unfinished",
          payload: { streamKind: "assistant_text", delta: "Native partial", agentId: "native1" },
        });
        yield* h.emit(parentTurn.input.threadId, {
          type: "user-input.requested",
          requestId: "native-question",
          payload: { questions: [], agentId: "native1" },
        });
        yield* h.bridge.retire(h.claude.adapter);
        const native = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === `${parent.agentId}:native:native1`);
        assert.strictEqual(native?.payload.status, "interrupted");
        const finished = h.events
          .filter((event) => event.type === "item.completed")
          .find((event) => event.itemId === `${parent.agentId}:native:native1:unfinished`);
        assert.strictEqual(finished?.payload.status, "completed");
        const cancelled = h.events
          .filter((event) => event.type === "user-input.resolved")
          .find((event) => event.requestId === `${parent.agentId}:0:request:native-question`);
        assert.strictEqual(cancelled?.payload.cancelled, true);
        const parentState = yield* h.bridge.wait(h.root, { agentId: parent.agentId });
        assert.isTrue(parentState.closed);
        assert.deepEqual(parentState.pendingRequests, []);
        const grandchildState = yield* h.bridge.wait(h.root, { agentId: grandchild.agentId });
        assert.isFalse(grandchildState.closed);
        assert.strictEqual(grandchildState.status, "running");
        assert.isTrue(h.codex.sessions.has(grandchildTurn.input.threadId));
        assert.deepEqual(h.codex.interruptions, []);
        assert.deepEqual(h.codex.stoppedSessions, []);
        assert.notInclude(h.cleared, grandchildTurn.input.threadId);
      }),
  );

  it.effect(
    "deduplicates data-only Codex user-item text blocks while preserving the native child's prompt",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.spawn();
        const parentTurn = yield* h.claude.nextTurn;
        const prompt = "Instruction carried only in item content";
        const child = yield* h.spawn(
          { providerInstanceId: codexInstance, prompt },
          h.caller(parentTurn.input.threadId, claudeInstance),
        );
        const turn = yield* h.codex.nextTurn;
        const data = { item: { type: "userMessage", content: [{ type: "text", text: prompt }] } };
        for (const type of ["item.started", "item.completed"] as const) {
          yield* h.emit(
            turn.input.threadId,
            {
              type,
              itemId: "data-only-echo",
              payload: { itemType: "user_message", status: "completed", data },
            },
            h.codex.adapter,
          );
        }
        yield* h.emit(
          turn.input.threadId,
          {
            type: "item.completed",
            itemId: "data-only-echo",
            payload: { itemType: "user_message", status: "completed", agentId: "native1", data },
          },
          h.codex.adapter,
        );
        const messages = h.events
          .filter((event) => event.type === "item.completed")
          .filter(
            (event) =>
              event.payload.itemType === "user_message" && event.bridgeAgentId === child.agentId,
          );
        assert.lengthOf(messages, 2);
        assert.strictEqual(messages[0]?.payload.agentId, child.agentId);
        assert.strictEqual(messages[0]?.payload.detail, prompt);
        assert.strictEqual(messages[1]?.payload.agentId, `${child.agentId}:native:native1`);
        assert.deepEqual(messages[1]?.payload.data, data);
      }),
  );

  it.effect(
    "restart restores a stopped public ID lazily without clearing its latch or automatically dispatching",
    () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const selection = { instanceId: claudeInstance, model: "claude-durable-test" };
        const child = yield* first.spawn({
          prompt: "Audit the durable assignment",
          modelSelection: selection,
        });
        const original = yield* first.claude.nextTurn;
        yield* first.emit(original.input.threadId, {
          type: "content.delta",
          turnId: original.result.turnId,
          payload: { streamKind: "assistant_text", delta: "Verified the first migration" },
        });
        yield* first.bridge.stopTask(rootId, child.agentId);
        const saved = yield* first.recovery.load(child.agentId);
        assert.isDefined(saved);
        assert.strictEqual(saved?.assignment, "Audit the durable assignment");
        assert.isTrue(saved?.turnAccepted);
        assert.isTrue(saved?.manualStop);
        assert.deepEqual(saved?.session?.resumeCursor, original.result.resumeCursor);
        yield* first.crash;
        const restarted = yield* makeHarness(first.records);
        assert.strictEqual(yield* Queue.size(restarted.claude.starts), 0);
        assert.deepEqual(restarted.events, []);
        yield* expectRefused(
          restarted.bridge.wait(restarted.otherRoot, { agentId: child.agentId }),
        );
        yield* expectRefused(
          restarted.bridge.send(restarted.root, {
            agentId: child.agentId,
            prompt: "An agent cannot clear the persisted manual stop",
          }),
        );
        const restored = yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId });
        assert.strictEqual(restored.agentId, child.agentId);
        assert.strictEqual(restored.status, "interrupted");
        assert.isTrue(restored.manuallyStopped);
        assert.deepEqual(restarted.claude.deliveries, []);
        assert.strictEqual(yield* Queue.size(restarted.claude.starts), 0);
        assert.isTrue(yield* restarted.bridge.stopTask(rootId, child.agentId, true));
        const resumed = yield* restarted.claude.nextTurn;
        const start = yield* Queue.take(restarted.claude.starts);
        assert.deepEqual(start.input.resumeCursor, saved?.session?.resumeCursor);
        assert.strictEqual(start.input.cwd, saved?.sourceSession.cwd);
        assert.strictEqual(start.input.runtimeMode, saved?.sourceSession.runtimeMode);
        assert.strictEqual(resumed.input.interactionMode, saved?.interactionMode);
        assert.deepEqual(start.input.modelSelection, selection);
        assert.deepEqual(resumed.input.modelSelection, selection);
        assert.strictEqual(
          (yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId })).agentId,
          child.agentId,
        );
        assert.isFalse(
          (yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId }))
            .manuallyStopped,
        );
        assert.strictEqual(first.records.size, 1);
      }),
  );

  it.effect.each(["startup", "send"] as const)(
    "stop before %s acceptance survives restart and resumes the original assignment in a fresh native session",
    (boundary) =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const release = yield* Deferred.make<void>();
        if (boundary === "startup") first.claude.gates.start = Deferred.await(release);
        else first.claude.gates.send = Deferred.await(release);
        const child = yield* first.spawn({
          prompt: "Preserve this original unaccepted assignment",
        });
        if (boundary === "startup") yield* Queue.take(first.claude.starts);
        else yield* Queue.take(first.claude.sends);
        yield* first.bridge.stopTask(rootId, child.agentId);
        const saved = yield* first.recovery.load(child.agentId);
        assert.isFalse(saved?.turnAccepted);
        assert.isTrue(saved?.manualStop);
        yield* first.crash;
        const restarted = yield* makeHarness(first.records);
        assert.deepEqual(restarted.claude.deliveries, []);
        assert.isTrue(yield* restarted.bridge.stopTask(rootId, child.agentId, true));
        const resumed = yield* restarted.claude.nextTurn;
        const start = yield* Queue.take(restarted.claude.starts);
        assert.isUndefined(start.input.resumeCursor);
        assert.include(resumed.input.input ?? "", "Preserve this original unaccepted assignment");
        assert.strictEqual(
          (yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId })).agentId,
          child.agentId,
        );
        assert.lengthOf(restarted.claude.deliveries, 1);
        assert.strictEqual(first.records.size, 1);
        assert.deepEqual(first.claude.deliveries, []);
      }),
  );

  it.effect(
    "a crashed active child needs explicit Resume and retains its original public identity",
    () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const child = yield* first.spawn();
        yield* first.claude.nextTurn;
        yield* first.crash;
        const restarted = yield* makeHarness(first.records);
        const restored = yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId });
        assert.strictEqual(restored.status, "interrupted");
        assert.deepEqual(restarted.claude.deliveries, []);
        assert.strictEqual(yield* Queue.size(restarted.claude.starts), 0);
        assert.isTrue(yield* restarted.bridge.stopTask(rootId, child.agentId, true));
        yield* restarted.claude.nextTurn;
        assert.strictEqual(
          (yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId })).agentId,
          child.agentId,
        );
        assert.strictEqual(first.records.size, 1);
      }),
  );

  it.effect.each(["start", "send"] as const)(
    "missing native history at %s after restart gets one fresh fallback with assignment, context, and the same public ID",
    (boundary) =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const child = yield* first.spawn({ prompt: "Finish migrating the durable table" });
        const turn = yield* first.claude.nextTurn;
        yield* first.emit(turn.input.threadId, {
          type: "item.completed",
          itemId: "saved-progress",
          turnId: turn.result.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "Migration 1 committed; migration 2 remains",
          },
        });
        yield* first.bridge.stopTask(rootId, child.agentId);
        yield* first.crash;
        const h = yield* makeHarness(first.records);
        h.claude.gates[boundary] = Effect.suspend(() => {
          h.claude.gates[boundary] = Effect.void;
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: "claudeAgent",
              operation: boundary,
              issue: "No conversation found with session ID: account-history-missing",
            }),
          );
        });
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        if (boundary === "send") {
          const failed = yield* Queue.take(h.claude.sends);
          yield* joinWorker(failed.worker);
        }
        const resumed = yield* h.claude.nextTurn;
        const nativeResume = yield* Queue.take(h.claude.starts);
        const fresh = yield* Queue.take(h.claude.starts);
        assert.deepEqual(nativeResume.input.resumeCursor, turn.result.resumeCursor);
        assert.isUndefined(fresh.input.resumeCursor);
        assert.notStrictEqual(fresh.input.threadId, nativeResume.input.threadId);
        assert.include(resumed.input.input ?? "", "Finish migrating the durable table");
        assert.include(resumed.input.input ?? "", "Migration 1 committed; migration 2 remains");
        assert.match(resumed.input.input ?? "", /prior tool outcomes|side effects/i);
        const notice = h.events
          .filter((event) => event.type === "item.completed")
          .find((event) => /fresh provider session/i.test(event.payload.detail ?? ""));
        assert.strictEqual(notice?.payload.agentId, child.agentId);
        const recovered = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(recovered.agentId, child.agentId);
        assert.strictEqual(recovered.status, "running");
        assert.isNull(recovered.error);
        const beforeLateExit = h.events.length;
        yield* h.emit(nativeResume.input.threadId, {
          type: "session.exited",
          payload: { reason: "Old account process exited", recoverable: false },
        });
        assert.strictEqual(h.events.length, beforeLateExit);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).status,
          "running",
        );
        assert.strictEqual(yield* Queue.size(h.claude.starts), 0);
        assert.lengthOf(h.claude.deliveries, 1);
        assert.strictEqual(first.records.size, 1);
      }),
  );

  it.effect(
    "a missing-history runtime error recovers once under the same public ID and fences late native events",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn({ prompt: "Finish the runtime recovery assignment" });
        const original = yield* h.claude.nextTurn;
        yield* Queue.take(h.claude.starts);
        yield* h.emit(original.input.threadId, {
          type: "item.completed",
          itemId: "checkpoint",
          turnId: original.result.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "The checkpoint already exists",
          },
        });
        yield* h.emit(original.input.threadId, {
          type: "runtime.error",
          turnId: original.result.turnId,
          payload: { message: "No conversation found with session ID: missing-account-session" },
        });
        const recovered = yield* h.claude.nextTurn;
        const fresh = yield* Queue.take(h.claude.starts);
        assert.isUndefined(fresh.input.resumeCursor);
        assert.notStrictEqual(recovered.input.threadId, original.input.threadId);
        assert.include(recovered.input.input ?? "", "Finish the runtime recovery assignment");
        assert.include(recovered.input.input ?? "", "The checkpoint already exists");
        const beforeLate = h.events.length;
        yield* h.emit(original.input.threadId, {
          type: "content.delta",
          turnId: original.result.turnId,
          payload: { streamKind: "assistant_text", delta: "Stale old-account output" },
        });
        assert.strictEqual(h.events.length, beforeLate);
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.agentId, child.agentId);
        assert.notInclude(state.reply, "Stale old-account output");
        assert.lengthOf(h.claude.deliveries, 2);
        assert.strictEqual(h.records.size, 1);
      }),
  );

  it.effect.each(["start", "send"] as const)(
    "missing history retries fresh only once when fresh %s fails, then preserves saved context across another restart and Resume",
    (boundary) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const original = yield* h.claude.nextTurn;
        yield* Queue.take(h.claude.starts);
        yield* h.emit(original.input.threadId, {
          type: "item.completed",
          itemId: "completed-before-account-loss",
          turnId: original.result.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "The database was migrated; do not repeat it",
          },
        });
        yield* h.bridge.stopTask(rootId, child.agentId);
        h.claude.sessions.delete(original.input.threadId);
        h.claude.gates.start = Effect.fail(
          new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "startSession",
            issue: "No conversation found with session ID: permanently-missing",
          }),
        );
        if (boundary === "send") {
          const missing = h.claude.gates.start;
          h.claude.gates.start = Effect.suspend(() => {
            h.claude.gates.start = Effect.void;
            return missing;
          });
          h.claude.gates.send = missing;
        }
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        const nativeAttempt = yield* Queue.take(h.claude.starts);
        yield* joinWorker(nativeAttempt.worker);
        const freshAttempt = yield* Queue.take(h.claude.starts);
        yield* joinWorker(freshAttempt.worker);
        assert.isDefined(nativeAttempt.input.resumeCursor);
        assert.isUndefined(freshAttempt.input.resumeCursor);
        assert.strictEqual(yield* Queue.size(h.claude.starts), 0);
        assert.lengthOf(h.claude.deliveries, 1);
        const failed = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(failed.status, "failed");
        assert.include(failed.error ?? "", "permanently-missing");
        yield* h.emit(freshAttempt.input.threadId, {
          type: "session.exited",
          payload: { reason: "Failed process exited", recoverable: false },
        });
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).status,
          "failed",
        );
        if (boundary === "send")
          assert.isFalse((yield* h.recovery.load(child.agentId))?.turnAccepted);
        yield* h.crash;
        const restarted = yield* makeHarness(h.records);
        assert.isTrue(yield* restarted.bridge.stopTask(rootId, child.agentId, true));
        const recovered = yield* restarted.claude.nextTurn;
        assert.include(recovered.input.input ?? "", "Do the child assignment");
        assert.include(recovered.input.input ?? "", "The database was migrated; do not repeat it");
        assert.strictEqual(
          (yield* restarted.bridge.wait(restarted.root, { agentId: child.agentId })).agentId,
          child.agentId,
        );
      }),
  );

  it.effect(
    "a nonrecoverable native session exit waits for explicit Resume into a fresh session under the same public ID",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* Queue.take(h.claude.starts);
        h.claude.sessions.delete(turn.input.threadId);
        yield* h.emit(turn.input.threadId, {
          type: "session.exited",
          payload: { reason: "Provider history cannot be recovered", recoverable: false },
        });
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "interrupted");
        const lastTask = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(lastTask?.payload.canResume, true);
        assert.strictEqual(yield* Queue.size(h.claude.starts), 0);
        assert.strictEqual(h.claude.sessions.size, 0);
        assert.lengthOf(h.claude.deliveries, 1);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        const resumed = yield* h.claude.nextTurn;
        const fresh = yield* Queue.take(h.claude.starts);
        assert.isUndefined(fresh.input.resumeCursor);
        assert.notStrictEqual(resumed.input.threadId, turn.input.threadId);
        assert.include(resumed.input.input ?? "", "Do the child assignment");
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).agentId,
          child.agentId,
        );
      }),
  );

  it.effect(
    "nonrecoverable session exit stamped with the stopped turn settles native work and requires fresh explicit Resume",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const turn = yield* h.claude.nextTurn;
        yield* h.emit(turn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native1", taskType: "local_agent", agentKind: "agent" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "request.opened",
          requestId: "native-approval",
          payload: { requestType: "command_execution_approval", agentId: "native1" },
        });
        yield* h.emit(turn.input.threadId, {
          type: "user-input.requested",
          requestId: "native-question",
          payload: { questions: [], agentId: "native1" },
        });
        yield* h.bridge.stopTask(rootId, child.agentId);
        assert.lengthOf(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).pendingRequests,
          2,
        );
        yield* h.emit(turn.input.threadId, {
          type: "session.exited",
          turnId: turn.result.turnId,
          payload: {
            reason: "Stopped provider exited without recoverable history",
            recoverable: false,
          },
        });
        const state = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(state.status, "interrupted");
        assert.deepEqual(state.pendingRequests, []);
        const approval = h.events
          .filter((event) => event.type === "request.resolved")
          .find((event) => event.requestId === `${child.agentId}:0:request:native-approval`);
        assert.strictEqual(approval?.payload.decision, "cancel");
        const question = h.events
          .filter((event) => event.type === "user-input.resolved")
          .find((event) => event.requestId === `${child.agentId}:0:request:native-question`);
        assert.strictEqual(question?.payload.cancelled, true);
        const updates = h.events.filter((event) => event.type === "task.updated");
        assert.strictEqual(
          updates.findLast((event) => event.payload.taskId === `${child.agentId}:native:native1`)
            ?.payload.status,
          "interrupted",
        );
        assert.strictEqual(
          updates.findLast((event) => event.payload.taskId === child.agentId)?.payload.canResume,
          true,
        );
        assert.lengthOf(h.claude.deliveries, 1);
        assert.isTrue(state.manuallyStopped);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        const resumed = yield* h.claude.nextTurn;
        assert.notStrictEqual(resumed.input.threadId, turn.input.threadId);
        assert.include(resumed.input.input ?? "", "Do the child assignment");
      }),
  );

  it.effect(
    "a delayed nonrecoverable exit from stopped turn T does not interrupt resumed turn U or disable its later resume",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const child = yield* h.spawn();
        const stoppedTurn = yield* h.claude.nextTurn;
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* h.bridge.stopTask(rootId, child.agentId, true);
        const resumedTurn = yield* h.claude.nextTurn;
        assert.notStrictEqual(resumedTurn.result.turnId, stoppedTurn.result.turnId);
        yield* h.emit(resumedTurn.input.threadId, {
          type: "task.started",
          payload: { taskId: "native-current", taskType: "local_agent", agentKind: "agent" },
        });
        const eventsBeforeExit = h.events.length;
        yield* h.emit(stoppedTurn.input.threadId, {
          type: "session.exited",
          turnId: stoppedTurn.result.turnId,
          payload: { reason: "Delayed exit from the earlier turn", recoverable: false },
        });
        const afterExit = yield* h.bridge.wait(h.root, { agentId: child.agentId });
        assert.strictEqual(afterExit.status, "running");
        assert.isFalse(afterExit.manuallyStopped);
        assert.strictEqual(h.events.length, eventsBeforeExit);
        yield* h.emit(resumedTurn.input.threadId, {
          type: "content.delta",
          turnId: resumedTurn.result.turnId,
          payload: { streamKind: "assistant_text", delta: "Turn U is still working" },
        });
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).reply,
          "Turn U is still working",
        );
        yield* h.bridge.stopTask(rootId, child.agentId);
        const stoppedAgain = h.events
          .filter((event) => event.type === "task.updated")
          .findLast((event) => event.payload.taskId === child.agentId);
        assert.strictEqual(stoppedAgain?.payload.canResume, true);
        assert.isTrue(yield* h.bridge.stopTask(rootId, child.agentId, true));
        yield* h.claude.nextTurn;
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).status,
          "running",
        );
        assert.lengthOf(h.claude.deliveries, 3);
      }),
  );

  it.effect(
    "does not send user work if stop wins while the running notification is being published",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const release = yield* Deferred.make<void>();
        h.gates.publish = (event) =>
          event.type === "task.updated" && event.payload.status === "running"
            ? Effect.withFiber((worker) =>
                Deferred.succeed(entered, worker).pipe(Effect.andThen(Deferred.await(release))),
              )
            : Effect.void;
        const child = yield* h.spawn();
        const worker = yield* Deferred.await(entered);
        yield* h.bridge.stopTask(rootId, child.agentId);
        yield* Deferred.succeed(release, undefined);
        yield* joinWorker(worker);
        assert.deepEqual(h.claude.deliveries, []);
        assert.strictEqual(
          (yield* h.bridge.wait(h.root, { agentId: child.agentId })).status,
          "interrupted",
        );
      }),
  );
});
