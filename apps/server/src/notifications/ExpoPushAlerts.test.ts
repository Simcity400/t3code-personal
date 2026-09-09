import { describe, expect, it } from "@effect/vitest";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExpoPushAlerts from "./ExpoPushAlerts.ts";

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      }),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(bytes);
        values.set(name, value);
        return value;
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  });
}

describe.sequential("ExpoPushAlerts", () => {
  it.effect("registers a token and sends each attention transition once", () => {
    const requests: unknown[] = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.body._tag === "Uint8Array") {
            const payload = yield* decodeUnknownJson(
              new TextDecoder().decode(request.body.body),
            ).pipe(Effect.orDie);
            requests.push(payload);
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ data: [{ status: "ok", id: "ticket-1" }] }),
          );
        }),
      ),
    );
    const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, makeMemorySecretStore());

    const alertsLayer = ExpoPushAlerts.layer.pipe(
      Layer.provide(Layer.merge(secretLayer, httpLayer)),
    );

    return Effect.gen(function* () {
      const alerts = yield* ExpoPushAlerts.ExpoPushAlerts;
      expect(
        yield* alerts.register({
          clientId: "mobile-device",
          registration: { enabled: true, token: "ExponentPushToken[test]" },
        }),
      ).toBe(true);

      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const running: RelayAgentActivityState = {
        environmentId: "environment" as RelayAgentActivityState["environmentId"],
        threadId: "thread" as RelayAgentActivityState["threadId"],
        projectTitle: "T3 Code",
        threadTitle: "Fix notifications",
        modelTitle: "Codex",
        phase: "running",
        headline: "Running",
        updatedAt,
        deepLink: "t3code-preview://thread/environment/thread",
      };
      const waiting = { ...running, phase: "waiting_for_input" as const, headline: "Input needed" };
      yield* alerts.publish({ threadId: waiting.threadId, state: waiting });
      expect(requests).toHaveLength(0);
      yield* alerts.publish({ threadId: running.threadId, state: running });
      yield* alerts.publish({ threadId: waiting.threadId, state: waiting });
      yield* alerts.publish({ threadId: waiting.threadId, state: waiting });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual([
        expect.objectContaining({
          to: "ExponentPushToken[test]",
          subtitle: "Input needed",
          data: expect.objectContaining({ threadId: "thread", phase: "waiting_for_input" }),
        }),
      ]);
    }).pipe(Effect.provide(alertsLayer));
  });

  it("maps only actionable phases to notification copy", () => {
    expect(ExpoPushAlerts.notificationContentForPhase("running", "Project")).toBeNull();
    expect(ExpoPushAlerts.notificationContentForPhase("completed", "Project")).toEqual({
      title: "Agent finished",
      body: "Project",
    });
  });

  it.effect("serializes concurrent transitions for the same thread", () => {
    const requests: unknown[] = [];
    const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, makeMemorySecretStore());

    return Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push(request);
            yield* Deferred.succeed(requestStarted, undefined);
            yield* Deferred.await(releaseRequest);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: [{ status: "ok", id: "ticket-1" }] }),
            );
          }),
        ),
      );
      const alerts = yield* ExpoPushAlerts.make.pipe(
        Effect.provide(Layer.merge(secretLayer, httpLayer)),
      );
      yield* alerts.register({
        clientId: "mobile-device",
        registration: { enabled: true, token: "ExponentPushToken[test]" },
      });

      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const running: RelayAgentActivityState = {
        environmentId: "environment" as RelayAgentActivityState["environmentId"],
        threadId: "concurrent-thread" as RelayAgentActivityState["threadId"],
        projectTitle: "T3 Code",
        threadTitle: "Fix notifications",
        modelTitle: "Codex",
        phase: "running",
        headline: "Running",
        updatedAt,
        deepLink: "t3code-preview://thread/environment/concurrent-thread",
      };
      const waiting = { ...running, phase: "waiting_for_input" as const, headline: "Input needed" };
      yield* alerts.publish({ threadId: running.threadId, state: running });

      const first = yield* alerts
        .publish({ threadId: waiting.threadId, state: waiting })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requestStarted);
      const second = yield* alerts
        .publish({ threadId: waiting.threadId, state: waiting })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(requests).toHaveLength(1);

      yield* Deferred.succeed(releaseRequest, undefined);
      expect(yield* Fiber.join(first)).toBe("sent");
      expect(yield* Fiber.join(second)).toBe("suppressed");
      expect(requests).toHaveLength(1);
    });
  });

  it.effect(
    "reports failure without recording the observation when every ticket is rejected",
    () => {
      const requests: unknown[] = [];
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            if (request.body._tag === "Uint8Array") {
              const payload = yield* decodeUnknownJson(
                new TextDecoder().decode(request.body.body),
              ).pipe(Effect.orDie);
              requests.push(payload);
            }
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  {
                    status: "error",
                    message: "no push key",
                    details: { error: "InvalidCredentials" },
                  },
                ],
              }),
            );
          }),
        ),
      );
      const secretLayer = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        makeMemorySecretStore(),
      );

      return Effect.gen(function* () {
        const alerts = yield* ExpoPushAlerts.ExpoPushAlerts;
        yield* alerts.register({
          clientId: "mobile-device",
          registration: { enabled: true, token: "ExponentPushToken[test]" },
        });

        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const running: RelayAgentActivityState = {
          environmentId: "environment" as RelayAgentActivityState["environmentId"],
          threadId: "rejected-thread" as RelayAgentActivityState["threadId"],
          projectTitle: "T3 Code",
          threadTitle: "Fix notifications",
          modelTitle: "Codex",
          phase: "running",
          headline: "Running",
          updatedAt,
          deepLink: "t3code-preview://thread/environment/rejected-thread",
        };
        const waiting = {
          ...running,
          phase: "waiting_for_input" as const,
          headline: "Input needed",
        };
        // Baseline first, then a rejected transition.
        yield* alerts.publish({ threadId: running.threadId, state: running });
        expect(yield* alerts.publish({ threadId: waiting.threadId, state: waiting })).toBe(
          "failed",
        );
        expect(requests).toHaveLength(1);

        // The failed attempt left no observation behind, so a retry of the same
        // transition is still eligible for delivery.
        expect(yield* alerts.publish({ threadId: waiting.threadId, state: waiting })).toBe(
          "failed",
        );
        expect(requests).toHaveLength(2);
      }).pipe(
        Effect.provide(
          ExpoPushAlerts.layer.pipe(Layer.provide(Layer.merge(secretLayer, httpLayer))),
        ),
      );
    },
  );

  it.effect("truncates oversized notification text", () => {
    const requests: unknown[] = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.body._tag === "Uint8Array") {
            const payload = yield* decodeUnknownJson(
              new TextDecoder().decode(request.body.body),
            ).pipe(Effect.orDie);
            requests.push(payload);
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ data: [{ status: "ok", id: "ticket-1" }] }),
          );
        }),
      ),
    );
    const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, makeMemorySecretStore());

    return Effect.gen(function* () {
      const alerts = yield* ExpoPushAlerts.ExpoPushAlerts;
      yield* alerts.register({
        clientId: "mobile-device",
        registration: { enabled: true, token: "ExponentPushToken[test]" },
      });

      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const running: RelayAgentActivityState = {
        environmentId: "environment" as RelayAgentActivityState["environmentId"],
        threadId: "long-title-thread" as RelayAgentActivityState["threadId"],
        projectTitle: "P".repeat(500),
        threadTitle: "T".repeat(500),
        modelTitle: "Codex",
        phase: "running",
        headline: "Running",
        updatedAt,
        deepLink: "t3code-preview://thread/environment/long-title-thread",
      };
      const waiting = { ...running, phase: "waiting_for_input" as const, headline: "Input needed" };
      yield* alerts.publish({ threadId: running.threadId, state: running });
      yield* alerts.publish({ threadId: waiting.threadId, state: waiting });

      expect(requests).toHaveLength(1);
      const message = (requests[0] as Array<Record<string, unknown>>)[0]!;
      expect((message.title as string).length).toBeLessThanOrEqual(200);
      expect((message.subtitle as string).length).toBeLessThanOrEqual(200);
      expect((message.body as string).length).toBeLessThanOrEqual(200);
    }).pipe(
      Effect.provide(ExpoPushAlerts.layer.pipe(Layer.provide(Layer.merge(secretLayer, httpLayer)))),
    );
  });

  it.effect("replays registration state and emits registrations made after startup", () => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: [{ status: "ok" }] })),
        ),
      ),
    );
    const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, makeMemorySecretStore());

    return Effect.gen(function* () {
      const alerts = yield* ExpoPushAlerts.ExpoPushAlerts;
      const initialRevisionObserved = yield* Deferred.make<void>();
      const revisionsFiber = yield* alerts.registrationChanges.pipe(
        Stream.tap(() => Deferred.succeed(initialRevisionObserved, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(initialRevisionObserved);
      yield* alerts.register({
        clientId: "late-mobile-device",
        registration: { enabled: true, token: "ExponentPushToken[late]" },
      });

      const revisions = Array.from(yield* Fiber.join(revisionsFiber));
      expect(revisions).toHaveLength(2);
      expect(revisions[1]).toBe(revisions[0]! + 1);
    }).pipe(
      Effect.provide(ExpoPushAlerts.layer.pipe(Layer.provide(Layer.merge(secretLayer, httpLayer)))),
    );
  });
});

