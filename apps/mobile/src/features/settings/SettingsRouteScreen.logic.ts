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

export function resolveLiveActivitySwitchValue(input: {
  readonly liveActivitiesAvailable: boolean;
  readonly pushAvailable: boolean;
  readonly preferenceEnabled: boolean;
}): boolean {
  return input.liveActivitiesAvailable && input.pushAvailable && input.preferenceEnabled;
}
