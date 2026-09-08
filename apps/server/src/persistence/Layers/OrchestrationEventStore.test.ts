import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function messageEvent(threadId: ThreadId, id: string): Omit<OrchestrationEvent, "sequence"> {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    type: "thread.message-sent",
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(id),
      role: "assistant",
      text: id,
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("replays bridge questions as history while native questions remain actionable", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      for (const bridge of [true, false]) {
        const base = messageEvent(ThreadId.make("legacy-question-thread"), `question-${bridge}`);
        const event = yield* store.append({
          ...base,
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("legacy-question-thread"),
            activity: {
              id: base.eventId,
              tone: "info",
              kind: "user-input.requested",
              summary: "Question",
              payload: {
                requestId: `request-${bridge}`,
                ...(bridge ? { bridgeAgentId: "child" } : {}),
              },
              turnId: null,
              createdAt: base.occurredAt,
            },
          },
        });
        const events = yield* Stream.runCollect(store.readFromSequence(event.sequence - 1, 1));
        const restored = events[0];
        assert.equal(restored?.type, "thread.activity-appended");
        if (restored?.type === "thread.activity-appended") {
          assert.equal(
            restored.payload.activity.kind,
            bridge ? "legacy.user-input.requested" : "user-input.requested",
          );
        }
        yield* sql`DELETE FROM orchestration_events WHERE event_id = ${event.eventId}`;
      }
    }),
  );
  it.effect("does not replay a retired child interrupt as an interrupt of its parent", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const event = yield* store.append(
        messageEvent(ThreadId.make("legacy-control-thread"), "legacy-control-event"),
      );
      yield* sql`UPDATE orchestration_events SET event_type = 'thread.turn-interrupt-requested', payload_json = '{"threadId":"legacy-control-thread","taskId":"child-1","createdAt":"2026-01-01T00:00:00.000Z"}' WHERE event_id = ${event.eventId}`;
      const events = yield* Stream.runCollect(store.readFromSequence(event.sequence - 1, 1));
      assert.equal(events[0]?.type, "thread.activity-appended");
      const restored = events[0];
      if (restored?.type === "thread.activity-appended")
        assert.equal(restored.payload.activity.kind, "legacy.task-interrupt");
      yield* sql`DELETE FROM orchestration_events WHERE event_id = ${event.eventId}`;
    }),
  );
  it.effect("replays saved goals as active goal state without changing the stored event", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("legacy-goal-thread");
      const event = yield* store.append(messageEvent(threadId, "legacy-goal-event"));
      const payload = {
        threadId,
        goal: {
          objective: "Saved objective",
          status: "paused" as const,
          tokensUsed: 12,
          timeUsedSeconds: 3,
          createdAt: 1,
          updatedAt: 2,
          turnId: null,
        },
      };
      const payloadJson = yield* encodeUnknownJson(payload);
      yield* sql`UPDATE orchestration_events SET event_type = 'thread.goal-set', payload_json = ${payloadJson} WHERE event_id = ${event.eventId}`;
      const events = yield* Stream.runCollect(store.readFromSequence(event.sequence - 1, 1));
      assert.equal(events[0]?.type, "thread.goal-set");
      const restored = events[0];
      if (restored?.type === "thread.goal-set") {
        assert.deepEqual(restored.payload, payload);
      }
      assert.deepEqual(
        yield* sql`SELECT event_type FROM orchestration_events WHERE event_id = ${event.eventId}`,
        [{ event_type: "thread.goal-set" }],
      );
      yield* sql`DELETE FROM orchestration_events WHERE event_id = ${event.eventId}`;
    }),
  );
  it.effect("stores json columns as strings and replays CLI-origin events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
          origin: {
            surface: "cli",
          },
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
      assert.deepEqual(replayed[0]?.metadata.origin, { surface: "cli" });
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const invalidRows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
        RETURNING sequence
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
      const scopedResult = yield* eventStore
        .readAggregateRange({
          aggregateKind: "project",
          aggregateId: "project-invalid-json",
          fromSequenceExclusive: 0,
          toSequenceInclusive: invalidRows[0]!.sequence,
        })
        .pipe(Stream.runCollect, Effect.result);
      assert.equal(scopedResult._tag, "Failure");
      if (scopedResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(scopedResult.failure));
        assert.ok(
          scopedResult.failure.operation.includes(
            "OrchestrationEventStore.readAggregateRange:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("reads one aggregate through the captured head across pruned global gaps", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("shared-stream-id");
      const first = yield* store.append(messageEvent(threadId, "scoped-first"));
      const pruned = yield* store.append(
        messageEvent(ThreadId.make("pruned-thread"), "pruned-event"),
      );
      const second = yield* store.append(messageEvent(threadId, "scoped-second"));
      // The same stream ID in a different aggregate is not part of this thread.
      // Its invalid JSON must never reach the event decoder.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'same-id-project', 'project', ${threadId}, 0, 'project.created',
          '2026-01-01T00:00:00.000Z', 'server', '{', '{'
        ), (
          'unrelated-invalid', 'thread', 'unrelated-invalid-thread', 0, 'thread.activity-appended',
          '2026-01-01T00:00:00.000Z', 'server', '{', '{'
        )
      `;
      const last = yield* store.append(messageEvent(threadId, "scoped-last"));
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${pruned.sequence}`;
      yield* store.append(messageEvent(threadId, "after-captured-head"));

      const events = yield* store
        .readAggregateRange({
          aggregateKind: "thread",
          aggregateId: threadId,
          fromSequenceExclusive: first.sequence,
          toSequenceInclusive: last.sequence,
          limit: 100,
        })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event.sequence),
        [second.sequence, last.sequence],
      );
    }),
  );

  it.effect("bounds thread replay metadata and counts UTF-8 bytes without decoding payloads", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          ('stats-1', 'thread', 'stats-thread', 0, 'thread.message-sent',
            '2026-01-01T00:00:00.000Z', 'provider', '{"output":"😀"}', '{}'),
          ('stats-unrelated', 'thread', 'another-thread', 0, 'thread.created',
            '2026-01-01T00:00:00.000Z', 'provider', printf('%.*c', 10000, 'x'), '{}'),
          ('stats-2', 'thread', 'stats-thread', 1, 'thread.activity-appended',
            '2026-01-01T00:00:00.000Z', 'provider', '{', '{}'),
          ('stats-other-kind', 'project', 'stats-thread', 0, 'project.deleted',
            '2026-01-01T00:00:00.000Z', 'provider', printf('%.*c', 20000, 'x'), '{}'),
          ('stats-3', 'thread', 'stats-thread', 2, 'thread.deleted',
            '2026-01-01T00:00:00.000Z', 'provider', '{"output":"é"}', '{}'),
          ('stats-4', 'thread', 'stats-thread', 3, 'thread.created',
            '2026-01-01T00:00:00.000Z', 'provider', printf('%.*c', 2000, 'x'), '{}')
        RETURNING sequence
      `;
      const range = {
        aggregateKind: "thread" as const,
        aggregateId: "stats-thread",
        fromSequenceExclusive: 0,
        toSequenceInclusive: rows.at(-1)!.sequence,
      };
      assert.deepEqual(yield* store.getAggregateReplayStats({ ...range, maxEvents: 2 }), {
        eventCount: 3,
        payloadBytes: 33,
        hasCreateEvent: false,
      });
      assert.deepEqual(yield* store.getAggregateReplayStats({ ...range, maxEvents: 10 }), {
        eventCount: 4,
        payloadBytes: 2033,
        hasCreateEvent: true,
      });
      assert.deepEqual(
        yield* store.getAggregateReplayStats({
          ...range,
          toSequenceInclusive: rows[2]!.sequence,
          maxEvents: 10,
        }),
        {
          eventCount: 2,
          payloadBytes: 18,
          hasCreateEvent: false,
        },
      );
    }),
  );

  it.effect("keeps later pages below the captured head when new events are appended", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const threadId = ThreadId.make("paged-thread");
      const persisted = yield* Effect.forEach(
        Array.from({ length: 502 }, (_, index) => index),
        (index) => store.append(messageEvent(threadId, `paged-${index}`)),
      );
      const head = persisted.at(-1)!.sequence;
      let appendedDuringReplay = false;
      const replayed = yield* store
        .readAggregateRange({
          aggregateKind: "thread",
          aggregateId: threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: head,
          limit: 1_000,
        })
        .pipe(
          Stream.tap(() => {
            if (appendedDuringReplay) return Effect.void;
            appendedDuringReplay = true;
            return store.append(messageEvent(threadId, "appended-during-replay"));
          }),
          Stream.runCollect,
        );
      assert.deepEqual(
        replayed.map((event) => event.sequence),
        persisted.map((event) => event.sequence),
      );
    }),
  );
});
