import Constants from "expo-constants";
import { Platform } from "react-native";
import { supportsAndroidAgentNotifications } from "./androidNotifications";

export function supportsAgentAwarenessPush() {
  return Platform.OS === "android"
    ? supportsAndroidAgentNotifications()
    : Platform.OS === "ios" && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

export function usesPersonalExpoPushAlerts(): boolean {
  return Constants.expoConfig?.extra?.personalExpoPushAlerts === true;
}

export function supportsRemoteAgentAwarenessLiveActivities(): boolean {
  return !usesPersonalExpoPushAlerts() && supportsAgentAwarenessPush();
}
