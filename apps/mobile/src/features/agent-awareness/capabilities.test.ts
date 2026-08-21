import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Constants from "expo-constants";

import {
  supportsAgentAwarenessPush,
  supportsRemoteAgentAwarenessLiveActivities,
  usesPersonalExpoPushAlerts,
} from "./capabilities";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

beforeEach(() => {
  Constants.expoConfig!.extra = {};
});

describe("agent awareness capabilities", () => {
  // The personal build delivers push alerts only. Live Activities need an APNs
  // relay it deliberately does not run, so turning the push-alert route on must
  // be what switches remote Live Activities off -- not a separate flag that
  // could drift out of sync with it.
  it("turns remote Live Activities off exactly when personal push alerts are on", () => {
    Constants.expoConfig!.extra = { personalExpoPushAlerts: true };
    expect(usesPersonalExpoPushAlerts()).toBe(true);
    expect(supportsAgentAwarenessPush()).toBe(true);
    expect(supportsRemoteAgentAwarenessLiveActivities()).toBe(false);

    Constants.expoConfig!.extra = {};
    expect(usesPersonalExpoPushAlerts()).toBe(false);
    expect(supportsRemoteAgentAwarenessLiveActivities()).toBe(true);
  });

  it("keeps push features off entirely in a Personal Team build", () => {
    Constants.expoConfig!.extra = { iosPersonalTeamBuild: true };
    expect(supportsAgentAwarenessPush()).toBe(false);
    expect(supportsRemoteAgentAwarenessLiveActivities()).toBe(false);
  });
});
