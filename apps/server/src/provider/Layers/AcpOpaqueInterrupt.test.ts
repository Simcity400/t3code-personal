import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CursorSettings, GrokSettings, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/schema";
import { vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

const mock = vi.hoisted(() => ({ makeRuntime: vi.fn() }));
vi.mock("../acp/CursorAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/CursorAcpSupport.ts")>()),
  makeCursorAcpRuntime: mock.makeRuntime,
}));
vi.mock("../acp/GrokAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/GrokAcpSupport.ts")>()),
  makeGrokAcpRuntime: mock.makeRuntime,
}));

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opaque-interrupt-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

for (const provider of ["cursor", "grok"] as const) {
  it.effect(`${provider} rejects opaque self Stop and reserves native cancellation for tree`, () =>
    Effect.gen(function* () {
      const cancelledSessions: string[] = [];
      const dispatched = yield* Queue.unbounded<void>();
      let sessionCount = 0;
      mock.makeRuntime.mockImplementation(() =>
        Effect.gen(function* () {
          const sessionId = `native-${++sessionCount}`;
          const completion = yield* Deferred.make<AcpSchema.PromptResponse>();
          return {
            handleExtRequest: () => Effect.void,
            handleExtNotification: () => Effect.void,
            handleRequestPermission: () => Effect.void,
            start: () =>
              Effect.succeed({
                sessionId,
                initializeResult: { protocolVersion: 1 },
                sessionSetupResult: { sessionId },
                modelConfigId: undefined,
              }),
            getEvents: () => Stream.never,
            drainEvents: Effect.void,
            getModeState: Effect.succeed(undefined),
            getConfigOptions: Effect.succeed([]),
            setMode: () => Effect.succeed({}),
            setModel: () => Effect.void,
            prompt: (_payload, options) =>
              Effect.gen(function* () {
                if (options?.dispatched) yield* Deferred.succeed(options.dispatched, undefined);
                yield* Queue.offer(dispatched, undefined);
                return yield* Deferred.await(completion);
              }),
            cancel: Effect.gen(function* () {
              cancelledSessions.push(sessionId);
              yield* Deferred.succeed(completion, { stopReason: "cancelled" });
            }),
          } satisfies Partial<AcpSessionRuntime["Service"]>;
        }),
      );
      const adapter = yield* provider === "cursor"
        ? makeCursorAdapter(decodeCursorSettings({}))
        : makeGrokAdapter(decodeGrokSettings({}));
      assert.isFalse(adapter.capabilities.isolatedTurnInterrupt);
      assert.isFalse(adapter.capabilities.nativeDescendantsObservable);
      const selected = ThreadId.make(`${provider}-selected`);
      const independent = ThreadId.make(`${provider}-independent`);
      for (const threadId of [selected, independent]) {
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter
          .sendTurn({ threadId, input: "Keep working", attachments: [] })
          .pipe(Effect.forkChild);
        yield* Queue.take(dispatched);
      }
      const before = yield* adapter.listSessions();
      const selectedTurn = before.find((session) => session.threadId === selected)?.activeTurnId;
      assert.isDefined(selectedTurn);
      for (const scope of [undefined, "self"] as const) {
        const result = yield* adapter
          .interruptTurn(selected, selectedTurn, scope)
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "ProviderAdapterValidationError");
          assert.match(result.failure.message, /native descendants.*Stop all/);
        }
        assert.deepEqual(cancelledSessions, []);
        assert.deepEqual(yield* adapter.listSessions(), before);
      }
      yield* adapter.interruptTurn(selected, selectedTurn, "tree");
      assert.deepEqual(cancelledSessions, ["native-1"]);
      assert.deepEqual(
        (yield* adapter.listSessions()).find((session) => session.threadId === independent),
        before.find((session) => session.threadId === independent),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
}
