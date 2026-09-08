import { describe, expect, it } from "vite-plus/test";

import { resolvePersonalExpoPushAlerts } from "./personal-expo-push-alerts.ts";

describe("resolvePersonalExpoPushAlerts", () => {
  // The bug this guards: every locally published OTA shipped
  // extra.personalExpoPushAlerts=false because the publisher never exported
  // T3CODE_EXPO_PUSH_ALERTS, so the app never requested an Expo push token and
  // no alert could ever arrive. The preview variant is the personal build, so
  // omitting the variable must not disable the feature.
  it("keeps the personal preview on when nothing sets the environment variable", () => {
    expect(resolvePersonalExpoPushAlerts("preview", undefined)).toBe(true);
    expect(resolvePersonalExpoPushAlerts("preview", "")).toBe(true);
  });

  it("honours an explicit opt-out and an explicit opt-in", () => {
    expect(resolvePersonalExpoPushAlerts("preview", "0")).toBe(false);
    expect(resolvePersonalExpoPushAlerts("production", "1")).toBe(true);
    expect(resolvePersonalExpoPushAlerts("development", "1")).toBe(true);
  });

  it("leaves the relay-based variants off by default", () => {
    expect(resolvePersonalExpoPushAlerts("production", undefined)).toBe(false);
    expect(resolvePersonalExpoPushAlerts("development", undefined)).toBe(false);
  });
});
