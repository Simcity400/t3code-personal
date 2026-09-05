import {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderSession,
  RuntimeTaskStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderValidationError, type ProviderServiceError } from "./Errors.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "./Services/ProviderSessionDirectory.ts";

const AgentId = Schema.String.check(Schema.isMinLength(1));
const hiddenPrefix = "cross-provider-session:";

export const CrossProviderAgentRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: AgentId,
  root: ThreadId,
  parent: Schema.optional(AgentId),
  provider: ProviderDriverKind,
  instance: ProviderInstanceId,
  sourceSession: ProviderSession,
  interactionMode: Schema.optional(ProviderInteractionMode),
  modelSelection: Schema.optional(ModelSelection),
  title: Schema.String,
  providerName: Schema.String,
  status: RuntimeTaskStatus,
  manualStop: Schema.Boolean,
  closed: Schema.Boolean,
  deleted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  session: Schema.optional(ProviderSession),
  assignment: Schema.String,
  pendingInput: Schema.optional(Schema.String),
  context: Schema.String,
  reply: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  turnAccepted: Schema.Boolean,
  forceFresh: Schema.Boolean,
});
export type CrossProviderAgentRecord = typeof CrossProviderAgentRecord.Type;

export interface CrossProviderAgentRecoveryStore {
  readonly save: (record: CrossProviderAgentRecord) => Effect.Effect<void, ProviderServiceError>;
  readonly load: (
    id: string,
  ) => Effect.Effect<CrossProviderAgentRecord | undefined, ProviderServiceError>;
  readonly list: (
    root: ThreadId,
  ) => Effect.Effect<ReadonlyArray<CrossProviderAgentRecord>, ProviderServiceError>;
}

const RecordJson = Schema.fromJsonString(CrossProviderAgentRecord);
const Payload = Schema.Struct({ crossProviderRecovery: Schema.optional(CrossProviderAgentRecord) });
const decodePayload = Schema.decodeUnknownEffect(Payload);
const decodeAgentId = Schema.decodeUnknownEffect(AgentId);
const encodeRecordJson = Schema.encodeEffect(RecordJson);
const decodeRecordJson = Schema.decodeUnknownEffect(RecordJson);
const invalid = (operation: string, issue: string) =>
  new ProviderValidationError({
    operation: `CrossProviderAgentRecovery.${operation}`,
    issue,
  });

/** Stores resumable bridge identity in existing hidden provider runtime bindings. */
export function makeCrossProviderAgentRecoveryStore(
  directory: ProviderSessionDirectoryShape,
): CrossProviderAgentRecoveryStore {
  const read = Effect.fn("CrossProviderAgentRecovery.read")(function* (
    binding: ProviderRuntimeBinding,
  ) {
    if (binding.runtimePayload == null) return undefined;
    const payload = yield* decodePayload(binding.runtimePayload).pipe(
      Effect.mapError(() => invalid("read", "Invalid persisted cross-provider recovery record.")),
    );
    const record = payload.crossProviderRecovery;
    if (record && binding.threadId !== `${hiddenPrefix}${record.id}`) {
      return yield* invalid("read", "Recovery identity does not match its persisted binding.");
    }
    return record;
  });
  const load: CrossProviderAgentRecoveryStore["load"] = Effect.fn(
    "CrossProviderAgentRecovery.load",
  )(function* (id) {
    yield* decodeAgentId(id).pipe(
      Effect.mapError(() => invalid("load", "A non-empty agent ID is required.")),
    );
    const binding = yield* directory.getBinding(ThreadId.make(`${hiddenPrefix}${id}`));
    return Option.isSome(binding) ? yield* read(binding.value) : undefined;
  });
  return {
    load,
    save: Effect.fn("CrossProviderAgentRecovery.save")(function* (record) {
      // The schema round trip detaches opaque cursors and excludes unrelated runtime fields.
      const json = yield* encodeRecordJson(record).pipe(
        Effect.mapError(() => invalid("save", "Recovery state must be a valid JSON record.")),
      );
      const snapshot = yield* decodeRecordJson(json).pipe(
        Effect.mapError(() => invalid("save", "Invalid cross-provider recovery record.")),
      );
      const previous = yield* load(snapshot.id);
      if (previous && previous.root !== snapshot.root) {
        return yield* invalid("save", "An agent's stable ID cannot move to another root thread.");
      }
      if (previous?.deleted && !snapshot.deleted) {
        return yield* invalid("save", "A deleted agent cannot be restored.");
      }
      const running =
        !snapshot.deleted &&
        !snapshot.closed &&
        !snapshot.manualStop &&
        (snapshot.status === "pending" ||
          snapshot.status === "running" ||
          snapshot.status === "waiting");
      yield* directory.upsert({
        threadId: ThreadId.make(`${hiddenPrefix}${snapshot.id}`),
        provider: snapshot.provider,
        providerInstanceId: snapshot.instance,
        runtimeMode: snapshot.session?.runtimeMode ?? snapshot.sourceSession.runtimeMode,
        status: running ? "running" : "stopped",
        resumeCursor: snapshot.session?.resumeCursor ?? null,
        runtimePayload: { crossProviderRecovery: snapshot },
      });
    }),
    list: Effect.fn("CrossProviderAgentRecovery.list")(function* (root) {
      const records: CrossProviderAgentRecord[] = [];
      for (const binding of yield* directory.listBindings()) {
        if (!binding.threadId.startsWith(hiddenPrefix)) continue;
        const record = yield* read(binding);
        if (record?.root === root) records.push(record);
      }
      return records;
    }),
  };
}
