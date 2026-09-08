import Constants from "expo-constants";

export function supportsAgentAwarenessPush() {
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

export function usesPersonalExpoPushAlerts(): boolean {
  return Constants.expoConfig?.extra?.personalExpoPushAlerts === true;
}

export function supportsRemoteAgentAwarenessLiveActivities(): boolean {
  return !usesPersonalExpoPushAlerts() && supportsAgentAwarenessPush();
}
