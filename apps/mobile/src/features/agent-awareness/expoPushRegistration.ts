import type { ExpoPushNotificationRegistration } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { usesPersonalExpoPushAlerts } from "./capabilities";

export type PersonalExpoPushRegistrationStatus =
  | "unknown"
  | "pending"
  | "registered"
  | "disabled"
  | "failed";

let status: PersonalExpoPushRegistrationStatus = "unknown";
const statusListeners = new Set<() => void>();
const refreshListeners = new Set<() => void>();

export function getPersonalExpoPushRegistrationStatus(): PersonalExpoPushRegistrationStatus {
  return status;
}

export function subscribePersonalExpoPushRegistrationStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function setPersonalExpoPushRegistrationStatus(
  next: PersonalExpoPushRegistrationStatus,
): void {
  if (status === next) return;
  status = next;
  statusListeners.forEach((listener) => listener());
}

export function onPersonalExpoPushRegistrationRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

export function requestPersonalExpoPushRegistrationRefresh(): void {
  refreshListeners.forEach((listener) => listener());
}

export function isPersonalExpoPushRegistrationAccepted(
  registration: ExpoPushNotificationRegistration,
  result: { readonly registered: boolean },
): boolean {
  return registration.enabled ? result.registered : !result.registered;
}

export async function readPersonalExpoPushRegistration(): Promise<
  ExpoPushNotificationRegistration | undefined
> {
  if (Platform.OS !== "ios" || !usesPersonalExpoPushAlerts()) return undefined;

  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) return { enabled: false };

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (typeof projectId !== "string" || projectId.trim().length === 0) return undefined;

  const token = await Notifications.getExpoPushTokenAsync({ projectId: projectId.trim() });
  const value = token.data.trim();
  return value.length > 0 ? { enabled: true, token: value } : undefined;
}

export function __resetPersonalExpoPushRegistrationForTest(): void {
  status = "unknown";
  statusListeners.clear();
  refreshListeners.clear();
}
