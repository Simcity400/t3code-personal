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
import * as Option from "effect/Option";
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
  isPersonalExpoPushRegistrationAccepted,
  onPersonalExpoPushRegistrationRefresh,
  readPersonalExpoPushRegistration,
  setPersonalExpoPushRegistrationStatus,
} from "../features/agent-awareness/expoPushRegistration";

const REPORT_INTERVAL_MS = 25_000;
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
    const expoPushRegistrationByEnvironment = new Map<EnvironmentId, string>();

    const refreshExpoPushRegistration = () => {
      expoPushRegistration = undefined;
      requestReport();
    };

    const report = Effect.gen(function* () {
      const observedAtMs = yield* Clock.currentTimeMillis;
      const active = appState === "active";
      const entries = yield* SubscriptionRef.get(registry.entries);
      if (expoPushRegistration === undefined) {
        setPersonalExpoPushRegistrationStatus(entries.size > 0 ? "pending" : "unknown");
        expoPushRegistration = yield* Effect.tryPromise({
          try: readPersonalExpoPushRegistration,
          catch: (cause) => cause,
        }).pipe(
          Effect.tapError(() => Effect.sync(() => setPersonalExpoPushRegistrationStatus("failed"))),
          Effect.orElseSucceed(() => undefined),
        );
      }
      const currentEnvironmentIds = new Set(entries.keys());
      for (const environmentId of expoPushRegistrationByEnvironment.keys()) {
        if (!currentEnvironmentIds.has(environmentId)) {
          expoPushRegistrationByEnvironment.delete(environmentId);
        }
      }
      let successfulExpoRegistrations = 0;
      yield* Effect.forEach(
        entries.keys(),
        (environmentId) =>
          Effect.gen(function* () {
            yield* registry
              .run(
                environmentId,
                request(WS_METHODS.serverReportClientActivity, {
                  environmentId: environmentId as EnvironmentId,
                  clientId,
                  clientKind: "mobile",
                  visible: active,
                  focused: active,
                  recentlyInteracted: active,
                  appState: normalizeAppState(appState),
                  scopes: [
                    ...BASELINE_SCOPES,
                    ...retainedMobileBackgroundScopes(environmentId as EnvironmentId),
                  ],
                  ttlMs: LEASE_TTL_MS,
                  observedAt: DateTime.makeUnsafe(observedAtMs),
                }),
              )
              .pipe(Effect.ignore);
            if (expoPushRegistration === undefined) return;
            const registrationIdentity = expoPushRegistration.enabled
              ? `enabled:${expoPushRegistration.token}`
              : "disabled";
            if (expoPushRegistrationByEnvironment.get(environmentId) === registrationIdentity) {
              successfulExpoRegistrations += 1;
              return;
            }
            const result = yield* registry
              .run(
                environmentId,
                request(WS_METHODS.serverRegisterExpoPushNotifications, {
                  clientId,
                  registration: expoPushRegistration,
                }),
              )
              .pipe(Effect.option);
            if (
              Option.isSome(result) &&
              isPersonalExpoPushRegistrationAccepted(expoPushRegistration, result.value)
            ) {
              expoPushRegistrationByEnvironment.set(environmentId, registrationIdentity);
              successfulExpoRegistrations += 1;
            }
          }),
        { concurrency: "unbounded", discard: true },
      );
      if (expoPushRegistration !== undefined) {
        setPersonalExpoPushRegistrationStatus(
          expoPushRegistration.enabled
            ? successfulExpoRegistrations > 0
              ? "registered"
              : entries.size > 0
                ? "failed"
                : "pending"
            : "disabled",
        );
      }
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
          if (nextState === "active") expoPushRegistration = undefined;
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
