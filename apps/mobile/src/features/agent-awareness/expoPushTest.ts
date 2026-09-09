import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ExpoPushTestResult, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";

/** "unreachable": not connected; "failed": the request itself failed before Expo answered. */
export type PersonalExpoPushTestOutcome = ExpoPushTestResult["outcome"] | "unreachable" | "failed";

export interface PersonalExpoPushTestEnvironmentResult {
  readonly environmentId: EnvironmentId;
  readonly outcome: PersonalExpoPushTestOutcome;
  readonly detail: string | null;
}

/**
 * Asks every known environment to push one test alert to this device. Each
 * environment answers for itself, since each one delivers its own alerts.
 */
export const sendPersonalExpoPushTest = createRuntimeCommand(connectionAtomRuntime, {
  label: "agent-awareness:send-personal-expo-push-test",
  execute: Effect.fn("sendPersonalExpoPushTest")(function* () {
    const registry = yield* EnvironmentRegistry;
    // Same id the background reporter registers under, so the environment
    // looks up the token it actually stored for this phone.
    const clientId = yield* Effect.tryPromise(() => loadOrCreateAgentAwarenessDeviceId()).pipe(
      Effect.map((deviceId) => `mobile-${deviceId}`),
      Effect.orElseSucceed(() => "ephemeral-mobile-client"),
    );
    const entries = yield* SubscriptionRef.get(registry.entries);
    return yield* Effect.forEach(
      [...entries.keys()] as ReadonlyArray<EnvironmentId>,
      (environmentId) =>
        registry.run(environmentId, request(WS_METHODS.serverSendExpoPushTest, { clientId })).pipe(
          Effect.map((result): PersonalExpoPushTestEnvironmentResult => ({
            environmentId,
            outcome: result.outcome,
            detail:
              result.rejections.length > 0
                ? result.rejections
                    .map((rejection) =>
                      rejection.error
                        ? `${rejection.error}: ${rejection.message}`
                        : rejection.message,
                    )
                    .join("; ")
                : null,
          })),
          Effect.catchTag("EnvironmentRpcUnavailableError", () =>
            Effect.succeed<PersonalExpoPushTestEnvironmentResult>({
              environmentId,
              outcome: "unreachable",
              detail: null,
            }),
          ),
          Effect.catchTag("EnvironmentNotRegisteredError", () =>
            Effect.succeed<PersonalExpoPushTestEnvironmentResult>({
              environmentId,
              outcome: "unreachable",
              detail: null,
            }),
          ),
          // Failures only: an interrupted run must not read as an answer.
          Effect.catch((cause) =>
            Effect.succeed<PersonalExpoPushTestEnvironmentResult>({
              environmentId,
              outcome: "failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
  }),
});

/** Human-readable outcome per environment, in registry order. */
export function summarizePersonalExpoPushTest(
  results: ReadonlyArray<PersonalExpoPushTestEnvironmentResult>,
  labelFor: (environmentId: EnvironmentId) => string,
): { readonly title: string; readonly body: string } {
  if (results.length === 0) {
    return { title: "No environments", body: "Connect to a T3 Code environment first." };
  }
  const lines = results.map((result) => {
    const label = labelFor(result.environmentId);
    switch (result.outcome) {
      case "sent":
        return `${label}: sent. Expo accepted the alert; it should arrive within seconds.`;
      case "unregistered":
        return `${label}: this environment holds no push token for this phone. Reconnect with notifications enabled, or check the row above for a token error.`;
      case "unreachable":
        return `${label}: not connected right now.`;
      case "rejected":
        return `${label}: Expo rejected it${result.detail ? ` (${result.detail})` : ""}.`;
      case "failed":
        return `${label}: could not run the test${result.detail ? ` (${result.detail})` : ""}. This environment may predate the test alert.`;
    }
  });
  const sent = results.filter((result) => result.outcome === "sent").length;
  return {
    title:
      sent === results.length
        ? "Test alert sent"
        : sent > 0
          ? "Test alert partly sent"
          : "Test alert not sent",
    body: lines.join("\n\n"),
  };
}
