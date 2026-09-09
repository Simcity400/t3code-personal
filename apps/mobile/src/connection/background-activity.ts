import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcSubscriptionObserver, request } from "@t3tools/client-runtime/rpc";
import {
  type BackgroundScope,
  type ClientActivityReportInput,
  type EnvironmentId,
  type ExpoPushNotificationRegistration,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";

import * as MobileStorage from "../persistence/mobile-storage";
import {
  observeMobileBackgroundActivitySubscription,
  onRetainedMobileBackgroundScopesChange,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";
import {
  describePersonalExpoPushTokenError,
  isPersonalExpoPushRegistrationAccepted,
  onPersonalExpoPushRegistrationRefresh,
  readPersonalExpoPushRegistration,
  resolvePersonalExpoPushRegistrationStatus,
  setPersonalExpoPushRegistrationStatus,
  setPersonalExpoPushTokenError,
  shouldReassertPersonalExpoPushRegistration,
} from "../features/agent-awareness/expoPushRegistration";

const REPORT_INTERVAL_MS = 25_000;
// An environment can drop a registration without telling us: ExpoPushAlerts
// deletes it on a DeviceNotRegistered ticket, and a restarted server comes back
// holding none. Foregrounding re-asserts everything, but an app left open for
// hours would otherwise keep reporting a registration that no longer exists, so
// the local "already registered" record expires on its own.
const REGISTRATION_REASSERT_INTERVAL_MS = 5 * 60_000;
const LEASE_TTL_MS = 45_000;
const BASELINE_SCOPES: ReadonlyArray<BackgroundScope> = [{ type: "provider-status" }];

function normalizeAppState(
  state: AppStateStatus,
): NonNullable<ClientActivityReportInput["appState"]> {
  if (state === "active" || state === "inactive" || state === "background") return state;
  return "unknown";
}

export const mobileBackgroundActivityObserverLayer = Layer.succeed(
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcSubscriptionObserver.of({
    observe: observeMobileBackgroundActivitySubscription,
  }),
);

export const mobileBackgroundActivityReporterLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const storage = yield* MobileStorage.MobileStorage;
    const clientId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.map((deviceId) => `mobile-${deviceId}`),
      Effect.orElseSucceed(() => "ephemeral-mobile-client"),
    );
    const reportRequests = yield* Queue.sliding<void>(1);
    const requestReport = () => Queue.offerUnsafe(reportRequests, undefined);
    let appState = AppState.currentState;
    let expoPushRegistration: ExpoPushNotificationRegistration | undefined;
    // Bumped by every refresh so an in-flight token read that a refresh has
    // already superseded cannot commit its stale result.
    let expoPushRegistrationGeneration = 0;
    const expoPushRegistrationByEnvironment = new Map<
      EnvironmentId,
      { readonly identity: string; readonly assertedAtMs: number }
    >();

    // The per-environment map records "this server already has this token".
    // Dropping it makes the next pass send the registration to every
    // environment again, which is what a return to the foreground needs: the
    // server may have deleted the registration while the app was away, and
    // keeping the map would let Settings keep reporting "registered".
    const reassertExpoPushRegistrations = () => {
      expoPushRegistrationByEnvironment.clear();
      requestReport();
    };
    const refreshExpoPushRegistration = () => {
      expoPushRegistration = undefined;
      expoPushRegistrationGeneration += 1;
      reassertExpoPushRegistrations();
    };

    const reportPresence = (
      environmentId: EnvironmentId,
      input: { readonly active: boolean; readonly observedAtMs: number },
    ) =>
      registry
        .run(
          environmentId,
          request(WS_METHODS.serverReportClientActivity, {
            environmentId,
            clientId,
            clientKind: "mobile",
            visible: input.active,
            focused: input.active,
            recentlyInteracted: input.active,
            appState: normalizeAppState(appState),
            scopes: [...BASELINE_SCOPES, ...retainedMobileBackgroundScopes(environmentId)],
            ttlMs: LEASE_TTL_MS,
            observedAt: DateTime.makeUnsafe(input.observedAtMs),
          }),
        )
        .pipe(Effect.ignore);

    const report = Effect.gen(function* () {
      const observedAtMs = yield* Clock.currentTimeMillis;
      const active = appState === "active";
      const entries = yield* SubscriptionRef.get(registry.entries);
      // Presence goes out first and never waits on the push-token read below.
      // The server leases visibility-gated streams (sidebar and provider
      // status) off this report, so a slow Expo round-trip in front of it
      // would hold every return to the foreground for up to its timeout.
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) => reportPresence(environmentId as EnvironmentId, { active, observedAtMs }),
        { concurrency: "unbounded", discard: true },
      );
      if (expoPushRegistration === undefined) {
        const generation = expoPushRegistrationGeneration;
        setPersonalExpoPushRegistrationStatus(entries.size > 0 ? "pending" : "unknown");
        const read = yield* Effect.tryPromise({
          try: readPersonalExpoPushRegistration,
          catch: (cause) => cause,
        }).pipe(
          // The token read performs a network round-trip to Expo; without a
          // bound it would stall the whole heartbeat (presence reports, lease
          // reassertions) behind it. A timed-out read leaves the slot empty —
          // the next pass retries it.
          Effect.timeout("5 seconds"),
          Effect.tap(() => Effect.sync(() => setPersonalExpoPushTokenError(null))),
          Effect.tapError((cause) =>
            Effect.sync(() => {
              setPersonalExpoPushTokenError(describePersonalExpoPushTokenError(cause));
              setPersonalExpoPushRegistrationStatus("failed");
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        );
        // A refresh that landed while this read was in flight (a rotated push
        // token, say) already cleared the cache and queued a fresh pass.
        // Committing this now-stale token would swallow that refresh, so leave
        // the slot empty and let the queued pass re-read it.
        if (generation === expoPushRegistrationGeneration) {
          expoPushRegistration = read;
        }
      }
      // Pin the value for the rest of this pass. A foreground, push-token, or
      // Settings refresh can null the shared variable while the per-environment
      // fibers below are suspended on their RPCs; reading it after the yield
      // would hand `undefined` to code that dereferences it, killing the report
      // consumer for the rest of the session. The refresh queues its own report,
      // so the new value is picked up by the next pass.
      const registration = expoPushRegistration;
      const currentEnvironmentIds = new Set(entries.keys());
      for (const environmentId of expoPushRegistrationByEnvironment.keys()) {
        if (!currentEnvironmentIds.has(environmentId)) {
          expoPushRegistrationByEnvironment.delete(environmentId);
        }
      }
      // A saved-but-offline environment is not a registration failure, so it
      // must not count against coverage: `entries` is the connection catalog,
      // not the set of live sockets. Only environments that actually answered
      // form the denominator.
      let reachableExpoEnvironments = 0;
      let successfulExpoRegistrations = 0;
      if (registration === undefined) return;
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          Effect.gen(function* () {
            const registrationIdentity = registration.enabled
              ? `enabled:${registration.token}`
              : "disabled";
            if (
              !shouldReassertPersonalExpoPushRegistration({
                asserted: expoPushRegistrationByEnvironment.get(environmentId),
                identity: registrationIdentity,
                nowMs: observedAtMs,
                reassertIntervalMs: REGISTRATION_REASSERT_INTERVAL_MS,
              })
            ) {
              reachableExpoEnvironments += 1;
              successfulExpoRegistrations += 1;
              return;
            }
            const outcome = yield* registry
              .run(
                environmentId,
                request(WS_METHODS.serverRegisterExpoPushNotifications, {
                  clientId,
                  registration,
                }),
              )
              .pipe(
                Effect.map((value) => ({ answered: true as const, registered: value.registered })),
                // Only a missing session means "not reachable". Every other
                // outcome -- an authorization rejection from a read-only
                // environment, a server error, a defect -- is the environment
                // answering that it will not register this device, so it must
                // show up as a failure instead of quietly leaving the coverage
                // ratio. Absorbing the defect here also stops one bad
                // environment from killing the report consumer.
                Effect.catchTag("EnvironmentRpcUnavailableError", () =>
                  Effect.succeed({ answered: false as const, registered: false }),
                ),
                Effect.catchTag("EnvironmentNotRegisteredError", () =>
                  Effect.succeed({ answered: false as const, registered: false }),
                ),
                Effect.catchCause(() =>
                  Effect.succeed({ answered: true as const, registered: false }),
                ),
              );
            if (!outcome.answered) return;
            reachableExpoEnvironments += 1;
            if (isPersonalExpoPushRegistrationAccepted(registration, outcome)) {
              expoPushRegistrationByEnvironment.set(environmentId, {
                identity: registrationIdentity,
                assertedAtMs: observedAtMs,
              });
              successfulExpoRegistrations += 1;
            }
          }),
        { concurrency: "unbounded", discard: true },
      );
      setPersonalExpoPushRegistrationStatus(
        resolvePersonalExpoPushRegistrationStatus({
          enabled: registration.enabled,
          reachableCount: reachableExpoEnvironments,
          acceptedCount: successfulExpoRegistrations,
        }),
      );
    }).pipe(Effect.withSpan("mobile.backgroundActivity.report"));

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const removeScopeListener = onRetainedMobileBackgroundScopesChange(requestReport);
        const removeRegistrationRefreshListener = onPersonalExpoPushRegistrationRefresh(
          refreshExpoPushRegistration,
        );
        const pushTokenSubscription = Notifications.addPushTokenListener(
          refreshExpoPushRegistration,
        );
        const subscription = AppState.addEventListener("change", (nextState) => {
          appState = nextState;
          // Permission may have changed in iOS Settings while we were away.
          // Refresh it before registering again; presence still goes first.
          if (nextState === "active") {
            refreshExpoPushRegistration();
            return;
          }
          requestReport();
        });
        return {
          removeScopeListener,
          removeRegistrationRefreshListener,
          pushTokenSubscription,
          subscription,
        };
      }),
      ({
        removeScopeListener,
        removeRegistrationRefreshListener,
        pushTokenSubscription,
        subscription,
      }) =>
        Effect.sync(() => {
          removeScopeListener();
          removeRegistrationRefreshListener();
          pushTokenSubscription.remove();
          subscription.remove();
        }),
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach(() => Effect.sync(requestReport)),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(reportRequests).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => report),
      Effect.forkScoped,
    );
    yield* Effect.sync(requestReport).pipe(
      Effect.repeat(Schedule.spaced(`${REPORT_INTERVAL_MS} millis`)),
      Effect.forkScoped,
    );
  }),
);
