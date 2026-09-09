import type {
  ExpoPushNotificationRegistrationInput,
  ExpoPushTestInput,
  ExpoPushTestResult,
  ThreadId,
} from "@t3tools/contracts";
import { RelayAgentAwarenessPhase, type RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_STATE_SECRET = "personal-expo-push-alerts";
const MAX_REGISTRATIONS = 64;
const MAX_OBSERVED_THREADS = 512;
const MAX_INITIAL_NOTIFICATION_AGE_MS = 2 * 60 * 1_000;
// Expo rejects messages over ~4 KiB; thread and project titles are
// user-controlled and unbounded, so clamp every display field.
const MAX_NOTIFICATION_TEXT_LENGTH = 200;
const persistenceMutex = Semaphore.makeUnsafe(1);
// Publishes are serialized globally: the relay consumes them through a
// single-consumer worker, so per-thread permits would not add concurrency.
const deliveryMutex = Semaphore.makeUnsafe(1);
const registrationRevision = Effect.runSync(SubscriptionRef.make(0));

export type ExpoPublishOutcome = "sent" | "suppressed" | "failed";

function truncateNotificationText(text: string): string {
  return text.length <= MAX_NOTIFICATION_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH - 1)}…`;
}

const PersistedRegistration = Schema.Struct({
  clientId: Schema.String,
  token: Schema.String,
});

const PersistedObservation = Schema.Struct({
  threadId: Schema.String,
  phase: RelayAgentAwarenessPhase,
  updatedAt: Schema.String,
});

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  registrations: Schema.Array(PersistedRegistration),
  observations: Schema.Array(PersistedObservation),
});
type PersistedState = typeof PersistedState.Type;

const PersistedStateJson = Schema.fromJsonString(PersistedState);
const decodePersistedState = Schema.decodeUnknownEffect(PersistedStateJson);
const encodePersistedState = Schema.encodeSync(PersistedStateJson);

const ExpoPushTicket = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), id: Schema.optional(Schema.String) }),
  Schema.Struct({
    status: Schema.Literal("error"),
    message: Schema.String,
    details: Schema.optional(
      Schema.Struct({
        error: Schema.optional(Schema.String),
      }),
    ),
  }),
]);

const ExpoPushResponse = Schema.Struct({
  data: Schema.Array(ExpoPushTicket),
});

// Expo answers 200 even when every ticket is rejected (missing APNs key,
// unregistered device, ...). Surface the reason so "acceptedCount: 0" is
// diagnosable from the log alone.
export function summarizeRejectedTickets(
  tickets: ReadonlyArray<typeof ExpoPushTicket.Type>,
): ReadonlyArray<{ readonly error: string | null; readonly message: string }> {
  return tickets.flatMap((ticket) =>
    ticket.status === "error"
      ? [{ error: ticket.details?.error ?? null, message: ticket.message }]
      : [],
  );
}

type NotificationContent = {
  readonly title: string;
  readonly body: string;
};

type RuntimeState = {
  readonly registrations: ReadonlyMap<string, string>;
  readonly observations: ReadonlyMap<ThreadId, typeof PersistedObservation.Type>;
};

export function notificationContentForPhase(
  phase: RelayAgentActivityState["phase"],
  projectTitle: string,
): NotificationContent | null {
  switch (phase) {
    case "waiting_for_approval":
      return { title: "Approval needed", body: projectTitle };
    case "waiting_for_input":
      return { title: "Input needed", body: projectTitle };
    case "completed":
      return { title: "Agent finished", body: projectTitle };
    case "failed":
      return { title: "Agent failed", body: projectTitle };
    default:
      return null;
  }
}

export class ExpoPushAlerts extends Context.Service<
  ExpoPushAlerts,
  {
    readonly register: (input: ExpoPushNotificationRegistrationInput) => Effect.Effect<boolean>;
    readonly hasRegistrations: Effect.Effect<boolean>;
    readonly registrationChanges: Stream.Stream<number>;
    /**
     * Delivers or suppresses the alert for the thread's current state.
     * "sent" means at least one device accepted the push; "suppressed" means
     * no send was needed and the persisted observation already reflects the
     * state; "failed" means a send was attempted but nothing was delivered,
     * so callers must not treat the state as notified.
     */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<ExpoPublishOutcome>;
    /**
     * Pushes one test alert to the client's own registration so a phone can
     * confirm the whole route (token, Expo credentials, this environment)
     * without waiting for an agent to finish. Never touches observations.
     */
    readonly sendTest: (input: ExpoPushTestInput) => Effect.Effect<ExpoPushTestResult>;
  }
>()("t3/notifications/ExpoPushAlerts") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  const readPersistedState = secrets.get(EXPO_PUSH_STATE_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed<PersistedState>({ version: 1, registrations: [], observations: [] }),
        onSome: (bytes) => decodePersistedState(new TextDecoder().decode(bytes)),
      }),
    ),
  );
  const initial = yield* readPersistedState.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("personal Expo push state could not be loaded; starting empty", {
        cause: String(cause),
      }).pipe(Effect.as<PersistedState>({ version: 1, registrations: [], observations: [] })),
    ),
  );

  const stateRef = yield* Ref.make<RuntimeState>({
    registrations: new Map(initial.registrations.map(({ clientId, token }) => [clientId, token])),
    observations: new Map(
      initial.observations.map((observation) => [observation.threadId as ThreadId, observation]),
    ),
  });
  // The only place the desktop side states how many phones it can reach.
  yield* Effect.logInfo("personal Expo push state loaded", {
    registrationCount: initial.registrations.length,
    observationCount: initial.observations.length,
  });

  const refreshState = readPersistedState.pipe(
    Effect.map((persisted): RuntimeState => ({
      registrations: new Map(
        persisted.registrations.map(({ clientId, token }) => [clientId, token]),
      ),
      observations: new Map(
        persisted.observations.map((observation) => [
          observation.threadId as ThreadId,
          observation,
        ]),
      ),
    })),
    Effect.tap((state) => Ref.set(stateRef, state)),
    Effect.catch(() => Ref.get(stateRef)),
  );

  const persist = (state: RuntimeState) => {
    const observations = [...state.observations.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_OBSERVED_THREADS);
    return secrets.set(
      EXPO_PUSH_STATE_SECRET,
      new TextEncoder().encode(
        encodePersistedState({
          version: 1,
          registrations: [...state.registrations].map(([clientId, token]) => ({ clientId, token })),
          observations,
        }),
      ),
    );
  };

  const updateState = (update: (state: RuntimeState) => RuntimeState) =>
    persistenceMutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* refreshState;
        const next = update(current);
        if (next === current) {
          return current;
        }
        yield* persist(next);
        yield* Ref.set(stateRef, next);
        return next;
      }),
    );

  const register: ExpoPushAlerts["Service"]["register"] = (input) =>
    updateState((current) => {
      const registrations = new Map(current.registrations);
      if (!input.registration.enabled) {
        if (!registrations.delete(input.clientId)) {
          return current;
        }
      } else {
        if (registrations.get(input.clientId) === input.registration.token) {
          return current;
        }
        registrations.delete(input.clientId);
        registrations.set(input.clientId, input.registration.token);
        while (registrations.size > MAX_REGISTRATIONS) {
          const oldestClientId = registrations.keys().next().value;
          if (oldestClientId === undefined) break;
          registrations.delete(oldestClientId);
        }
      }
      return { ...current, registrations };
    }).pipe(
      Effect.tap((state) =>
        Effect.logInfo("personal Expo push registration received", {
          clientId: input.clientId,
          enabled: input.registration.enabled,
          registrationCount: state.registrations.size,
        }),
      ),
      Effect.map((state) => state.registrations.has(input.clientId)),
      Effect.tap((registered) =>
        registered
          ? SubscriptionRef.update(registrationRevision, (revision) => revision + 1)
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("personal Expo push registration could not be persisted", {
          clientId: input.clientId,
          cause: String(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  // Served from the in-memory ref: registrations only change through
  // `register`, which refreshes from disk under the persistence mutex before
  // mutating. This keeps the per-event publish path free of file reads.
  const hasRegistrations = Ref.get(stateRef).pipe(
    Effect.map((state) => state.registrations.size > 0),
  );

  const publish: ExpoPushAlerts["Service"]["publish"] = (input) =>
    deliveryMutex.withPermit(
      Effect.gen(function* () {
        const plan = yield* persistenceMutex.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* refreshState;
            const observations = new Map(current.observations);

            if (input.state === null) {
              if (!observations.delete(input.threadId)) {
                return { kind: "complete" as const };
              }
              const next = { ...current, observations };
              yield* persist(next);
              yield* Ref.set(stateRef, next);
              return { kind: "complete" as const };
            }

            const state = input.state;
            const previous = observations.get(input.threadId);
            const nextObservation = {
              threadId: input.threadId,
              phase: state.phase,
              updatedAt: state.updatedAt,
            };
            observations.set(input.threadId, nextObservation);
            const next = { ...current, observations };
            const content = notificationContentForPhase(state.phase, state.projectTitle);
            const updatedAt = DateTime.make(state.updatedAt);
            const now = yield* DateTime.now;
            const notificationAgeMs = Option.isSome(updatedAt)
              ? now.epochMilliseconds - updatedAt.value.epochMilliseconds
              : null;
            const isFresh =
              notificationAgeMs !== null &&
              notificationAgeMs >= 0 &&
              notificationAgeMs <= MAX_INITIAL_NOTIFICATION_AGE_MS;

            // The first projection establishes a baseline. Notifications are
            // reserved for a phase transition observed after that baseline.
            if (
              previous === undefined ||
              content === null ||
              previous.phase === state.phase ||
              !isFresh
            ) {
              yield* persist(next);
              yield* Ref.set(stateRef, next);
              return { kind: "complete" as const };
            }
            if (current.registrations.size === 0) {
              // Nothing was delivered and no observation may be recorded:
              // recording would mark the state as notified and a device that
              // registers later would never receive it.
              return { kind: "unreachable" as const };
            }

            return {
              kind: "send" as const,
              content,
              state,
              tokens: [...new Set(current.registrations.values())],
            };
          }),
        );

        if (plan.kind === "complete") {
          return "suppressed" as const;
        }
        if (plan.kind === "unreachable") {
          yield* Effect.logWarning("personal Expo push alert skipped; no registered devices", {
            threadId: input.threadId,
            phase: input.state?.phase ?? null,
          });
          return "failed" as const;
        }

        // Network I/O stays outside the persistence lock so a slow Expo request
        // cannot block token registration or unrelated agent state updates.
        const response = yield* HttpClientRequest.post(EXPO_PUSH_ENDPOINT).pipe(
          HttpClientRequest.bodyJson(
            plan.tokens.map((token) => ({
              to: token,
              title: truncateNotificationText(plan.state.threadTitle),
              subtitle: truncateNotificationText(plan.content.title),
              body: truncateNotificationText(plan.content.body),
              sound: "default",
              priority: "high",
              data: {
                environmentId: plan.state.environmentId,
                threadId: input.threadId,
                deepLink: plan.state.deepLink,
                phase: plan.state.phase,
                updatedAt: plan.state.updatedAt,
              },
            })),
          ),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ExpoPushResponse)),
          Effect.timeout("10 seconds"),
        );

        const acceptedCount = response.data.filter((ticket) => ticket.status === "ok").length;
        if (acceptedCount === 0) {
          // Expo answered 200 but rejected every ticket. Leave the observation
          // untouched so a retry re-attempts the same transition instead of
          // silently swallowing the alert.
          yield* Effect.logWarning("personal Expo push alert rejected for every device", {
            threadId: input.threadId,
            phase: plan.state.phase,
            registrationCount: plan.tokens.length,
            rejections: summarizeRejectedTickets(response.data),
          });
          return "failed" as const;
        }

        yield* persistenceMutex
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* refreshState;
              const registrations = new Map(current.registrations);
              response.data.forEach((ticket, index) => {
                if (
                  ticket.status === "error" &&
                  ticket.details?.error === "DeviceNotRegistered" &&
                  plan.tokens[index]
                ) {
                  for (const [clientId, token] of registrations) {
                    if (token === plan.tokens[index]) registrations.delete(clientId);
                  }
                }
              });
              const observations = new Map(current.observations);
              observations.set(input.threadId, {
                threadId: input.threadId,
                phase: plan.state.phase,
                updatedAt: plan.state.updatedAt,
              });
              const persisted = { registrations, observations };
              yield* persist(persisted);
              yield* Ref.set(stateRef, persisted);
            }),
          )
          .pipe(
            // The push was already accepted by at least one device; a failure
            // recording that fact must not flip the outcome to "failed" or the
            // relay would re-send a delivered notification. Worst case of
            // skipping the observation is one redundant dedup baseline later.
            Effect.catchCause((cause) =>
              Effect.logWarning("personal Expo push state could not be updated after send", {
                threadId: input.threadId,
                cause: String(cause),
              }),
            ),
          );
        yield* Effect.logInfo("personal Expo push alert submitted", {
          threadId: input.threadId,
          phase: plan.state.phase,
          registrationCount: plan.tokens.length,
          acceptedCount,
          rejections: summarizeRejectedTickets(response.data),
        });
        return "sent" as const;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("personal Expo push alert failed", {
            threadId: input.threadId,
            cause: String(cause),
          }).pipe(Effect.as("failed" as const)),
        ),
      ),
    );

  const sendTest: ExpoPushAlerts["Service"]["sendTest"] = (input) =>
    Effect.gen(function* () {
      const token = yield* persistenceMutex
        .withPermits(1)(refreshState)
        .pipe(Effect.map((state) => state.registrations.get(input.clientId)));
      if (token === undefined) {
        yield* Effect.logWarning("personal Expo push test skipped; client is not registered", {
          clientId: input.clientId,
        });
        return { outcome: "unregistered", rejections: [] } as const;
      }
      const response = yield* HttpClientRequest.post(EXPO_PUSH_ENDPOINT).pipe(
        HttpClientRequest.bodyJson([
          {
            to: token,
            title: "T3 Code",
            subtitle: "Test alert",
            body: "Notifications from this environment reach this phone.",
            sound: "default",
            priority: "high",
            data: { test: true },
          },
        ]),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExpoPushResponse)),
        Effect.timeout("10 seconds"),
      );
      const rejections = summarizeRejectedTickets(response.data);
      const accepted = response.data.some((ticket) => ticket.status === "ok");
      yield* Effect.logInfo("personal Expo push test submitted", {
        clientId: input.clientId,
        accepted,
        rejections,
      });
      return { outcome: accepted ? "sent" : "rejected", rejections } as const;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("personal Expo push test failed", {
          clientId: input.clientId,
          cause: String(cause),
        }).pipe(
          Effect.as({
            outcome: "rejected",
            rejections: [{ error: null, message: String(cause) }],
          } as const),
        ),
      ),
    );

  return ExpoPushAlerts.of({
    register,
    hasRegistrations,
    registrationChanges: SubscriptionRef.changes(registrationRevision),
    publish,
    sendTest,
  });
});

export const layer = Layer.effect(ExpoPushAlerts, make);