describe.sequential("ExpoPushAlerts.sendTest", () => {
  it.effect(
    "reports Expo's verdict for the client's own token and skips unregistered clients",
    () => {
      const requests: unknown[] = [];
      let ticket: unknown = { status: "ok", id: "ticket-test" };
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            if (request.body._tag === "Uint8Array") {
              requests.push(
                yield* decodeUnknownJson(new TextDecoder().decode(request.body.body)).pipe(
                  Effect.orDie,
                ),
              );
            }
            return HttpClientResponse.fromWeb(request, Response.json({ data: [ticket] }));
          }),
        ),
      );
      const secretLayer = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        makeMemorySecretStore(),
      );

      return Effect.gen(function* () {
        const alerts = yield* ExpoPushAlerts.ExpoPushAlerts;
        expect(yield* alerts.sendTest({ clientId: "mobile-unknown" })).toEqual({
          outcome: "unregistered",
          rejections: [],
        });
        expect(requests).toHaveLength(0);

        yield* alerts.register({
          clientId: "mobile-device",
          registration: { enabled: true, token: "ExponentPushToken[test]" },
        });
        expect(yield* alerts.sendTest({ clientId: "mobile-device" })).toEqual({
          outcome: "sent",
          rejections: [],
        });
        expect(requests[0]).toEqual([
          expect.objectContaining({ to: "ExponentPushToken[test]", data: { test: true } }),
        ]);

        ticket = {
          status: "error",
          message: "no push key",
          details: { error: "InvalidCredentials" },
        };
        expect(yield* alerts.sendTest({ clientId: "mobile-device" })).toEqual({
          outcome: "rejected",
          rejections: [{ error: "InvalidCredentials", message: "no push key" }],
        });
      }).pipe(
        Effect.provide(
          ExpoPushAlerts.layer.pipe(Layer.provide(Layer.merge(secretLayer, httpLayer))),
        ),
      );
    },
  );
});

describe("summarizeRejectedTickets", () => {
  it("keeps only rejected tickets with their reason", () => {
    expect(
      ExpoPushAlerts.summarizeRejectedTickets([
        { status: "ok", id: "a" },
        { status: "error", message: "no push key", details: { error: "InvalidCredentials" } },
        { status: "error", message: "bad" },
      ]),
    ).toEqual([
      { error: "InvalidCredentials", message: "no push key" },
      { error: null, message: "bad" },
    ]);
  });
});
