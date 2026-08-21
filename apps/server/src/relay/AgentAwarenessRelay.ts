import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  RelayApi,
  type RelayAgentActivityPublishProofPayload,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_ACTIVITY_PUBLISH_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExpoPushAlerts from "../notifications/ExpoPushAlerts.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/AgentAwarenessRelay") {}

export function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") {
    return payload.threadId as ThreadId;
  }
  if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
    return event.aggregateId as ThreadId;
  }
  return null;
}

export function shouldPublishAgentAwarenessEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.turn-start-requested":
      // These events express intent to start work, but the shell still contains
      // the previous turn's terminal state until the provider acknowledges the
      // new turn. Publishing that snapshot can queue a fresh "Done" alert just
      // before the real running state arrives. Provider lifecycle events publish
      // the authoritative starting/running state instead.
      return false;
    case "thread.proposed-plan-upserted":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
      return false;
    case "thread.activity-appended":
      return (
        event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "approval.resolved" ||
        event.payload.activity.kind === "provider.approval.respond.failed" ||
        event.payload.activity.kind === "user-input.requested" ||
        event.payload.activity.kind === "user-input.resolved" ||
        event.payload.activity.kind === "runtime.error"
      );
    default:
      return true;
  }
}

export function agentAwarenessPublishIdentity(state: RelayAgentActivityState | null): string {
  if (state === null) {
    return "null";
  }
  const { updatedAt: _updatedAt, ...meaningfulState } = state;
  return JSON.stringify(meaningfulState);
}

export function resolveAgentAwarenessDeliveryNeeds(input: {
  readonly identity: string;
  readonly relayIdentity: string | undefined;
  readonly expoIdentity: string | undefined;
  readonly canPublishToRelay: boolean;
  readonly hasExpoPushRegistrations: boolean;
}): { readonly relay: boolean; readonly expo: boolean } {
  return {
    relay: input.canPublishToRelay && input.relayIdentity !== input.identity,
    expo: input.hasExpoPushRegistrations && input.expoIdentity !== input.identity,
  };
}

export function isAgentActivityPublishingEnabled(value: string | null): boolean {
  return isAgentActivityPublishingEnabledValue(value);
}

export function resolveAgentActivityPublishingStartupState(input: {
  readonly relayConfigured: boolean;
  readonly publishEnabled: boolean;
}): "waiting-for-link" | "disabled" | "enabled" {
  if (!input.relayConfigured) {
    return "waiting-for-link";
  }
  return input.publishEnabled ? "enabled" : "disabled";
}

const RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH = 160;
const REDACTED_RELAY_AGENT_FAILURE_DETAIL = "The agent run failed.";
// Identity maps are process-lifetime; without a cap they retain one entry per
// thread ever published for the whole server run and the tombstone check pays
// for all of it.
const MAX_PUBLISHED_THREAD_IDENTITIES = 512;
const MAX_EXPO_PUSH_SEND_ATTEMPTS = 3;
const EXPO_PUSH_RETRY_DELAY_MS = 10_000;
// Relay link settings live in the secret store and change rarely; the hot
// per-event publish path reads them through this TTL cache instead of paying
// a secret-file read per orchestration event.
const DELIVERY_CONFIG_CACHE_TTL_MS = 15_000;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function sanitizeRelayAgentActivityState(
  state: RelayAgentActivityState | null,
): RelayAgentActivityState | null {
  if (state === null) {
    return null;
  }
  const { detail: _detail, ...rest } = state;
  const detail = (state.phase === "failed" ? REDACTED_RELAY_AGENT_FAILURE_DETAIL : state.detail)
    ?.trim()
    .slice(0, RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH)
    .trim();
  return detail ? { ...rest, detail } : rest;
}

function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

