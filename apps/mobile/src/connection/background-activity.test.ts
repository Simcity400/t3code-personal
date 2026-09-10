import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  WS_METHODS,
  type ExpoPushNotificationRegistration,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { MobileStorage } from "../persistence/mobile-storage";
import { mobileBackgroundActivityReporterLayer } from "./background-activity";
import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

const native = vi.hoisted(() => ({
  permissionGranted: false,
  onAppState: (_state: string) => {},
  onRegistration: (_registration: ExpoPushNotificationRegistration) => {},
}));

// The capability probe reaches the expo package root, whose setup reads __DEV__.
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.onAppState = listener;
      return { remove: () => {} };
    },
  },
}));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { personalExpoPushAlerts: true, eas: { projectId: "test" } } } },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: () => Promise.resolve({ granted: native.permissionGranted }),
  getExpoPushTokenAsync: () => Promise.resolve({ data: "ExponentPushToken[phone]" }),
  addPushTokenListener: () => ({ remove: () => {} }),
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("@t3tools/client-runtime/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/rpc")>();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    request: (_method: string, input: { registration?: ExpoPushNotificationRegistration }) =>
      Effect.sync(() => {
        if (input.registration) native.onRegistration(input.registration);
        return { registered: input.registration?.enabled === true };
      }),
  };
});

it.effect("refreshes registration when notification permission changes in iOS Settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      native.permissionGranted = false;
      const registrations = yield* Queue.unbounded<ExpoPushNotificationRegistration>();
      native.onRegistration = (registration) => {
        Queue.offerUnsafe(registrations, registration);
      };
      const entries = yield* SubscriptionRef.make(new Map([[EnvironmentId.make("test"), {}]]));
      yield* Layer.build(mobileBackgroundActivityReporterLayer).pipe(
        Effect.provideService(EnvironmentRegistry, {
          entries,
          run: <A, E, R>(_environmentId: EnvironmentId, operation: Effect.Effect<A, E, R>) =>
            operation,
        } as unknown as EnvironmentRegistry["Service"]),
        Effect.provideService(MobileStorage, {
          loadOrCreateAgentAwarenessDeviceId: Effect.succeed("phone"),
        } as unknown as MobileStorage["Service"]),
      );
      yield* TestClock.adjust("250 millis");
      expect(yield* Queue.take(registrations)).toEqual({ enabled: false });

      native.onAppState("background");
      native.permissionGranted = true;
      native.onAppState("active");
      yield* TestClock.adjust("250 millis");
      expect(yield* Queue.take(registrations)).toEqual({
        enabled: true,
        token: "ExponentPushToken[phone]",
      });

      native.onAppState("background");
      native.permissionGranted = false;
      native.onAppState("active");
      yield* TestClock.adjust("250 millis");
      expect(yield* Queue.take(registrations)).toEqual({ enabled: false });
    }),
  ),
);

describe("mobile background activity", () => {
  it.effect("retains VCS demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedMobileBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedMobileBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );

  it.effect("returns a release handle when a retained-scope listener throws", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("throwing-listener-environment");
      const removeListener = onRetainedMobileBackgroundScopesChange(() => {
        throw new Error("listener failed");
      });

      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      removeListener();
    }),
  );
});
