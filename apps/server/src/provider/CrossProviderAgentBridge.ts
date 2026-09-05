import {
  ApprovalRequestId,
  EventId,
  ModelSelection,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderUserInputAnswers,
  type ProviderApprovalDecision,
  type RuntimeTaskStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  CrossProviderAgentRecord,
  CrossProviderAgentRecoveryStore,
} from "./CrossProviderAgentRecovery.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { readMcpProviderSession } from "../mcp/McpProviderSession.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ProviderAdapterRegistryShape } from "./Services/ProviderAdapterRegistry.ts";
import {
  ProviderValidationError,
  type ProviderAdapterError,
  type ProviderServiceError,
} from "./Errors.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));
const AgentId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const RequestKey = Schema.optional(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
);
export const CrossAgentSpawnInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  prompt: Text,
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
  modelSelection: Schema.optional(ModelSelection),
  requestKey: RequestKey,
});
export const CrossAgentSendInput = Schema.Struct({
  agentId: AgentId,
  prompt: Text,
  interrupt: Schema.optional(Schema.Boolean),
  requestKey: RequestKey,
});
export const CrossAgentTargetInput = Schema.Struct({ agentId: AgentId, requestKey: RequestKey });
export const CrossAgentWaitInput = Schema.Struct({
  agentId: AgentId,
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }))),
});

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Root = {
  session: ProviderSession;
  interactionMode?: ProviderSendTurnInput["interactionMode"];
  modelSelection?: ModelSelection | undefined;
};
type Pending = {
  prompt: string;
  id: string;
  resume?: boolean;
  recovery?: boolean;
  question?: { requestId: string; answers: ProviderUserInputAnswers };
};
type NativeState = {
  taskId: string;
  ownerAgentId: string;
  status: RuntimeTaskStatus;
  parentAgentId: string;
  isAgent: boolean;
};
interface Child {
  id: string;
  hiddenId: ThreadId;
  root: ThreadId;
  parent?: string;
  adapter: Adapter;
  instance: ProviderInstanceId;
  source: Root;
  modelSelection?: ModelSelection;
  title: string;
  providerName: string;
  status: RuntimeTaskStatus;
  generation: number;
  closed: boolean;
  manualStop: boolean;
  stopping: boolean;
  dispatching: boolean;
  session?: ProviderSession;
  turnId?: string | undefined;
  reply: string;
  error?: string | undefined;
  queue: Pending[];
  changed: Deferred.Deferred<void>;
  openItems: Map<string, string>;
  nativeTasks: Set<string>;
  nativeStates: Map<string, NativeState>;
  settledTurns: Set<string>;
  echoPrompts: string[];
  echoedItems: Set<string>;
  suppressNative: boolean;
  resumeUnavailable: boolean;
  deleted: boolean;
  assignment: string;
  pendingInput?: string | undefined;
  context: string;
  turnAccepted: boolean;
  forceFresh: boolean;
  recoveryAttempted: boolean;
  persistence: Semaphore.Semaphore;
  replacingSession: boolean;
}
interface RequestRoute {
  child: Child;
  nativeId: string;
  generation: number;
  event: ProviderRuntimeEvent;
  messageMode: boolean;
  agentId: string;
  answerQueued?: boolean;
}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
const isCodexUserItem = Schema.is(
  Schema.Struct({
    item: Schema.Struct({
      type: Schema.Literal("userMessage"),
      content: Schema.Array(Schema.Unknown),
    }),
  }),
);
const isTextInput = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isTaskStatus = Schema.is(
  Schema.Literals([
    "pending",
    "running",
    "waiting",
    "idle",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
);

const invalid = (issue: string) =>
  new ProviderValidationError({ operation: "cross-provider-agent", issue });
const active = (child: Child) => ["pending", "running", "waiting"].includes(child.status);
const hiddenPrefix = "cross-provider-session:";
export const isCrossProviderSessionId = (id: string) => id.startsWith(hiddenPrefix);
const missingHistory = (detail: string) =>
  /no conversation found with session id|(?:thread|session|conversation)[^\n]{0,100}(?:not found|does not exist|unknown)|(?:unknown|invalid) (?:thread|session|conversation) (?:id|identifier)/i.test(
    detail,
  );

/** Owns hidden sessions independently of the MCP request and parent provider process. */
export const makeCrossProviderAgentBridge = Effect.fn("makeCrossProviderAgentBridge")(
  function* (deps: {
    registry: ProviderAdapterRegistryShape;
    publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    prepare: (
      thread: ThreadId,
      instance: ProviderInstanceId,
      root: ThreadId,
    ) => Effect.Effect<unknown>;
    clear: (thread: ThreadId) => Effect.Effect<void>;
    touch: (thread: ThreadId) => Effect.Effect<void>;
    root: (thread: ThreadId) => Effect.Effect<Root, ProviderServiceError>;
    rootStopped: (thread: ThreadId) => Effect.Effect<boolean, ProviderServiceError>;
    enabled: Effect.Effect<boolean>;
    recovery: CrossProviderAgentRecoveryStore;
  }) {
    const scope = yield* Effect.scope;
    const crypto = yield* Crypto.Crypto;
    const children = new Map<string, Child>();
    const hidden = new Map<ThreadId, Child>();
    const requests = new Map<string, RequestRoute>();
    const rootInbox = new Map<ThreadId, Array<{ id: string; prompt: string }>>();
    const stoppedTrees = new Set<ThreadId>();
    const deletedRoots = new Set<ThreadId>();
    const stopGenerations = new Map<ThreadId, number>();
    const activating = new Set<string>();
    const receipts = new Map<
      string,
      { arguments: string; result: Deferred.Deferred<unknown, ProviderServiceError> }
    >();
    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
    const persist = (child: Child) =>
      child.persistence
        .withPermits(1)(
          Effect.suspend(() =>
            deps.recovery.save({
              version: 1,
              id: child.id,
              root: child.root,
              ...(child.parent ? { parent: child.parent } : {}),
              provider: child.adapter.provider,
              instance: child.instance,
              sourceSession: child.source.session,
              ...(child.source.interactionMode
                ? { interactionMode: child.source.interactionMode }
                : {}),
              ...(child.modelSelection ? { modelSelection: child.modelSelection } : {}),
              title: child.title,
              providerName: child.providerName,
              status: child.status,
              manualStop: child.manualStop,
              closed: child.closed,
              deleted: child.deleted,
              generation: child.generation,
              ...(child.session ? { session: child.session } : {}),
              assignment: child.assignment,
              ...(child.pendingInput ? { pendingInput: child.pendingInput } : {}),
              context: child.context,
              reply: child.reply,
              turnAccepted: child.turnAccepted,
              forceFresh: child.forceFresh || child.resumeUnavailable,
            } satisfies CrossProviderAgentRecord),
          ),
        )
        .pipe(Effect.orDie);
    const rememberContext = (child: Child, text: string) => {
      child.context = `${child.context}\n${text}`.slice(-64_000);
    };
    const recoveryPrompt = (child: Child) =>
      [
        "Continue this T3 agent's assignment. The native provider history is unavailable; this is recovery under the SAME T3 agent ID, not a new assignment.",
        "Inspect the current workspace and prior tool outcomes first. Operations may already have completed before interruption. Do not blindly repeat edits, commands, messages, or other side effects.",
        `Original assignment:\n${child.assignment}`,
        child.pendingInput && child.pendingInput !== child.assignment
          ? `Most recent instruction:\n${child.pendingInput}`
          : "",
        child.context
          ? `Saved recovery context (may be truncated):\n${child.context}`
          : "No provider output was saved before interruption.",
      ]
        .filter(Boolean)
        .join("\n\n");
    const stamp = Effect.gen(function* () {
      return {
        eventId: EventId.make(yield* uuid),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
    });
    const snapshot = (child: Child) => ({
      agentId: child.id,
      providerInstanceId: child.instance,
      provider: child.adapter.provider,
      status: child.status,
      closed: child.closed,
      manuallyStopped: child.manualStop,
      reply: child.reply,
      error: child.error ?? null,
      queuedMessages: child.queue.length,
      pendingRequests: [...requests].filter(([, r]) => r.child === child).map(([id]) => id),
    });
    const signal = (child: Child) =>
      Effect.gen(function* () {
        const previous = child.changed;
        child.changed = yield* Deferred.make<void>();
        yield* Deferred.succeed(previous, undefined);
      });
    const publishTask = (child: Child) =>
      Effect.gen(function* () {
        yield* deps.publish({
          ...(yield* stamp),
          type: "task.updated",
          provider: child.adapter.provider,
          providerInstanceId: child.instance,
          threadId: child.root,
          bridgeAgentId: child.id,
          payload: {
            taskId: RuntimeTaskId.make(child.id),
            taskType: "cross_provider",
            agentKind: "agent",
            executionOwner: "cross-provider",
            title: child.title,
            role: child.providerName,
            ...(child.modelSelection?.model || child.session?.model
              ? { model: child.modelSelection?.model ?? child.session?.model }
              : {}),
            ...(child.parent ? { parentAgentId: child.parent } : {}),
            status: child.status,
            isBackgrounded: true,
            canStop: !child.closed,
            canResume: !child.deleted && !active(child) && !child.stopping,
            ...(child.error ? { error: child.error } : {}),
          },
        });
        yield* signal(child);
      });
    const task = (child: Child) => persist(child).pipe(Effect.andThen(publishTask(child)));
    const instruction = (child: Child, pending: Pending) =>
      Effect.gen(function* () {
        if (!pending.recovery) rememberContext(child, `Instruction: ${pending.prompt}`);
        yield* persist(child);
        child.echoPrompts.push(pending.prompt);
        if (child.echoPrompts.length > 64) child.echoPrompts.shift();
        yield* deps.publish({
          ...(yield* stamp),
          type: "item.completed",
          provider: child.adapter.provider,
          providerInstanceId: child.instance,
          threadId: child.root,
          bridgeAgentId: child.id,
          itemId: RuntimeItemId.make(`${child.id}:prompt:${pending.id}`),
          payload: {
            itemType: "user_message",
            status: "completed",
            agentId: child.id,
            detail: pending.prompt,
          },
        });
      });
    const finishItems = (child: Child, includeNative = false) =>
      Effect.gen(function* () {
        for (const [id, agentId] of child.openItems) {
          if (!includeNative && agentId !== child.id) continue;
          yield* deps.publish({
            ...(yield* stamp),
            type: "item.completed",
            provider: child.adapter.provider,
            providerInstanceId: child.instance,
            threadId: child.root,
            bridgeAgentId: child.id,
            itemId: RuntimeItemId.make(id),
            payload: { itemType: "assistant_message", status: "completed", agentId },
          });
          child.openItems.delete(id);
        }
      });
    const authorize = (caller: McpInvocationScope) =>
      Effect.gen(function* () {
        if (!(yield* deps.enabled)) return yield* invalid("Agent Browser access is disabled.");
        const issued = readMcpProviderSession(caller.threadId);
        if (
          !issued ||
          issued.providerSessionId !== caller.providerSessionId ||
          issued.providerInstanceId !== caller.providerInstanceId
        ) {
          return yield* invalid(
            "The calling provider session has expired. Resume it before using agent tools.",
          );
        }
        const owner = hidden.get(caller.threadId);
        const callingAdapter =
          owner?.adapter ?? (yield* deps.registry.getByInstance(caller.providerInstanceId));
        if (callingAdapter.capabilities.crossProviderAgents === false)
          return yield* invalid(
            "Cross-provider agents require a locally managed provider session.",
          );
        if (isCrossProviderSessionId(caller.threadId) && !owner)
          return yield* invalid("This child session is no longer available.");
        if (owner?.closed || owner?.manualStop || owner?.stopping)
          return yield* invalid("The calling agent is stopped.");
        const root = owner?.root ?? caller.threadId;
        if (stoppedTrees.has(root))
          return yield* invalid("This agent tree was stopped by the user.");
        if (!owner && (yield* deps.rootStopped(root)))
          return yield* invalid("The main agent was stopped by the user.");
        return { root, owner };
      });
    const restoring = new Map<string, Deferred.Deferred<Child | undefined, ProviderServiceError>>();
    const restore = (
      root: ThreadId,
      id: string,
    ): Effect.Effect<Child | undefined, ProviderServiceError> =>
      Effect.gen(function* () {
        const existing = children.get(id);
        if (existing) return existing.root === root ? existing : undefined;
        if (deletedRoots.has(root)) return undefined;
        if (!id.startsWith("cross-provider:") || id.includes(":native:")) return undefined;
        const stopGeneration = stopGenerations.get(root);
        const receiptKey = encodeJson([root, id]);
        const result = yield* Effect.gen(function* () {
          const pending = restoring.get(receiptKey);
          if (pending) return pending;
          const receipt = yield* Deferred.make<Child | undefined, ProviderServiceError>();
          restoring.set(receiptKey, receipt);
          const recover = Effect.gen(function* () {
            const record = yield* deps.recovery.load(id);
            if (!record || record.root !== root || record.deleted) return undefined;
            const adapter = yield* deps.registry.getByInstance(record.instance);
            if (
              adapter.provider !== record.provider ||
              adapter.capabilities.crossProviderAgents === false
            )
              return yield* invalid(
                "Restore the original local provider configuration to resume this agent ID.",
              );
            const child: Child = {
              id,
              hiddenId: ThreadId.make(`${hiddenPrefix}${id}`),
              root,
              ...(record.parent ? { parent: record.parent } : {}),
              adapter,
              instance: record.instance,
              source: {
                session: record.sourceSession,
                ...(record.interactionMode ? { interactionMode: record.interactionMode } : {}),
              },
              ...(record.modelSelection ? { modelSelection: record.modelSelection } : {}),
              title: record.title,
              providerName: record.providerName,
              status: ["pending", "running", "waiting", "idle"].includes(record.status)
                ? "interrupted"
                : record.status,
              generation: record.generation + 1,
              closed: true,
              deleted: false,
              manualStop: record.manualStop || stopGeneration !== stopGenerations.get(root),
              stopping: false,
              dispatching: false,
              ...(record.session ? { session: record.session } : {}),
              reply: record.reply,
              queue: [],
              changed: yield* Deferred.make<void>(),
              openItems: new Map(),
              nativeTasks: new Set(),
              nativeStates: new Map(),
              settledTurns: new Set(),
              echoPrompts: [],
              echoedItems: new Set(),
              suppressNative: true,
              resumeUnavailable: false,
              assignment: record.assignment,
              ...(record.pendingInput ? { pendingInput: record.pendingInput } : {}),
              context: record.context,
              turnAccepted: record.turnAccepted,
              forceFresh: record.forceFresh || !record.turnAccepted,
              recoveryAttempted: false,
              persistence: yield* Semaphore.make(1),
              replacingSession: false,
            };
            if (deletedRoots.has(root)) return undefined;
            children.set(id, child);
            hidden.set(child.hiddenId, child);
            return child;
          });
          yield* recover.pipe(
            Effect.interruptible,
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(receipt, exit)),
            Effect.ensuring(Effect.sync(() => restoring.delete(receiptKey))),
            Effect.forkIn(scope),
          );
          return receipt;
        }).pipe(Effect.uninterruptible);
        return yield* Deferred.await(result);
      });
    const target = (root: ThreadId, owner: Child | undefined, id: string) =>
      Effect.gen(function* () {
        const child = yield* restore(root, id);
        if (!child || child.deleted) return undefined;
        if (!owner) return child;
        let parent = child.parent;
        for (let depth = 0; parent && depth < 3; depth++) {
          if (parent === owner.id) return child;
          const record = yield* deps.recovery.load(parent);
          if (record?.root !== root) return undefined;
          parent = record.parent;
        }
        return undefined;
      });
    const write = (
      caller: McpInvocationScope,
      operation: string,
      key: string | undefined,
      args: unknown,
      action: Effect.Effect<unknown, ProviderServiceError>,
    ) =>
      Effect.gen(function* () {
        yield* authorize(caller);
        const id = key ? encodeJson([caller.providerSessionId, operation, key]) : undefined;
        const argumentsJson = encodeJson(args);
        const result = yield* Effect.gen(function* () {
          const previous = id ? receipts.get(id) : undefined;
          if (previous) {
            if (previous.arguments !== argumentsJson)
              return yield* invalid("Request key was already used with different arguments.");
            return previous.result;
          }
          if (id && receipts.size >= 4096)
            return yield* invalid("This server's agent retry receipt capacity is full.");
          const result = yield* Deferred.make<unknown, ProviderServiceError>();
          if (id) receipts.set(id, { arguments: argumentsJson, result });
          yield* action.pipe(
            Effect.interruptible,
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(result, exit)),
            Effect.forkIn(scope),
          );
          return result;
        }).pipe(Effect.uninterruptible);
        return yield* Deferred.await(result);
      });
    const boundedControl = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              invalid(
                "The provider did not confirm this operation within 10 seconds. Its outcome is unconfirmed.",
              ),
            ),
        }),
      );
    const collectControl = <A, E>(effect: Effect.Effect<A, E>, failures: string[]) =>
      boundedControl(effect).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            failures.push(Cause.pretty(cause));
          }),
        ),
        Effect.asVoid,
      );
    const cancelRequests = (child: Child, includeNative = false) =>
      Effect.gen(function* () {
        for (const [id, route] of requests) {
          if (route.child !== child) continue;
          if (!includeNative && route.agentId !== child.id) continue;
          requests.delete(id);
          if (route.event.type === "request.opened") {
            yield* deps.publish({
              ...(yield* stamp),
              type: "request.resolved",
              provider: child.adapter.provider,
              providerInstanceId: child.instance,
              threadId: child.root,
              bridgeAgentId: child.id,
              requestId: RuntimeRequestId.make(id),
              payload: {
                requestType: route.event.payload.requestType,
                decision: "cancel",
                agentId: route.agentId,
              },
            });
          } else {
            yield* deps.publish({
              ...(yield* stamp),
              type: "user-input.resolved",
              provider: child.adapter.provider,
              providerInstanceId: child.instance,
              threadId: child.root,
              bridgeAgentId: child.id,
              requestId: RuntimeRequestId.make(id),
              payload: {
                answers: {},
                cancelled: true,
                reason: "The agent was stopped before answering.",
                agentId: route.agentId,
              },
            });
          }
        }
      });
    const nativeState = (child: Child, state: NativeState) =>
      Effect.gen(function* () {
        yield* deps.publish({
          ...(yield* stamp),
          type: "task.updated",
          provider: child.adapter.provider,
          providerInstanceId: child.instance,
          threadId: child.root,
          bridgeAgentId: child.id,
          payload: {
            taskId: RuntimeTaskId.make(state.taskId),
            agentId: state.ownerAgentId,
            parentAgentId: state.parentAgentId,
            executionOwner: "cross-provider",
            ...(state.isAgent ? { agentKind: "agent" as const } : {}),
            status: state.status,
            canStop:
              state.isAgent &&
              child.adapter.stopTask !== undefined &&
              ["pending", "running", "waiting"].includes(state.status),
            canResume: false,
          },
        });
      });
    const settleNativeRuntime = (child: Child) =>
      Effect.gen(function* () {
        child.suppressNative = true;
        for (const state of child.nativeStates.values()) {
          if (!["pending", "running", "waiting", "idle"].includes(state.status)) continue;
          state.status = "interrupted";
          yield* nativeState(child, state);
        }
        child.nativeTasks.clear();
        yield* finishItems(child, true);
        yield* cancelRequests(child, true);
      });
    const interrupt = (child: Child, manual: boolean) =>
      Effect.gen(function* () {
        if (manual) {
          child.manualStop = true;
          child.generation++;
        }
        child.queue = [];
        if (child.stopping) return yield* invalid("An interruption is already pending.");
        child.stopping = true;
        const failures: string[] = [];
        let providerFailure: ProviderServiceError | undefined;
        yield* Effect.all(
          [
            collectControl(persist(child), failures),
            collectControl(
              Effect.gen(function* () {
                const generation = child.generation;
                const result = yield* boundedControl(
                  Effect.gen(function* () {
                    // The child's own native descendants belong to its
                    // session and stop with it. Bridge grandchildren are
                    // separate sessions and keep running.
                    if (yield* child.adapter.hasSession(child.hiddenId))
                      yield* child.adapter.interruptTurn(child.hiddenId);
                  }),
                ).pipe(
                  Effect.onInterrupt(() =>
                    Effect.gen(function* () {
                      child.error =
                        "Individual stop was interrupted before confirmation; no broader stop was attempted.";
                      yield* collectControl(task(child), failures);
                    }),
                  ),
                  Effect.result,
                  Effect.ensuring(
                    Effect.sync(() => {
                      child.stopping = false;
                    }),
                  ),
                );
                if (result._tag === "Failure") {
                  providerFailure = result.failure;
                  child.error = "Could not confirm individual stop; no broader stop was attempted.";
                  yield* task(child);
                  return yield* Effect.fail(result.failure);
                }
                if (generation === child.generation) child.generation++;
                if (child.turnId) child.settledTurns.add(child.turnId);
                child.status = "interrupted";
                child.error = undefined;
                child.turnId = undefined;
                yield* finishItems(child);
                yield* cancelRequests(child);
                yield* publishTask(child);
                yield* persist(child);
              }),
              failures,
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              child.stopping = false;
            }),
          ),
        );
        if (failures.length === 1 && providerFailure) return yield* Effect.fail(providerFailure);
        if (failures.length) return yield* invalid(failures.join("\n"));
      });
    const drain = (child: Child): Effect.Effect<void> =>
      Effect.suspend(() => {
        let ownsDispatch = false;
        let dispatchStarted = false;
        let dispatchInput: Pending | undefined;
        const dispatchGeneration = child.generation;
        return Effect.gen(function* () {
          if (
            child.dispatching ||
            activating.has(child.id) ||
            child.manualStop ||
            child.closed ||
            child.stopping ||
            stoppedTrees.has(child.root)
          )
            return;
          if (child.turnId || child.status === "waiting") return;
          const pending = child.queue.shift();
          if (!pending) return;
          dispatchInput = pending;
          child.dispatching = true;
          ownsDispatch = true;
          const generation = child.generation;
          child.status = "pending";
          child.echoPrompts = [];
          if (child.reply) rememberContext(child, `Saved assistant output: ${child.reply}`);
          child.reply = "";
          child.error = undefined;
          if (!pending.resume && !pending.recovery) child.pendingInput = pending.prompt;
          yield* task(child);
          yield* instruction(child, pending);
          const execution = Effect.gen(function* () {
            if ((yield* deps.registry.getByInstance(child.instance)) !== child.adapter)
              return yield* invalid("The target provider was replaced.");
            const fresh =
              child.forceFresh ||
              child.resumeUnavailable ||
              (!child.turnAccepted && child.session !== undefined);
            if (fresh || !(yield* child.adapter.hasSession(child.hiddenId))) {
              if (fresh && child.nativeTasks.size)
                return yield* invalid(
                  "Recovery cannot replace a native runtime with live descendants. Stop all first.",
                );
              if (child.session) {
                const oldId = child.hiddenId;
                child.replacingSession = true;
                yield* Effect.gen(function* () {
                  if (yield* child.adapter.hasSession(oldId))
                    yield* boundedControl(child.adapter.stopSession(oldId));
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      child.replacingSession = false;
                    }),
                  ),
                );
                if (generation !== child.generation || child.manualStop || child.deleted) return;
                child.hiddenId = ThreadId.make(`${hiddenPrefix}${child.id}:${yield* uuid}`);
                hidden.set(child.hiddenId, child);
                yield* deps.clear(oldId);
              }
              yield* deps.prepare(child.hiddenId, child.instance, child.root);
              if (child.closed) {
                yield* deps.clear(child.hiddenId);
                return;
              }
              if (generation !== child.generation || child.manualStop || child.closed) return;
              child.suppressNative = false;
              child.session = yield* child.adapter.startSession({
                threadId: child.hiddenId,
                provider: child.adapter.provider,
                providerInstanceId: child.instance,
                runtimeMode: child.source.session.runtimeMode,
                ...(child.source.session.cwd ? { cwd: child.source.session.cwd } : {}),
                ...(child.modelSelection ? { modelSelection: child.modelSelection } : {}),
                ...(!fresh && child.session?.resumeCursor
                  ? { resumeCursor: child.session.resumeCursor }
                  : {}),
                title: child.title,
              });
              if (fresh) {
                pending.prompt = recoveryPrompt(child);
                pending.id = yield* uuid;
                pending.recovery = true;
                child.turnAccepted = false;
                child.forceFresh = false;
                child.resumeUnavailable = false;
                rememberContext(
                  child,
                  "Recovery: native history was unavailable; a fresh provider session continues this same T3 agent ID.",
                );
                yield* deps.publish({
                  ...(yield* stamp),
                  type: "item.completed",
                  provider: child.adapter.provider,
                  providerInstanceId: child.instance,
                  threadId: child.root,
                  bridgeAgentId: child.id,
                  itemId: RuntimeItemId.make(`${child.id}:recovery:${pending.id}`),
                  payload: {
                    itemType: "assistant_message",
                    status: "completed",
                    agentId: child.id,
                    detail:
                      "Recovered this agent ID into a fresh provider session because native history was unavailable. The original assignment and saved context were restored; prior side effects must be checked before repeating work.",
                  },
                });
                yield* instruction(child, pending);
              }
              if (child.closed) {
                yield* child.adapter.stopSession(child.hiddenId);
                yield* deps.clear(child.hiddenId);
                return;
              }
            }
            if (generation !== child.generation || child.manualStop || child.closed) return;
            child.status = "running";
            yield* task(child);
            yield* deps.touch(child.hiddenId);
            if (
              generation !== child.generation ||
              child.manualStop ||
              child.closed ||
              child.stopping ||
              stoppedTrees.has(child.root)
            )
              return;
            child.suppressNative = false;
            dispatchStarted = true;
            const turn = yield* child.adapter.sendTurn({
              threadId: child.hiddenId,
              input: pending.prompt,
              ...(child.modelSelection ? { modelSelection: child.modelSelection } : {}),
              ...(child.source.interactionMode
                ? { interactionMode: child.source.interactionMode }
                : {}),
            });
            child.turnAccepted = true;
            if (
              pending.question &&
              generation === child.generation &&
              requests.has(pending.question.requestId)
            ) {
              requests.delete(pending.question.requestId);
              yield* deps.publish({
                ...(yield* stamp),
                type: "user-input.resolved",
                provider: child.adapter.provider,
                providerInstanceId: child.instance,
                threadId: child.root,
                bridgeAgentId: child.id,
                requestId: RuntimeRequestId.make(pending.question.requestId),
                payload: { answers: pending.question.answers, agentId: child.id },
              });
            }
            if (generation !== child.generation) return;
            if (child.session && turn.resumeCursor)
              child.session = { ...child.session, resumeCursor: turn.resumeCursor };
            if (active(child)) child.turnId = turn.turnId;
            yield* persist(child);
          });
          yield* execution.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (generation !== child.generation || child.stopping || child.manualStop) return;
                if (Cause.hasDies(cause)) return yield* Effect.failCause(cause);
                if (
                  !child.recoveryAttempted &&
                  (missingHistory(Cause.pretty(cause)) || child.forceFresh)
                ) {
                  child.forceFresh = true;
                  child.recoveryAttempted = true;
                  child.status = "interrupted";
                  child.turnId = undefined;
                  child.queue.unshift({ ...pending, resume: true });
                  yield* task(child);
                  return;
                }
                const question = pending.question
                  ? requests.get(pending.question.requestId)
                  : undefined;
                if (question && !dispatchStarted) question.answerQueued = false;
                child.status = "failed";
                child.error = Cause.pretty(cause);
                child.turnId = undefined;
                yield* finishItems(child);
                yield* task(child);
              }),
            ),
          );
          child.dispatching = false;
          if (!active(child) && child.queue.length) yield* schedule(child);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (
                !ownsDispatch ||
                child.generation !== dispatchGeneration ||
                child.manualStop ||
                child.stopping ||
                child.closed
              )
                return;
              if (dispatchInput?.question && !dispatchStarted) {
                const request = requests.get(dispatchInput.question.requestId);
                if (request) request.answerQueued = false;
              }
              if (!child.turnId) child.status = "failed";
              child.error = `Recovery state could not be saved. Resume this same agent ID after correcting the persistence failure. ${Cause.pretty(cause)}`;
              yield* publishTask(child);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (ownsDispatch) child.dispatching = false;
            }),
          ),
        );
      });
    const schedule = (child: Child) =>
      drain(child).pipe(Effect.interruptible, Effect.forkIn(scope), Effect.asVoid);
    const activate = (child: Child, user: boolean, prompt?: string) =>
      Effect.gen(function* () {
        if (child.deleted || deletedRoots.has(child.root))
          return yield* invalid("This agent's thread was deleted.");
        if (child.manualStop && !user)
          return yield* invalid("A user must resume this manually stopped agent.");
        if (active(child) || child.stopping || child.dispatching || activating.has(child.id))
          return yield* invalid("This agent is already running or stopping.");
        activating.add(child.id);
        const previous = {
          closed: child.closed,
          manualStop: child.manualStop,
          generation: child.generation,
        };
        let committed = false;
        let activationId: string | undefined;
        return yield* Effect.gen(function* () {
          const generation = child.generation;
          const stopGeneration = stopGenerations.get(child.root);
          const adapter = yield* deps.registry.getByInstance(child.instance);
          if (
            adapter.provider !== child.adapter.provider ||
            adapter.capabilities.crossProviderAgents === false
          )
            return yield* invalid(
              "Restore the original local provider configuration to resume this agent ID.",
            );
          const id = yield* uuid;
          activationId = id;
          if (
            child.deleted ||
            child.stopping ||
            child.dispatching ||
            generation !== child.generation ||
            stopGeneration !== stopGenerations.get(child.root) ||
            deletedRoots.has(child.root)
          )
            return yield* invalid("Another stop occurred while resume was being prepared.");
          if (child.closed) {
            const open = [...children.values()].filter((c) => !c.closed && c !== child);
            if (open.length >= 32 || open.filter((c) => c.root === child.root).length >= 8)
              return yield* invalid(
                "Cross-provider session capacity reached. Close unused sessions before resuming.",
              );
          }
          child.adapter = adapter;
          committed = true;
          child.manualStop = false;
          child.closed = false;
          child.status = "pending";
          child.recoveryAttempted = false;
          child.forceFresh ||= child.resumeUnavailable || !child.turnAccepted;
          stoppedTrees.delete(child.root);
          child.queue.push({
            prompt:
              prompt ??
              (!child.turnAccepted
                ? (child.pendingInput ?? child.assignment)
                : "Continue the interrupted assignment. Check previous tool outcomes before repeating actions."),
            id,
            resume: prompt === undefined,
          });
          yield* persist(child);
          activating.delete(child.id);
          yield* schedule(child);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (
                committed &&
                child.generation === previous.generation &&
                !child.stopping &&
                !child.deleted
              ) {
                child.queue = child.queue.filter((pending) => pending.id !== activationId);
                child.closed = previous.closed;
                child.manualStop = previous.manualStop;
                child.status = "failed";
                child.error = `Resume could not be saved. Retry this same agent ID after correcting the persistence failure. ${Cause.pretty(cause)}`;
                yield* publishTask(child);
              }
              return yield* Effect.failCause(cause);
            }),
          ),
          Effect.ensuring(Effect.sync(() => activating.delete(child.id))),
        );
      });

    const spawn = (caller: McpInvocationScope, input: typeof CrossAgentSpawnInput.Type) =>
      write(
        caller,
        "spawn",
        input.requestKey,
        input,
        Effect.gen(function* () {
          const { root, owner } = yield* authorize(caller);
          const info = yield* deps.registry.getInstanceInfo(input.providerInstanceId);
          if (!info.enabled) return yield* invalid("The target provider is disabled.");
          if (input.modelSelection && input.modelSelection.instanceId !== input.providerInstanceId)
            return yield* invalid("The selected model belongs to a different provider instance.");
          const source = owner ? owner.source : yield* deps.root(root);
          const sourceDriver = owner?.adapter.provider ?? source.session.provider;
          if (info.driverKind === sourceDriver)
            return yield* invalid(
              "Use the provider's native subagent tools for same-provider delegation.",
            );
          let depth = 1;
          let ancestor = owner;
          while (ancestor) {
            depth++;
            ancestor = ancestor.parent ? children.get(ancestor.parent) : undefined;
          }
          if (depth > 3)
            return yield* invalid("Cross-provider nesting is limited to three levels.");
          const open = [...children.values()].filter((c) => !c.closed);
          if (
            open.length >= 32 ||
            open.filter((c) => c.root === root).length >= 8 ||
            children.size >= 4096
          )
            return yield* invalid(
              "Cross-provider session capacity reached. Close unused sessions.",
            );
          const adapter = yield* deps.registry.getByInstance(input.providerInstanceId);
          if (adapter.capabilities.crossProviderAgents === false)
            return yield* invalid("This target is not a locally managed provider session.");
          const id = `cross-provider:${yield* uuid}`;
          const child: Child = {
            id,
            hiddenId: ThreadId.make(`${hiddenPrefix}${id}`),
            root,
            ...(owner ? { parent: owner.id } : {}),
            adapter,
            instance: input.providerInstanceId,
            source,
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            title: input.name ?? `${info.displayName ?? info.driverKind} agent`,
            providerName: info.displayName ?? info.driverKind,
            status: "pending",
            generation: 0,
            closed: false,
            manualStop: false,
            stopping: false,
            dispatching: false,
            reply: "",
            queue: [{ prompt: input.prompt, id: yield* uuid }],
            changed: yield* Deferred.make<void>(),
            openItems: new Map(),
            nativeTasks: new Set(),
            nativeStates: new Map(),
            settledTurns: new Set(),
            echoPrompts: [],
            echoedItems: new Set(),
            suppressNative: false,
            resumeUnavailable: false,
            deleted: false,
            assignment: input.prompt,
            pendingInput: input.prompt,
            context: "",
            turnAccepted: false,
            forceFresh: false,
            recoveryAttempted: false,
            persistence: yield* Semaphore.make(1),
            replacingSession: false,
          };
          // Recheck after asynchronous registry lookups, then register and fork atomically.
          return yield* Effect.gen(function* () {
            yield* authorize(caller);
            if (
              [...children.values()].filter((c) => !c.closed && c.root === root).length >= 8 ||
              [...children.values()].filter((c) => !c.closed).length >= 32
            )
              return yield* invalid("Cross-provider session capacity reached.");
            children.set(id, child);
            hidden.set(child.hiddenId, child);
            yield* task(child);
            yield* schedule(child);
            return snapshot(child);
          }).pipe(Effect.uninterruptible);
        }),
      );
    const send = (caller: McpInvocationScope, input: typeof CrossAgentSendInput.Type) =>
      write(
        caller,
        "send",
        input.requestKey,
        input,
        Effect.gen(function* () {
          const { root, owner } = yield* authorize(caller);
          let child: Child | undefined;
          if (input.agentId === "parent") {
            if (!owner || input.interrupt)
              return yield* invalid(
                "Parent messaging requires a child caller and cannot interrupt its parent.",
              );
            child = owner.parent ? yield* restore(root, owner.parent) : undefined;
            if (!child) {
              const inbox = rootInbox.get(root) ?? [];
              if (
                inbox.length >= 32 ||
                [...rootInbox.values()].reduce((total, messages) => total + messages.length, 0) >=
                  256
              )
                return yield* invalid("The parent's message queue is full.");
              const message = {
                id: yield* uuid,
                prompt: `[Message from ${owner.title} (${owner.id})]\n${input.prompt}`,
              };
              inbox.push(message);
              rootInbox.set(root, inbox);
              return {
                status: "accepted",
                delivery: "queued",
                agentId: "parent",
                messageId: message.id,
              };
            }
          } else child = yield* target(root, owner, input.agentId);
          if (!child) return yield* invalid("Agent is unavailable or outside your owned tree.");
          if (child.manualStop)
            return yield* invalid(
              "The recipient is closed or manually stopped; a user must resume it.",
            );
          if (child.closed) {
            yield* activate(child, false, input.prompt);
            return { ...snapshot(child), delivery: "queued" };
          }
          if (child.queue.length >= 32)
            return yield* invalid("The recipient's input queue is full.");
          if (input.interrupt && active(child)) yield* interrupt(child, false);
          if (child.manualStop || child.closed)
            return yield* invalid("The user stopped the recipient during delivery.");
          if (
            !input.interrupt &&
            child.turnId &&
            child.adapter.capabilities.supportsInputSteering === true
          ) {
            const message = { prompt: input.prompt, id: yield* uuid };
            const generation = child.generation;
            yield* deps.touch(child.hiddenId);
            if (
              child.manualStop ||
              child.closed ||
              child.stopping ||
              stoppedTrees.has(root) ||
              generation !== child.generation
            )
              return yield* invalid("The recipient was stopped before delivery.");
            yield* instruction(child, message);
            if (
              child.manualStop ||
              child.closed ||
              child.stopping ||
              stoppedTrees.has(root) ||
              generation !== child.generation
            )
              return yield* invalid("The recipient was stopped before delivery.");
            yield* boundedControl(
              child.adapter.sendTurn({
                threadId: child.hiddenId,
                input: input.prompt,
                ...(child.source.interactionMode
                  ? { interactionMode: child.source.interactionMode }
                  : {}),
              }),
            );
            return {
              ...snapshot(child),
              messageId: message.id,
              delivery: "delivered",
            };
          }
          const generation = child.generation;
          const messageId = yield* uuid;
          if (
            child.manualStop ||
            child.closed ||
            child.stopping ||
            stoppedTrees.has(root) ||
            generation !== child.generation
          )
            return yield* invalid("The recipient was stopped before the message could be queued.");
          child.queue.push({ prompt: input.prompt, id: messageId });
          yield* schedule(child);
          return { ...snapshot(child), delivery: "queued" };
        }),
      );
    const wait = (caller: McpInvocationScope, input: typeof CrossAgentWaitInput.Type) =>
      Effect.gen(function* () {
        const { root, owner } = yield* authorize(caller);
        const child = yield* target(root, owner, input.agentId);
        if (!child) return yield* invalid("Agent is unavailable or outside your owned tree.");
        if (active(child) && (input.timeoutMs ?? 0) > 0) {
          yield* Deferred.await(child.changed).pipe(Effect.timeoutOption(input.timeoutMs!));
        }
        return snapshot(child);
      });
    const close = (child: Child) =>
      Effect.gen(function* () {
        if (child.closed) return;
        if (child.stopping) return yield* invalid("An interruption is already pending.");
        child.queue = [];
        child.stopping = true;
        const failures: string[] = [];
        yield* Effect.all(
          [
            collectControl(persist(child), failures),
            collectControl(
              Effect.gen(function* () {
                yield* boundedControl(child.adapter.stopSession(child.hiddenId)).pipe(
                  Effect.onError(() =>
                    Effect.gen(function* () {
                      child.error =
                        "Could not confirm close. The session remains tracked; retry close or use Stop all.";
                      yield* collectControl(task(child), failures);
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      child.stopping = false;
                    }),
                  ),
                );
                child.generation++;
                child.closed = true;
                child.status = "interrupted";
                if (child.turnId) child.settledTurns.add(child.turnId);
                child.turnId = undefined;
                yield* finishItems(child, true);
                yield* cancelRequests(child, true);
                yield* deps.clear(child.hiddenId);
                yield* task(child);
              }),
              failures,
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              child.stopping = false;
            }),
          ),
        );
        if (failures.length) return yield* invalid(failures.join("\n"));
      });
    const stopTree = (root: ThreadId, dispose = false) =>
      Effect.gen(function* () {
        stoppedTrees.add(root);
        stopGenerations.set(root, (stopGenerations.get(root) ?? 0) + 1);
        if (dispose) {
          rootInbox.delete(root);
          deletedRoots.add(root);
        }
        const owned = [...children.values()].filter((child) => child.root === root);
        const selected = owned.filter((child) => !child.closed);
        // Fence every child before the first provider call can suspend.
        for (const child of owned) {
          child.manualStop = true;
          child.queue = [];
          child.generation++;
          if (!child.closed) child.stopping = true;
        }
        if (dispose) for (const child of owned) child.deleted = true;
        const journal = Effect.gen(function* () {
          for (const child of owned) yield* persist(child);
          for (const record of yield* deps.recovery.list(root)) {
            if (!children.has(record.id) && !record.deleted)
              yield* deps.recovery.save({
                ...record,
                ...(dispose ? { deleted: true, closed: true } : {}),
                manualStop: true,
              });
          }
        });
        const failures: string[] = [];
        yield* Effect.all(
          [
            collectControl(journal, failures),
            Effect.forEach(
              selected,
              (child) =>
                boundedControl(
                  Effect.gen(function* () {
                    if (dispose) yield* child.adapter.stopSession(child.hiddenId);
                    else if (yield* child.adapter.hasSession(child.hiddenId))
                      yield* child.adapter.interruptTurn(child.hiddenId);
                    if (child.turnId) child.settledTurns.add(child.turnId);
                    child.status = "interrupted";
                    child.turnId = undefined;
                    child.error = undefined;
                    if (dispose) child.closed = true;
                    yield* settleNativeRuntime(child);
                    if (dispose) yield* deps.clear(child.hiddenId);
                    child.stopping = false;
                    yield* publishTask(child);
                    yield* persist(child);
                  }),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.gen(function* () {
                      failures.push(Cause.pretty(cause));
                      child.error = dispose
                        ? "Could not confirm session shutdown. The session remains tracked for retry."
                        : "Could not confirm Stop all.";
                      yield* collectControl(task(child), failures);
                    }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      child.stopping = false;
                    }),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
        if (failures.length) return yield* invalid(failures.join("\n"));
      });
    const control = (
      caller: McpInvocationScope,
      input: typeof CrossAgentTargetInput.Type,
      action: "close" | "interrupt",
    ) =>
      write(
        caller,
        action,
        input.requestKey,
        input,
        Effect.gen(function* () {
          const { root, owner } = yield* authorize(caller);
          const child = yield* target(root, owner, input.agentId);
          if (!child) return yield* invalid("Agent is unavailable or outside your owned tree.");
          if (action === "close") yield* close(child);
          else yield* interrupt(child, false);
          return snapshot(child);
        }),
      );
    const onEvent = (event: ProviderRuntimeEvent, adapter: Adapter): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const child = hidden.get(event.threadId);
        if (!child) return false;
        if (
          adapter !== child.adapter ||
          child.closed ||
          event.threadId !== child.hiddenId ||
          child.replacingSession
        )
          return true;
        if (event.type === "account.rate-limits.updated") {
          yield* deps.publish(event);
          return true;
        }
        const nativeEvent =
          ("agentId" in event.payload && !!event.payload.agentId) || "taskId" in event.payload;
        if (child.suppressNative && nativeEvent) return true;
        if (
          child.status === "interrupted" &&
          !child.stopping &&
          !nativeEvent &&
          event.type !== "session.exited"
        )
          return true;
        if (
          event.type !== "session.exited" &&
          event.turnId &&
          child.settledTurns.has(event.turnId) &&
          !nativeEvent
        )
          return true;
        if (event.type === "turn.started") {
          child.turnId = event.turnId;
          child.status = "running";
          yield* task(child);
          return true;
        }
        if (event.turnId && child.turnId && event.turnId !== child.turnId && !nativeEvent)
          return true;
        if (
          !nativeEvent &&
          event.type === "runtime.error" &&
          missingHistory(event.payload.message)
        ) {
          child.forceFresh = true;
          rememberContext(child, `Native history unavailable: ${event.payload.message}`);
          yield* persist(child);
          if (
            !child.dispatching &&
            !child.manualStop &&
            !child.stopping &&
            !child.recoveryAttempted
          ) {
            child.recoveryAttempted = true;
            child.turnId = undefined;
            child.status = "interrupted";
            child.queue.unshift({
              prompt: child.pendingInput ?? child.assignment,
              id: yield* uuid,
              resume: true,
            });
            yield* schedule(child);
          }
        }
        if (
          event.type === "turn.completed" ||
          event.type === "session.exited" ||
          event.type === "turn.aborted"
        ) {
          if (event.turnId) child.settledTurns.add(event.turnId);
          yield* finishItems(child);
          child.turnId = undefined;
          child.status =
            event.type === "turn.completed"
              ? event.payload.state
              : event.type === "session.exited" &&
                  child.status === "failed" &&
                  !child.manualStop &&
                  !child.stopping
                ? "failed"
                : "interrupted";
          if (event.type === "turn.completed") child.error = event.payload.errorMessage;
          if (event.type === "turn.completed" && child.reply)
            rememberContext(child, `Assistant: ${child.reply}`);
          if (event.type === "session.exited") {
            if (event.payload.recoverable === false) child.resumeUnavailable = true;
            if (
              !(
                child.forceFresh &&
                child.recoveryAttempted &&
                child.dispatching &&
                !child.manualStop &&
                !child.stopping
              )
            )
              child.generation++;
            yield* settleNativeRuntime(child);
          }
          yield* task(child);
          if (event.type === "turn.completed")
            yield* deps.publish({
              ...(yield* stamp),
              type: "task.completed",
              provider: child.adapter.provider,
              providerInstanceId: child.instance,
              threadId: child.root,
              bridgeAgentId: child.id,
              payload: {
                taskId: RuntimeTaskId.make(child.id),
                agentKind: "agent",
                executionOwner: "cross-provider",
                status:
                  child.status === "failed"
                    ? "failed"
                    : child.status === "completed"
                      ? "completed"
                      : "stopped",
                ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
              },
            });
          if (event.type !== "turn.completed") yield* cancelRequests(child);
          else yield* schedule(child);
          return true;
        }
        if (
          (event.type.startsWith("session.") && event.type !== "session.state.changed") ||
          (event.type.startsWith("thread.") &&
            event.type !== "thread.token-usage.updated" &&
            event.type !== "thread.state.changed") ||
          event.type === "turn.diff.updated"
        )
          return true;
        const agentId =
          "agentId" in event.payload && typeof event.payload.agentId === "string"
            ? `${child.id}:native:${event.payload.agentId}`
            : child.id;
        if (
          agentId === child.id &&
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          event.payload.itemType === "user_message"
        ) {
          if (event.itemId && child.echoedItems.has(event.itemId)) return true;
          const echoText =
            typeof event.payload.detail === "string"
              ? event.payload.detail
              : isCodexUserItem(event.payload.data)
                ? event.payload.data.item.content
                    .filter(isTextInput)
                    .map((part) => part.text)
                    .join("\n")
                : undefined;
          const match = echoText === undefined ? -1 : child.echoPrompts.indexOf(echoText);
          if (match >= 0) {
            child.echoPrompts.splice(match, 1);
            if (event.itemId) {
              child.echoedItems.add(event.itemId);
              if (child.echoedItems.size > 4096)
                child.echoedItems.delete(child.echoedItems.values().next().value!);
            }
            return true;
          }
        }
        const nativeItem = event.itemId ?? `assistant:${child.turnId ?? child.generation}`;
        const itemNamespace = agentId === child.id ? `${child.id}:${child.generation}` : agentId;
        const itemId = `${itemNamespace}:${nativeItem}`;
        const payload: Record<string, unknown> = { ...event.payload, agentId };
        for (const key of ["toolUseId", "parentToolUseId", "promptId"] as const) {
          if (typeof payload[key] === "string") payload[key] = `${itemNamespace}:${payload[key]}`;
        }
        if ("taskId" in event.payload) {
          const nativeTask = String(event.payload.taskId);
          payload.taskId = `${child.id}:native:${nativeTask}`;
          payload.executionOwner = "cross-provider";
          payload.parentAgentId =
            "parentAgentId" in event.payload && event.payload.parentAgentId
              ? `${child.id}:native:${event.payload.parentAgentId}`
              : child.id;
          if (
            event.type === "task.completed" ||
            ("status" in event.payload &&
              ["completed", "failed", "cancelled", "interrupted"].includes(
                String(event.payload.status),
              ))
          )
            child.nativeTasks.delete(nativeTask);
          else child.nativeTasks.add(nativeTask);
          const taskAgentId = String(payload.taskId);
          const previous = child.nativeStates.get(taskAgentId);
          const ownerAgentId =
            agentId === child.id ? (previous?.ownerAgentId ?? taskAgentId) : agentId;
          payload.agentId = ownerAgentId;
          if (!("parentAgentId" in event.payload))
            payload.parentAgentId =
              previous?.parentAgentId ?? (ownerAgentId === taskAgentId ? child.id : ownerAgentId);
          const nativeStatus =
            "status" in event.payload && isTaskStatus(event.payload.status)
              ? event.payload.status
              : event.type === "task.completed"
                ? "interrupted"
                : (previous?.status ?? "running");
          const isAgent =
            "agentKind" in event.payload
              ? event.payload.agentKind === "agent"
              : (previous?.isAgent ?? false);
          child.nativeStates.set(taskAgentId, {
            taskId: String(payload.taskId),
            ownerAgentId,
            status: nativeStatus,
            parentAgentId: String(payload.parentAgentId),
            isAgent,
          });
          payload.canStop = child.adapter.stopTask !== undefined && isAgent;
        }
        let requestId: string | undefined;
        if (event.requestId) {
          requestId =
            [...requests].find(
              ([, route]) =>
                route.child === child &&
                route.nativeId === event.requestId &&
                route.agentId === agentId,
            )?.[0] ?? `${child.id}:${child.generation}:request:${event.requestId}`;
          if (event.type === "request.opened" || event.type === "user-input.requested") {
            const messageMode =
              event.type === "user-input.requested" && event.payload.responseMode === "message";
            requests.set(requestId, {
              child,
              nativeId: event.requestId,
              generation: child.generation,
              event,
              messageMode,
              agentId,
            });
            if (messageMode) payload.delivery = "agent";
            else if (agentId === child.id && active(child) && !child.manualStop) {
              child.status = "waiting";
              yield* task(child);
            } else if (agentId !== child.id) {
              const state = child.nativeStates.get(agentId);
              if (state && ["pending", "running", "waiting"].includes(state.status)) {
                state.status = "waiting";
                yield* nativeState(child, state);
              }
            }
          }
          if (event.type === "request.resolved" || event.type === "user-input.resolved") {
            requests.delete(requestId);
            if (
              agentId === child.id &&
              !child.manualStop &&
              ![...requests.values()].some(
                (r) => r.child === child && r.agentId === agentId && !r.messageMode,
              ) &&
              child.status === "waiting"
            ) {
              child.status = "running";
              yield* task(child);
            }
            if (
              agentId !== child.id &&
              ![...requests.values()].some(
                (r) => r.child === child && r.agentId === agentId && !r.messageMode,
              )
            ) {
              const state = child.nativeStates.get(agentId);
              if (state?.status === "waiting") {
                state.status = "running";
                yield* nativeState(child, state);
              }
            }
          }
        }
        if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
          child.openItems.set(itemId, agentId);
          if (agentId === child.id)
            child.reply = (child.reply + event.payload.delta).slice(-100_000);
        }
        if (event.type === "item.completed") {
          child.openItems.delete(itemId);
          if (
            agentId === child.id &&
            event.payload.itemType === "assistant_message" &&
            typeof event.payload.detail === "string"
          )
            child.reply = event.payload.detail.slice(-100_000);
        }
        const projected = yield* decodeRuntimeEvent({
          ...event,
          threadId: child.root,
          turnId: undefined,
          bridgeAgentId: child.id,
          eventId: EventId.make(`${child.id}:${child.generation}:${event.eventId}`),
          ...(event.itemId || event.type === "content.delta"
            ? { itemId: RuntimeItemId.make(itemId) }
            : {}),
          ...(requestId ? { requestId: RuntimeRequestId.make(requestId) } : {}),
          payload,
        }).pipe(Effect.orDie);
        yield* deps.publish(projected);
        if (
          event.type === "item.completed" ||
          event.type === "task.completed" ||
          event.type === "user-input.requested"
        ) {
          const detail =
            "detail" in event.payload && typeof event.payload.detail === "string"
              ? event.payload.detail
              : "summary" in event.payload && typeof event.payload.summary === "string"
                ? event.payload.summary
                : "title" in event.payload && typeof event.payload.title === "string"
                  ? event.payload.title
                  : undefined;
          // Journal in memory only. The record is written at turn boundaries
          // and on stop, close, and resume; writing it per item would rewrite
          // the full context on every tool call.
          if (detail)
            rememberContext(
              child,
              `${agentId === child.id ? "Agent" : agentId}: ${detail.slice(-12_000)}`,
            );
        }
        return true;
      });
    const respond = (
      root: ThreadId,
      requestId: string,
      response: { decision: ProviderApprovalDecision } | { answers: ProviderUserInputAnswers },
    ) =>
      Effect.gen(function* () {
        const route = requests.get(requestId);
        if (!route || route.child.root !== root) return false;
        const child = route.child;
        if (
          child.closed ||
          (route.agentId === child.id &&
            (child.manualStop || child.generation !== route.generation))
        )
          return yield* invalid("This request belongs to a stopped agent.");
        if ("decision" in response)
          yield* child.adapter.respondToRequest(
            child.hiddenId,
            ApprovalRequestId.make(route.nativeId),
            response.decision,
          );
        else if (route.messageMode) {
          if (route.agentId !== child.id)
            return yield* invalid(
              "This provider cannot deliver asynchronous answers to this native subagent individually. No answer was sent to the wrapper.",
            );
          if (child.queue.length >= 32)
            return yield* invalid("The recipient's input queue is full.");
          if (route.answerQueued)
            return yield* invalid("An answer is already queued for this request.");
          route.answerQueued = true;
          const id = yield* uuid;
          if (
            requests.get(requestId) !== route ||
            child.manualStop ||
            child.closed ||
            child.stopping ||
            stoppedTrees.has(root)
          )
            return yield* invalid("The recipient was stopped before the answer could be queued.");
          child.queue.push({
            prompt: `Answers to your question:\n${encodeJson(response.answers)}`,
            id,
            question: { requestId, answers: response.answers },
          });
          yield* schedule(child);
        } else
          yield* child.adapter.respondToUserInput(
            child.hiddenId,
            ApprovalRequestId.make(route.nativeId),
            response.answers,
          );
        return true;
      });
    return {
      targets: (caller: McpInvocationScope) =>
        Effect.gen(function* () {
          const { owner, root } = yield* authorize(caller);
          const source = owner?.adapter.provider ?? (yield* deps.root(root)).session.provider;
          return yield* Effect.forEach(yield* deps.registry.listInstances(), (id) =>
            Effect.gen(function* () {
              const info = yield* deps.registry.getInstanceInfo(id);
              const adapter = yield* deps.registry.getByInstance(id);
              return {
                providerInstanceId: id,
                provider: info.driverKind,
                name: info.displayName,
                available:
                  info.enabled &&
                  info.driverKind !== source &&
                  adapter.capabilities.crossProviderAgents !== false,
                ...(info.driverKind === source
                  ? { reason: "Use native subagent tools for this provider." }
                  : {}),
                delivery: adapter.capabilities.supportsInputSteering ? "steering" : "queued",
                recovery: "durable-agent-id",
              };
            }),
          );
        }),
      spawn,
      send,
      wait,
      control,
      onEvent,
      respond,
      rootMessages: (root: ThreadId) => rootInbox.get(root)?.slice() ?? [],
      confirmRootMessages: (root: ThreadId, ids: ReadonlyArray<string>) => {
        const delivered = new Set(ids);
        const remaining =
          rootInbox.get(root)?.filter((message) => !delivered.has(message.id)) ?? [];
        if (remaining.length) rootInbox.set(root, remaining);
        else rootInbox.delete(root);
      },
      isHidden: (id: ThreadId) => hidden.has(id),
      rootFor: (id: ThreadId) => hidden.get(id)?.root,
      releaseRootStop: (root: ThreadId) => {
        if (!deletedRoots.has(root)) stoppedTrees.delete(root);
      },
      stopTask: (root: ThreadId, taskId: string, resume = false) =>
        Effect.gen(function* () {
          const stopGeneration = stopGenerations.get(root);
          const nativeOwner = [...children.values()].find(
            (child) => child.root === root && taskId.startsWith(`${child.id}:native:`),
          );
          if (nativeOwner) {
            if (resume) return yield* invalid("Native task resume is not supported by the bridge.");
            if (!nativeOwner.adapter.stopTask)
              return yield* invalid("The provider cannot stop this native task individually.");
            yield* nativeOwner.adapter.stopTask(
              nativeOwner.hiddenId,
              taskId.slice(`${nativeOwner.id}:native:`.length),
            );
            return true;
          }
          const child = yield* restore(root, taskId);
          if (!child || child.root !== root) return false;
          if (resume) {
            if (stopGeneration !== stopGenerations.get(root))
              return yield* invalid("Another Stop all occurred while resume was being prepared.");
            yield* activate(child, true);
          } else yield* interrupt(child, true);
          return true;
        }),
      stopTree: (root: ThreadId) => stopTree(root),
      disposeTree: (root: ThreadId) => stopTree(root, true),
      stopInstance: (instance: ProviderInstanceId) =>
        Effect.gen(function* () {
          const owned = [...children.values()].filter((child) => child.instance === instance);
          const selected = owned.filter((child) => !child.closed);
          for (const child of owned) {
            child.manualStop = true;
            child.queue = [];
            child.generation++;
            if (!child.closed) child.stopping = true;
          }
          const failures: string[] = [];
          yield* Effect.all(
            [
              collectControl(
                Effect.forEach(owned, persist, { concurrency: "unbounded", discard: true }),
                failures,
              ),
              Effect.forEach(
                selected,
                (child) =>
                  collectControl(
                    Effect.gen(function* () {
                      yield* child.adapter.stopSession(child.hiddenId);
                      child.closed = true;
                      child.status = "interrupted";
                      if (child.turnId) child.settledTurns.add(child.turnId);
                      child.turnId = undefined;
                      yield* settleNativeRuntime(child);
                      yield* deps.clear(child.hiddenId);
                      child.stopping = false;
                      yield* task(child);
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          child.stopping = false;
                        }),
                      ),
                    ),
                    failures,
                  ),
                { concurrency: "unbounded", discard: true },
              ),
            ],
            { concurrency: "unbounded", discard: true },
          );
          if (failures.length) return yield* invalid(failures.join("\n"));
        }),
      retire: (adapter: Adapter) =>
        Effect.gen(function* () {
          for (const child of children.values()) {
            if (child.adapter !== adapter || child.closed) continue;
            child.closed = true;
            child.status = "interrupted";
            child.queue = [];
            child.turnId = undefined;
            child.generation++;
            yield* settleNativeRuntime(child);
            yield* deps.clear(child.hiddenId);
            yield* task(child);
          }
        }),
    };
  },
);
export type CrossProviderAgentBridge = Effect.Success<
  ReturnType<typeof makeCrossProviderAgentBridge>
>;