function deliveryStats(
  deliveries: ReadonlyArray<{
    readonly ok: boolean;
    readonly queued?: boolean | undefined;
    readonly kind: string;
    readonly apnsStatus?: number | null;
    readonly apnsReason?: string | null;
  }>,
) {
  let queued = 0;
  let successful = 0;
  let failed = 0;
  const failedReasons: string[] = [];
  const kinds = new Set<string>();

  for (const delivery of deliveries) {
    kinds.add(delivery.kind);
    if (delivery.queued) {
      queued += 1;
      continue;
    }
    if (delivery.ok) {
      successful += 1;
      continue;
    }
    failed += 1;
    failedReasons.push(`${delivery.apnsStatus ?? "transport"}:${delivery.apnsReason ?? "unknown"}`);
  }

  return {
    total: deliveries.length,
    queued,
    successful,
    failed,
    kinds: [...kinds],
    failedReasons,
  };
}

export function signRelayAgentActivityPublishProof(input: {
  readonly privateKey: string;
  readonly payload: RelayAgentActivityPublishProofPayload;
}) {
  return signRelayJwt({
    privateKey: input.privateKey,
    typ: RELAY_ACTIVITY_PUBLISH_TYP,
    payload: input.payload,
  });
}

const makePublishProof = Effect.fn("makePublishProof")(function* (input: {
  readonly privateKey: string;
  readonly relayIssuer: string;
  readonly environmentId: string;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly jti: string;
}) {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const payload = {
    iss: `t3-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    environmentId: input.environmentId as RelayAgentActivityPublishProofPayload["environmentId"],
    threadId: input.threadId,
    state: input.state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return yield* signRelayAgentActivityPublishProof({ privateKey: input.privateKey, payload });
});

// Compact, log-safe view of the fields the awareness phase ladder reads.
export function describeThreadShellForAwareness(
  thread: Option.Option<OrchestrationThreadShell>,
): Record<string, unknown> {
  if (Option.isNone(thread)) {
    return { found: false };
  }
  const shell = thread.value;
  return {
    found: true,
    sessionStatus: shell.session?.status ?? null,
    sessionActiveTurnId: shell.session?.activeTurnId ?? null,
    latestTurnId: shell.latestTurn?.turnId ?? null,
    latestTurnState: shell.latestTurn?.state ?? null,
    latestTurnCompletedAt: shell.latestTurn?.completedAt ?? null,
    hasPendingApprovals: shell.hasPendingApprovals,
    hasPendingUserInput: shell.hasPendingUserInput,
  };
}

export function resolveAgentAwarenessRelayPublishSnapshot(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: Option.Option<OrchestrationThreadShell>;
  readonly project: Option.Option<OrchestrationProjectShell>;
}): {
  readonly projectId: string | null;
  readonly state: RelayAgentActivityState | null;
  readonly reason: "snapshot" | "thread-not-found" | "project-not-found";
} {
  if (Option.isNone(input.thread)) {
    return {
      projectId: null,
      state: null,
      reason: "thread-not-found",
    };
  }
  if (Option.isNone(input.project)) {
    return {
      projectId: input.thread.value.projectId,
      state: null,
      reason: "project-not-found",
    };
  }
  return {
    projectId: input.thread.value.projectId,
    state: sanitizeRelayAgentActivityState(
      projectThreadAwareness({
        environmentId: input.environmentId,
        project: input.project.value,
        thread: input.thread.value,
      }),
    ),
    reason: "snapshot",
  };
}

export function resolveAgentAwarenessRelayActiveThreadIds(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "title">>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}): ReadonlyArray<ThreadId> {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  return input.threads
    .filter((thread) => {
      const project = projectById.get(thread.projectId);
      if (!project) {
        return false;
      }
      return (
        projectThreadAwareness({
          environmentId: input.environmentId,
          project,
          thread,
        }) !== null
      );
    })
    .map((thread) => thread.id);
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const expoPushAlerts = yield* ExpoPushAlerts.ExpoPushAlerts;
  const crypto = yield* Crypto.Crypto;
  const cloudLinkKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  const activeSnapshotPublishedRef = yield* Ref.make(false);
  const publishedStateByThreadRef = yield* Ref.make(new Map<ThreadId, string>());
  const expoStateByThreadRef = yield* Ref.make(new Map<ThreadId, string>());

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const readRelayConfig = Effect.gen(function* () {
    const [url, issuer, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    return url && environmentCredential
      ? { url, issuer: issuer ?? url, environmentCredential }
      : null;
  });

  const readPublishAgentActivityEnabled = readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET).pipe(
    Effect.map(isAgentActivityPublishingEnabled),
  );

  type DeliveryConfig = {
    readonly publishEnabled: boolean;
    readonly relayConfig: {
      readonly url: string;
      readonly issuer: string;
      readonly environmentCredential: string;
    } | null;
  };
  let deliveryConfigCache: (DeliveryConfig & { readonly at: number }) | null = null;
  const readDeliveryConfigCached: Effect.Effect<DeliveryConfig> = Effect.gen(function* () {
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    if (deliveryConfigCache && nowMs - deliveryConfigCache.at < DELIVERY_CONFIG_CACHE_TTL_MS) {
      return deliveryConfigCache;
    }
    const [publishEnabled, relayConfig] = yield* Effect.all([
      readPublishAgentActivityEnabled.pipe(Effect.orElseSucceed(() => false)),
      readRelayConfig.pipe(Effect.orElseSucceed(() => null)),
    ]);
    const cached = { at: nowMs, publishEnabled, relayConfig };
    deliveryConfigCache = cached;
    return cached;
  });

  const makeRelayClient = (relayConfig: {
    readonly url: string;
    readonly environmentCredential: string;
  }) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  // Deadlines for publishes that need confirmation (tombstones and
  // first-state completions). The confirming publish is re-enqueued through
  // the same drainable worker as every other publish, so a confirmed
  // tombstone can never race an in-flight live update; a recovered state
  // clears the deadline. Assigned after the worker exists.
  const publishConfirmDeadlines = new Map<ThreadId, number>();
  let schedulePublishConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  // Expo send budget per thread, keyed to the identity so each state change
  // gets a fresh budget and cleared on a successful or intentionally
  // suppressed delivery. `nextEligibleAtMs` gates retries by time rather than
  // an in-flight flag: any run (retry timer or ordinary event) that arrives
  // inside the backoff window skips the network, so timer/event interleaving
  // cannot double-send. Guarded by expoDeliveryMutex.
  const expoPushSendAttempts = new Map<
    ThreadId,
    { readonly identity: string; attempts: number; nextEligibleAtMs: number }
  >();
  // Serializes budget read -> network send -> budget write per thread set;
  // without it the worker and a concurrent snapshot publish could both pass
  // the pre-check and undercount attempts.
  const expoDeliveryMutex = Semaphore.makeUnsafe(1);
  let scheduleExpoPushRetry: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const publishThreadUnsafe = Effect.fn("publishThreadUnsafe")(function* (threadId: ThreadId) {
    const deliveryConfig = yield* readDeliveryConfigCached;
    const publishAgentActivity = deliveryConfig.publishEnabled;
    const relayConfig = deliveryConfig.relayConfig;
    const hasExpoPushRegistrations = yield* expoPushAlerts.hasRegistrations;
    const canPublishToRelay = publishAgentActivity && relayConfig !== null;
    if (!canPublishToRelay && !hasExpoPushRegistrations) {
      yield* Effect.logDebug("agent activity publish skipped; no delivery route available", {
        threadId,
        publishAgentActivity,
        relayConfigured: relayConfig !== null,
      });
      return;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;

    const publishState = (input: {
      readonly projectId: string | null;
      readonly state: RelayAgentActivityState | null;
      readonly reason: string;
    }) =>
      Effect.gen(function* () {
        if (relayConfig === null) {
          return;
        }
        const relayClient = yield* makeRelayClient(relayConfig);
        const proof = yield* makePublishProof({
          privateKey: cloudLinkKeyPair.privateKey,
          relayIssuer: relayConfig.issuer,
          environmentId,
          threadId,
          state: input.state,
          jti: yield* crypto.randomUUIDv4,
        });

        yield* Effect.logInfo("publishing agent activity for thread", {
          environmentId,
          threadId,
          projectId: input.projectId,
          statePhase: input.state?.phase ?? null,
          hasState: input.state !== null,
          reason: input.reason,
        });

        const response = yield* relayClient.server.publishAgentActivity({
          params: {
            environmentId,
            threadId,
          },
          payload: {
            state: input.state,
            proof,
          },
        });

        yield* Effect.logInfo("agent activity publish completed", {
          environmentId,
          threadId,
          ok: response.ok,
          deliveries: deliveryStats(response.deliveries),
        });
      });

    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const project = Option.isSome(thread)
      ? yield* snapshotQuery.getProjectShellById(thread.value.projectId)
      : Option.none<OrchestrationProjectShell>();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      threadId,
      thread,
      project,
    });
    const publishIdentity = agentAwarenessPublishIdentity(snapshot.state);
    const publishedStateByThread = yield* Ref.get(publishedStateByThreadRef);
    const expoStateByThread = yield* Ref.get(expoStateByThreadRef);
    const deliveryNeeds = resolveAgentAwarenessDeliveryNeeds({
      identity: publishIdentity,
      relayIdentity: publishedStateByThread.get(threadId),
      expoIdentity: expoStateByThread.get(threadId),
      canPublishToRelay,
      hasExpoPushRegistrations,
    });
    if (!deliveryNeeds.relay && !deliveryNeeds.expo) {
      // The projection is back at (or never left) the last published state, so
      // any pending deferred confirmation is moot. Leaving the deadline in
      // place would let a much later transient null find it already expired
      // and publish a tombstone immediately, skipping the deferral window.
      publishConfirmDeadlines.delete(threadId);
      yield* Effect.logDebug("agent activity publish skipped; projected state unchanged", {
        environmentId,
        threadId,
        reason: snapshot.reason,
      });
      return;
    }

    // Two projections need confirmation before publishing, because both can
    // appear transiently while the projector is mid-write and publishing them
    // immediately is destructive or noisy:
    // - null (tombstone) while the previous published state was live: deletes
    //   the thread from every armed card mid-conversation.
    // - completed as the thread's FIRST published state: sessions boot at
    //   "ready" before their first turn, which projects as completed for an
    //   instant and sends a spurious Done notification at thread birth.
    // Defer, schedule a re-publish through the ordinary worker queue, and
    // only publish if the projection still holds when it drains.
    const tombstoneIdentity = agentAwarenessPublishIdentity(null);
    const publishedIdentityForThread = publishedStateByThread.get(threadId);
    const expoIdentityForThread = expoStateByThread.get(threadId);
    const requiresConfirmation =
      (snapshot.state === null &&
        ((publishedIdentityForThread !== undefined &&
          publishedIdentityForThread !== tombstoneIdentity) ||
          (expoIdentityForThread !== undefined && expoIdentityForThread !== tombstoneIdentity))) ||
      (snapshot.state?.phase === "completed" &&
        publishedIdentityForThread === undefined &&
        expoIdentityForThread === undefined);
    if (requiresConfirmation) {
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const deadline = publishConfirmDeadlines.get(threadId);
      if (deadline === undefined) {
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Effect.logInfo("agent activity publish deferred pending confirmation", {
          environmentId,
          threadId,
          reason: snapshot.reason,
          statePhase: snapshot.state?.phase ?? null,
          shell: describeThreadShellForAwareness(thread),
        });
        yield* schedulePublishConfirm(threadId);
        return;
      }
      if (nowMs < deadline) {
        return;
      }
      publishConfirmDeadlines.delete(threadId);
      yield* Effect.logInfo("agent activity deferred publish confirmed", {
        environmentId,
        threadId,
        reason: snapshot.reason,
        statePhase: snapshot.state?.phase ?? null,
        shell: describeThreadShellForAwareness(thread),
      });
    } else {
      publishConfirmDeadlines.delete(threadId);
    }

    if (snapshot.reason === "thread-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; thread not found", {
        environmentId,
        threadId,
      });
    } else if (snapshot.reason === "project-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; project not found", {
        environmentId,
        threadId,
        projectId: snapshot.projectId,
      });
    }

    if (deliveryNeeds.relay) {
      yield* publishState({
        projectId: snapshot.projectId,
        state: snapshot.state,
        reason: snapshot.reason,
      }).pipe(
        Effect.tap(() =>
          Ref.update(publishedStateByThreadRef, (publishedStates) => {
            const nextPublishedStates = new Map(publishedStates);
            setBounded(
              nextPublishedStates,
              threadId,
              publishIdentity,
              MAX_PUBLISHED_THREAD_IDENTITIES,
            );
            return nextPublishedStates;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("hosted agent activity publish failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    if (deliveryNeeds.expo) {
      yield* expoDeliveryMutex.withPermit(
        Effect.gen(function* () {
          const nowMs = (yield* DateTime.now).epochMilliseconds;
          // Budget is checked BEFORE sending: an exhausted identity skips the
          // network entirely, and inside the backoff window the queued retry
          // is the send attempt — other runs must not fire their own request
          // on top of it.
          const recorded = expoPushSendAttempts.get(threadId);
          const attempts = recorded?.identity === publishIdentity ? recorded.attempts : 0;
          const eligibleAtMs =
            recorded?.identity === publishIdentity ? recorded.nextEligibleAtMs : 0;
          if (attempts >= MAX_EXPO_PUSH_SEND_ATTEMPTS) {
            yield* Effect.logWarning("personal Expo push alert gave up after retries", {
              threadId,
              phase: snapshot.state?.phase ?? null,
            });
            return;
          }
          if (nowMs < eligibleAtMs) {
            yield* Effect.logDebug("personal Expo push alert deferred to queued retry", {
              threadId,
              phase: snapshot.state?.phase ?? null,
            });
            return;
          }
          const outcome = yield* expoPushAlerts.publish({ threadId, state: snapshot.state });
          if (outcome === "sent" || outcome === "suppressed") {
            expoPushSendAttempts.delete(threadId);
            yield* Ref.update(expoStateByThreadRef, (publishedStates) => {
              const nextPublishedStates = new Map(publishedStates);
              setBounded(
                nextPublishedStates,
                threadId,
                publishIdentity,
                MAX_PUBLISHED_THREAD_IDENTITIES,
              );
              return nextPublishedStates;
            });
            return;
          }
          // Nothing reached a device. Leave the identity unrecorded so the
          // state stays eligible for delivery, back off, and re-enqueue
          // through the ordinary worker — bounded per state change. The
          // backoff is stamped from AFTER the failed send: the request
          // itself can hold the mutex (and the clock reading above) for up
          // to ten seconds.
          const failedAtMs = (yield* DateTime.now).epochMilliseconds;
          setBounded(
            expoPushSendAttempts,
            threadId,
            {
              identity: publishIdentity,
              attempts: attempts + 1,
              nextEligibleAtMs: failedAtMs + EXPO_PUSH_RETRY_DELAY_MS,
            },
            MAX_PUBLISHED_THREAD_IDENTITIES,
          );
          yield* scheduleExpoPushRetry(threadId);
        }),
      );
    }
  });

  const publishThread: AgentAwarenessRelay["Service"]["publishThread"] = (threadId) =>
    publishThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) => {
        return Effect.logWarning("agent activity publish failed", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
      Effect.withSpan("AgentAwarenessRelay.publishThread"),
      withRelayClientTracing,
    );

  const publishActiveThreadsUnsafe = Effect.gen(function* () {
    const publishAgentActivity = yield* readPublishAgentActivityEnabled.pipe(
      Effect.orElseSucceed(() => false),
    );
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    const hasExpoPushRegistrations = yield* expoPushAlerts.hasRegistrations;
    if ((!publishAgentActivity || !relayConfig) && !hasExpoPushRegistrations) {
      yield* Effect.logDebug("agent activity snapshot skipped; no delivery route available");
      return { relay: false, expo: false };
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const activeThreadIds = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId,
      projects: snapshot.projects,
      threads: snapshot.threads,
    });
    if (activeThreadIds.length === 0) {
      yield* Effect.logDebug("agent activity snapshot has no publishable threads");
      return {
        relay: publishAgentActivity && relayConfig !== null,
        expo: hasExpoPushRegistrations,
      };
    }
    yield* Effect.logInfo("publishing active agent activity snapshot", {
      count: activeThreadIds.length,
    });
    yield* Effect.forEach(activeThreadIds, publishThread, { concurrency: 4, discard: true });
    return {
      relay: publishAgentActivity && relayConfig !== null,
      expo: hasExpoPushRegistrations,
    };
  });

  const publishActiveThreadsOnceWhenConfigured = (logEnabledWhenReady: boolean) =>
    Effect.gen(function* () {
      while (!(yield* Ref.get(activeSnapshotPublishedRef))) {
        const [publishEnabled, relayConfig] = yield* Effect.all([
          readPublishAgentActivityEnabled.pipe(Effect.orElseSucceed(() => false)),
          readRelayConfig.pipe(Effect.orElseSucceed(() => null)),
        ]);
        const relayReady = publishEnabled && relayConfig !== null;
        if (relayReady) {
          const published = yield* publishActiveThreadsUnsafe.pipe(
            Effect.orElseSucceed(() => ({ relay: false, expo: false })),
          );
          if (published.relay) {
            yield* Ref.set(activeSnapshotPublishedRef, true);
          }
        }
        if (yield* Ref.get(activeSnapshotPublishedRef)) {
          if (logEnabledWhenReady) {
            yield* Effect.logInfo("agent activity publishing enabled after link reconciliation", {
              relayUrl: relayConfig?.url,
            });
          }
          return;
        }
        yield* Effect.sleep("5 seconds");
      }
    });

  const publishExpoActiveThreadsWhenRegistered = expoPushAlerts.registrationChanges.pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        if (!(yield* expoPushAlerts.hasRegistrations)) {
          return;
        }
        const published = yield* publishActiveThreadsUnsafe.pipe(
          Effect.orElseSucceed(() => ({ relay: false, expo: false })),
        );
        if (published.relay) {
          yield* Ref.set(activeSnapshotPublishedRef, true);
        }
      }),
    ),
  );

  const worker = yield* makeDrainableWorker(publishThread);

  schedulePublishConfirm = (threadId) =>
    Effect.forkDetach(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("deferred agent activity confirmation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  scheduleExpoPushRetry = (threadId) =>
    Effect.forkDetach(
      Effect.sleep(`${EXPO_PUSH_RETRY_DELAY_MS} millis`).pipe(
        // Eligibility is time-gated via nextEligibleAtMs, so extra enqueued
        // runs (timer + event racing) hit the backoff branch harmlessly.
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("deferred Expo push retry failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const start: AgentAwarenessRelay["Service"]["start"] = Effect.fn("AgentAwarenessRelay.start")(
    function* () {
      const [relayConfig, publishEnabled] = yield* Effect.all([
        readRelayConfig.pipe(Effect.orElseSucceed(() => null)),
        readPublishAgentActivityEnabled.pipe(Effect.orElseSucceed(() => false)),
      ]);
      const startupState = resolveAgentActivityPublishingStartupState({
        relayConfigured: relayConfig !== null,
        publishEnabled,
      });
      switch (startupState) {
        case "waiting-for-link":
          yield* Effect.logInfo(
            "agent activity publishing standby; waiting for T3 Connect link reconciliation",
          );
          break;
        case "disabled":
          yield* Effect.logInfo("agent activity publishing disabled by T3 Connect configuration");
          break;
        case "enabled":
          yield* Effect.logInfo("agent activity publishing enabled", {
            relayUrl: relayConfig?.url,
          });
          break;
      }
      yield* forkParked(
        Effect.sleep("1 second").pipe(
          Effect.andThen(publishActiveThreadsOnceWhenConfigured(startupState !== "enabled")),
        ),
      );
      yield* forkParked(publishExpoActiveThreadsWhenRegistered);
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          const threadId = eventThreadId(event);
          if (threadId === null) {
            return Effect.logDebug("agent activity publishing ignored event without thread id", {
              eventType: event.type,
            });
          }
          if (!shouldPublishAgentAwarenessEvent(event)) {
            return Effect.logDebug(
              "agent activity publishing ignored event without activity changes",
              {
                eventType: event.type,
                threadId,
              },
            );
          }
          return Effect.logDebug("agent activity publishing queued thread publish", {
            eventType: event.type,
            threadId,
          }).pipe(Effect.andThen(worker.enqueue(threadId)));
        }),
      );
    },
  );

  return AgentAwarenessRelay.of({
    publishThread,
    start,
  });
});

export const layer = Layer.effect(AgentAwarenessRelay, make).pipe(
  Layer.provide(ExpoPushAlerts.layer.pipe(Layer.provide(FetchHttpClient.layer))),
);
