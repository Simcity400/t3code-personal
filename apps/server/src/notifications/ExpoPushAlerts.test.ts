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
      expect(yield* Fiber.join(first)).toBe(true);
      expect(yield* Fiber.join(second)).toBe(true);
      expect(requests).toHaveLength(1);
    });
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
