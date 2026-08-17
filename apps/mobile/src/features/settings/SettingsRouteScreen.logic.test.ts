import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveLiveActivitySwitchValue,
  resolveNotificationSwitchValue,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
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
