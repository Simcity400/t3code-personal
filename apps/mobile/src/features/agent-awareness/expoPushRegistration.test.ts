import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Notifications from "expo-notifications";

import {
  __resetPersonalExpoPushRegistrationForTest,
  getPersonalExpoPushRegistrationStatus,
  describePersonalExpoPushTokenError,
  isPersonalExpoPushRegistrationAccepted,
  readPersonalExpoPushRegistration,
  requestPersonalExpoPushRegistrationRefresh,
  resolvePersonalExpoPushRegistrationStatus,
  shouldReassertPersonalExpoPushRegistration,
  setPersonalExpoPushRegistrationStatus,
  subscribePersonalExpoPushRegistrationStatus,
  onPersonalExpoPushRegistrationRefresh,
} from "./expoPushRegistration";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        personalExpoPushAlerts: true,
        eas: { projectId: "personal-project" },
      },
    },
  },
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  getExpoPushTokenAsync: vi.fn(() =>
    Promise.resolve({ type: "expo", data: "ExponentPushToken[personal]" }),
  ),
}));

// The capability probe reaches the expo package root, whose setup reads __DEV__.
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

beforeEach(() => {
  __resetPersonalExpoPushRegistrationForTest();
  vi.clearAllMocks();
});

describe("personal Expo push registration", () => {
  it("reads the project-scoped Expo token after notification permission is granted", async () => {
    await expect(readPersonalExpoPushRegistration()).resolves.toEqual({
      enabled: true,
      token: "ExponentPushToken[personal]",
    });
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: "personal-project",
    });
  });

  it("turns token read failures into one actionable line", () => {
    expect(
      describePersonalExpoPushTokenError(new Error("  No 'aps-environment'  entitlement ")),
    ).toBe("No 'aps-environment' entitlement");
    expect(describePersonalExpoPushTokenError({ _tag: "TimeoutError" })).toBe(
      "Expo did not answer within 5 seconds",
    );
    expect(describePersonalExpoPushTokenError("")).toBe("Unknown error");
    expect(describePersonalExpoPushTokenError("x".repeat(200))).toHaveLength(160);
  });

  it("returns an explicit disabled registration when permission is off", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
      granted: false,
    } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
    await expect(readPersonalExpoPushRegistration()).resolves.toEqual({ enabled: false });
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("publishes status and refresh changes to subscribers", () => {
    const statusListener = vi.fn();
    const refreshListener = vi.fn();
    const removeStatus = subscribePersonalExpoPushRegistrationStatus(statusListener);
    const removeRefresh = onPersonalExpoPushRegistrationRefresh(refreshListener);

    setPersonalExpoPushRegistrationStatus("registered");
    requestPersonalExpoPushRegistrationRefresh();
    expect(getPersonalExpoPushRegistrationStatus()).toBe("registered");
    expect(statusListener).toHaveBeenCalledTimes(1);
    expect(refreshListener).toHaveBeenCalledTimes(1);

    removeStatus();
    removeRefresh();
  });

  it("accepts only acknowledgements matching the requested registration state", () => {
    expect(
      isPersonalExpoPushRegistrationAccepted(
        { enabled: true, token: "ExponentPushToken[personal]" },
        { registered: true },
      ),
    ).toBe(true);
    expect(
      isPersonalExpoPushRegistrationAccepted(
        { enabled: true, token: "ExponentPushToken[personal]" },
        { registered: false },
      ),
    ).toBe(false);
    expect(isPersonalExpoPushRegistrationAccepted({ enabled: false }, { registered: false })).toBe(
      true,
    );
  });

  it("only reports full registration when every connected environment accepted", () => {
    // Each environment sends its own pushes, so one acceptance out of two means
    // the user silently misses alerts from the other one.
    expect(
      resolvePersonalExpoPushRegistrationStatus({
        enabled: true,
        reachableCount: 2,
        acceptedCount: 1,
      }),
    ).toBe("partial");
    expect(
      resolvePersonalExpoPushRegistrationStatus({
        enabled: true,
        reachableCount: 2,
        acceptedCount: 2,
      }),
    ).toBe("registered");
    expect(
      resolvePersonalExpoPushRegistrationStatus({
        enabled: true,
        reachableCount: 2,
        acceptedCount: 0,
      }),
    ).toBe("failed");
  });

  it("re-asserts a registration a server may have silently dropped", () => {
    const identity = "enabled:ExponentPushToken[personal]";
    const interval = 5 * 60_000;

    // Nothing recorded, or a different token: always send.
    expect(
      shouldReassertPersonalExpoPushRegistration({
        asserted: undefined,
        identity,
        nowMs: 1_000,
        reassertIntervalMs: interval,
      }),
    ).toBe(true);
    expect(
      shouldReassertPersonalExpoPushRegistration({
        asserted: { identity: "enabled:ExponentPushToken[old]", assertedAtMs: 1_000 },
        identity,
        nowMs: 2_000,
        reassertIntervalMs: interval,
      }),
    ).toBe(true);

    // Recorded recently: trust it and skip the round trip.
    expect(
      shouldReassertPersonalExpoPushRegistration({
        asserted: { identity, assertedAtMs: 1_000 },
        identity,
        nowMs: 1_000 + interval - 1,
        reassertIntervalMs: interval,
      }),
    ).toBe(false);

    // Older than the interval: the server may have dropped it (a
    // DeviceNotRegistered ticket, or a restart), so prove it again rather than
    // keep telling the user alerts work.
    expect(
      shouldReassertPersonalExpoPushRegistration({
        asserted: { identity, assertedAtMs: 1_000 },
        identity,
        nowMs: 1_000 + interval,
        reassertIntervalMs: interval,
      }),
    ).toBe(true);

    // A backwards clock must not hand out an unbounded lease.
    expect(
      shouldReassertPersonalExpoPushRegistration({
        asserted: { identity, assertedAtMs: 10_000 },
        identity,
        nowMs: 1_000,
        reassertIntervalMs: interval,
      }),
    ).toBe(true);
  });

  it("treats an unreachable environment as waiting, not as a failure", () => {
    // Every saved environment stays in the connection catalog while offline,
    // so an offline-only device must read as waiting rather than failed.
    expect(
      resolvePersonalExpoPushRegistrationStatus({
        enabled: true,
        reachableCount: 0,
        acceptedCount: 0,
      }),
    ).toBe("pending");
    expect(
      resolvePersonalExpoPushRegistrationStatus({
        enabled: false,
        reachableCount: 2,
        acceptedCount: 2,
      }),
    ).toBe("disabled");
  });
});
