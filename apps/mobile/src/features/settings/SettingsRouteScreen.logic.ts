import type { PersonalExpoPushRegistrationStatus } from "../agent-awareness/expoPushRegistration";

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}

export function resolveNotificationSwitchValue(input: {
  readonly pushAvailable: boolean;
  readonly permissionStatus: "checking" | "enabled" | "disabled" | "unsupported";
}): boolean {
  return input.pushAvailable && input.permissionStatus === "enabled";
}

// The switch mirrors the durable iOS permission, so registration failures were
// invisible: a device that never obtained an Expo push token looked identical
// to one receiving alerts. Report that operational state in the subtitle
// instead, where it cannot make an enabled switch appear to turn itself off.
export function resolveNotificationRowSubtitle(input: {
  readonly personalExpoPushAlerts: boolean;
  readonly platformSubtitle: string | undefined;
  readonly permissionStatus: "checking" | "enabled" | "disabled" | "unsupported";
  readonly registrationStatus: PersonalExpoPushRegistrationStatus;
  /** Why this phone has no push token; the one failure the user can act on. */
  readonly tokenError?: string | null;
}): string | undefined {
  if (!input.personalExpoPushAlerts) return input.platformSubtitle;
  if (input.platformSubtitle !== undefined) return input.platformSubtitle;
  if (input.permissionStatus === "checking") return "Checking notification permission.";
  if (input.permissionStatus !== "enabled") {
    return "Turn on to allow alerts from connected environments.";
  }
  if (input.tokenError) {
    return `This build could not get a push token: ${input.tokenError}`;
  }
  switch (input.registrationStatus) {
    case "registered":
      return "Registered with every connected T3 Code environment.";
    case "partial":
      return "Some connected environments could not register this device; retrying.";
    case "failed":
      return "No connected environment accepted this device yet; retrying.";
    case "disabled":
      return "Alerts are off until iOS notification permission is granted.";
    // "pending" also covers "token in hand, but nothing is connected yet",
    // which is a resting state rather than work in progress.
    default:
      return "Waiting to register with a connected environment.";
  }
}

export function resolveLiveActivitySwitchValue(input: {
  readonly liveActivitiesAvailable: boolean;
  readonly pushAvailable: boolean;
  readonly preferenceEnabled: boolean;
}): boolean {
  return input.liveActivitiesAvailable && input.pushAvailable && input.preferenceEnabled;
}

// This build delivers push alerts only. Live Activities need a personal APNs
// relay that it deliberately does not run, so the row must read as unavailable
// rather than as a switch that looks operable.
export function resolveLiveActivityRowSubtitle(input: {
  readonly personalExpoPushAlerts: boolean;
  readonly platformSubtitle: string | undefined;
}): string | undefined {
  if (input.platformSubtitle !== undefined) return input.platformSubtitle;
  return input.personalExpoPushAlerts
    ? "Unavailable in this build, which uses push alerts only."
    : undefined;
}
