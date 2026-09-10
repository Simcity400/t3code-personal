import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveLiveActivityRowSubtitle,
  resolveLiveActivitySwitchValue,
  resolveNotificationRowSubtitle,
  resolveNotificationSwitchValue,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("supports agent awareness settings on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("agent awareness switch values", () => {
  it("keeps notifications visibly enabled from the durable iOS permission", () => {
    expect(
      resolveNotificationSwitchValue({
        pushAvailable: true,
        permissionStatus: "enabled",
      }),
    ).toBe(true);
  });

  it("reflects the saved Live Activity preference independently of transient registration", () => {
    expect(
      resolveLiveActivitySwitchValue({
        liveActivitiesAvailable: true,
        pushAvailable: true,
        preferenceEnabled: true,
      }),
    ).toBe(true);
    expect(
      resolveLiveActivitySwitchValue({
        liveActivitiesAvailable: false,
        pushAvailable: true,
        preferenceEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("resolveNotificationRowSubtitle", () => {
  const base = {
    personalExpoPushAlerts: true,
    platformSubtitle: undefined,
    permissionStatus: "enabled",
  } as const;

  it("tells a never-run reporter apart from an unanswered registration", () => {
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "unknown" })).toBe(
      "Registration has not run yet. Reopen the app with an environment connected.",
    );
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "pending" })).toBe(
      "Waiting to register with a connected environment.",
    );
  });

  it("says per environment why registration is still waiting", () => {
    expect(
      resolveNotificationRowSubtitle({
        ...base,
        registrationStatus: "pending",
        environmentDetails: [
          { label: "Home PC", reason: "not connected" },
          { label: "Office", reason: "did not answer within 15 seconds" },
        ],
      }),
    ).toBe(
      "Waiting to register with a connected environment. Home PC: not connected; Office: did not answer within 15 seconds.",
    );
  });

  it("names the push token error ahead of any registration state", () => {
    expect(
      resolveNotificationRowSubtitle({
        ...base,
        registrationStatus: "failed",
        tokenError: "No APNs entitlement",
      }),
    ).toBe("This build could not get a push token: No APNs entitlement");
    expect(
      resolveNotificationRowSubtitle({ ...base, registrationStatus: "failed", tokenError: null }),
    ).toBe("No connected environment accepted this device yet; retrying.");
  });

  it("reports the push registration state the permission switch cannot show", () => {
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "registered" })).toBe(
      "Registered with every connected T3 Code environment.",
    );
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "failed" })).toBe(
      "No connected environment accepted this device yet; retrying.",
    );
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "disabled" })).toBe(
      "Alerts are off until iOS notification permission is granted.",
    );
  });

  // Each environment pushes on its own, so one success is not full coverage.
  it("distinguishes partial coverage from full registration", () => {
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "partial" })).toBe(
      "Some connected environments could not register this device; retrying.",
    );
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "partial" })).not.toBe(
      resolveNotificationRowSubtitle({ ...base, registrationStatus: "registered" }),
    );
  });

  // "pending" also means "token in hand, nothing connected yet", which never
  // resolves on its own -- the copy must not imply work is in progress.
  it("does not claim registration is in progress while nothing is connected", () => {
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "pending" })).toBe(
      "Waiting to register with a connected environment.",
    );
    expect(resolveNotificationRowSubtitle({ ...base, registrationStatus: "unknown" })).toBe(
      "Registration has not run yet. Reopen the app with an environment connected.",
    );
  });

  it("explains permission before registration and keeps the platform notice first", () => {
    expect(
      resolveNotificationRowSubtitle({
        ...base,
        permissionStatus: "disabled",
        registrationStatus: "registered",
      }),
    ).toBe("Turn on to allow alerts from connected environments.");
    expect(
      resolveNotificationRowSubtitle({
        ...base,
        platformSubtitle: "iOS only",
        registrationStatus: "registered",
      }),
    ).toBe("iOS only");
  });

  it("leaves relay builds on their platform subtitle", () => {
    expect(
      resolveNotificationRowSubtitle({
        personalExpoPushAlerts: false,
        platformSubtitle: undefined,
        permissionStatus: "enabled",
        registrationStatus: "failed",
      }),
    ).toBeUndefined();
  });
});

describe("resolveLiveActivityRowSubtitle", () => {
  it("marks Live Activities unavailable in the push-alerts-only build", () => {
    expect(
      resolveLiveActivityRowSubtitle({
        personalExpoPushAlerts: true,
        platformSubtitle: undefined,
      }),
    ).toBe("Unavailable in this build, which uses push alerts only.");
    expect(
      resolveLiveActivityRowSubtitle({
        personalExpoPushAlerts: false,
        platformSubtitle: undefined,
      }),
    ).toBeUndefined();
  });

  it("never shows an operable-looking Live Activity switch alongside push alerts", () => {
    // supportsRemoteAgentAwarenessLiveActivities() is false whenever the
    // personal push-alert route is on, which both disables the row and forces
    // the switch off regardless of the stored preference.
    expect(
      resolveLiveActivitySwitchValue({
        liveActivitiesAvailable: false,
        pushAvailable: true,
        preferenceEnabled: true,
      }),
    ).toBe(false);
  });
});
