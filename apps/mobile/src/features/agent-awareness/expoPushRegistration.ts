import type { ExpoPushNotificationRegistration } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { usesPersonalExpoPushAlerts } from "./capabilities";

// "partial" exists because one accepted environment does not mean alerts work
// everywhere: each connected environment sends its own pushes, so a device that
// registered with only some of them silently misses the rest.
export type PersonalExpoPushRegistrationStatus =
  | "unknown"
  | "pending"
  | "registered"
  | "partial"
  | "disabled"
  | "failed";

let status: PersonalExpoPushRegistrationStatus = "unknown";
// Why the device has no push token, when that is the reason nothing registers.
// A failed token read used to collapse into the same "failed" as an environment
// rejecting the device, which hid the one error the user could act on.
let tokenError: string | null = null;
const statusListeners = new Set<() => void>();
const refreshListeners = new Set<() => void>();

export function getPersonalExpoPushRegistrationStatus(): PersonalExpoPushRegistrationStatus {
  return status;
}

export function getPersonalExpoPushTokenError(): string | null {
  return tokenError;
}

export function setPersonalExpoPushTokenError(next: string | null): void {
  if (tokenError === next) return;
  tokenError = next;
  statusListeners.forEach((listener) => listener());
}

/** One line for Settings; Expo's errors are long and prefixed with an error code. */
export function describePersonalExpoPushTokenError(cause: unknown): string {
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : cause !== null && typeof cause === "object" && "_tag" in cause
          ? String((cause as { readonly _tag: unknown })._tag)
          : String(cause);
  const message = raw.replace(/\s+/g, " ").trim();
  if (message.length === 0) return "Unknown error";
  if (/TimeoutError|timed out/i.test(message)) return "Expo did not answer within 5 seconds";
  return message.length > 160 ? `${message.slice(0, 159)}…` : message;
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

// Derives what the user is actually told from one report pass. Kept pure and
// separate from the reporter so the distinctions that matter are testable.
// `reachableCount` is the number of environments that answered this pass, not
// the number configured: a saved environment that is simply offline is not a
// registration failure and must not drag the row into "failed"/"partial".
export function resolvePersonalExpoPushRegistrationStatus(input: {
  readonly enabled: boolean;
  readonly reachableCount: number;
  readonly acceptedCount: number;
}): PersonalExpoPushRegistrationStatus {
  if (!input.enabled) return "disabled";
  if (input.reachableCount === 0) return "pending";
  if (input.acceptedCount === 0) return "failed";
  return input.acceptedCount >= input.reachableCount ? "registered" : "partial";
}

// Whether this pass must send the registration again rather than trust the
// local "this environment already has this token" record. Servers drop
// registrations without telling the device (ExpoPushAlerts deletes one on a
// DeviceNotRegistered ticket, a restarted server holds none), so the record has
// to expire or a long-lived foreground session would report alerts as working
// forever.
export function shouldReassertPersonalExpoPushRegistration(input: {
  readonly asserted: { readonly identity: string; readonly assertedAtMs: number } | undefined;
  readonly identity: string;
  readonly nowMs: number;
  readonly reassertIntervalMs: number;
}): boolean {
  if (input.asserted === undefined) return true;
  if (input.asserted.identity !== input.identity) return true;
  const age = input.nowMs - input.asserted.assertedAtMs;
  // A clock that moved backwards must not grant an unbounded lease.
  return age < 0 || age >= input.reassertIntervalMs;
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
  tokenError = null;
  statusListeners.clear();
  refreshListeners.clear();
}
