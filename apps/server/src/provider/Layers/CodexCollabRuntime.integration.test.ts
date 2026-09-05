/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type ProviderApprovalDecision, type ProviderEvent, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";
const encodeMockPeerScript = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMcpElicitationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Unknown,
    }),
  ),
);

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildNativeRollout(rolloutPath: string): string {
  const rows = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_fixture_spawn_a",
        arguments: JSON.stringify({
          task_name: "mobile_reviewer",
          message: "Inspect the native mobile transcript.",
        }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        agent_thread_id: CHILD_A,
        agent_path: "/root/mobile_reviewer",
        kind: "started",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_fixture_spawn_a",
        output: JSON.stringify({ task_name: "/root/mobile_reviewer" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_fixture_spawn_b",
        arguments: JSON.stringify({
          task_name: "desktop_reviewer",
          message: "Inspect the desktop transcript.",
        }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        agent_thread_id: CHILD_B,
        agent_path: "/root/desktop_reviewer",
        kind: "started",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_fixture_spawn_b",
        output: JSON.stringify({ task_name: "/root/desktop_reviewer" }),
      },
    },
  ];
  NodeFS.writeFileSync(rolloutPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return rolloutPath;
}

function buildScript(rolloutPath: string) {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  const emptyThreadReadResponse = {
    thread: {
      ...wireFixture.responses.threadStart.thread,
      path: rolloutPath,
      turns: [],
    },
  };
  return {
    rootThreadId: ROOT,
    // The real failing wire has no high-level collabAgentToolCall in either
    // snapshot. Recovery must use the native rollout path instead.
    threadReadResponses: [emptyThreadReadResponse, emptyThreadReadResponse],
    turnCompleteDelayMs: 500,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

function capturedStartedActivity(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => {
    const item = (entry.params as { item?: { type?: string; kind?: string } }).item;
    return item?.type === "subAgentActivity" && item.kind === "started";
  });
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      ...captured.params,
      item: {
        ...captured.params.item,
        agentThreadId: childId,
        agentPath: "/root/model-check",
      },
    },
  };
}

function capturedSpawnedThread(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => entry.method === "thread/started");
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      thread: {
        ...captured.params.thread,
        id: childId,
        sessionId: childId,
        parentThreadId: ROOT,
        agentNickname: "model-check",
        agentRole: "verifier",
        source: {
          subAgent: {
            thread_spawn: {
              agent_nickname: "model-check",
              agent_path: "/root/model-check",
              agent_role: "verifier",
              depth: 1,
              parent_thread_id: ROOT,
            },
          },
        },
      },
    },
  };
}

function childSettings(threadId: string, model: string, effort: string) {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        collaborationMode: { mode: "default", settings: { model } },
        cwd: "/workspace/repo",
        effort,
        model,
        modelProvider: "openai",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  };
}

function readRecordedRequests() {
  return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = (platform: string) =>
  NodePath.join(
    import.meta.dirname,
    `../testFixtures/codexCollabMockPeer.${platform === "win32" ? "cmd" : "sh"}`,
  );
const peerModulePath = NodePath.join(
  import.meta.dirname,
  "../testFixtures/codexCollabMockPeer.mjs",
);
const peerEnvironment = { T3_CODEX_COLLAB_PEER: peerModulePath };

describe("CodexSessionRuntime collab integration", () => {
  it.effect("looks up child model metadata once after activity registration", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          capturedStartedActivity(),
          capturedStartedActivity(),
          {
            ...capturedStartedActivity(CHILD_B),
            params: {
              ...capturedStartedActivity(CHILD_B).params,
              item: { ...capturedStartedActivity(CHILD_B).params.item, kind: "interacted" },
            },
          },
          { method: "thread/closed", params: { threadId: CHILD_B } },
          capturedSpawnedThread(ROOT),
        ],
        childResumeSnapshots: {
          [CHILD_A]: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-activity"),
        binaryPath: peerPath(platform),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: {
          ...process.env,
          ...peerEnvironment,
          T3_CODEX_COLLAB_SCRIPT: scriptPath,
        },
      });
      const metadataFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/metadataUpdated" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      const session = yield* runtime.start();
      assert.equal(session.model, "gpt-5.6-sol");
      yield* runtime.sendTurn({ input: "start one child" });
      const metadataEvents = Array.from(yield* Fiber.join(metadataFiber));
      assert.deepInclude(metadataEvents[0]?.payload, {
        agentThreadId: CHILD_A,
        model: "gpt-5.6-luna",
        effort: "low",
      });
      assert.deepEqual(readRecordedRequests(), [
        {
          method: "thread/resume",
          params: { threadId: CHILD_A, excludeTurns: true },
        },
      ]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps child settings and reroutes newer than the resume snapshot", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const statusChanged = wireFixture.notifications.find(
        (entry) =>
          entry.method === "thread/status/changed" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      assert.isDefined(statusChanged);
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          childSettings(CHILD_A, "child-before", "medium"),
          capturedSpawnedThread(),
          childSettings(CHILD_A, "child-after", "high"),
          {
            method: "model/rerouted",
            params: {
              threadId: CHILD_A,
              turnId: `${CHILD_A}-turn`,
              fromModel: "child-after",
              toModel: "child-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
          {
            method: "model/rerouted",
            params: {
              threadId: ROOT,
              turnId: `${ROOT}-turn`,
              fromModel: "gpt-5.6-sol",
              toModel: "root-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
        ],
        childResumeSnapshots: {
          [CHILD_A]: {
            model: "stale-snapshot",
            reasoningEffort: "low",
            notifications: [statusChanged],
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-spawn"),
        binaryPath: peerPath(platform),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: {
          ...process.env,
          ...peerEnvironment,
          T3_CODEX_COLLAB_SCRIPT: scriptPath,
        },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.method === "collabAgent/statusChanged" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one spawned child" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find((event) => event.method === "collabAgent/started");
      assert.deepInclude(started?.payload, {
        agentThreadId: CHILD_A,
        model: "child-before",
        effort: "medium",
      });
      const childStatus = events.find((event) => event.method === "collabAgent/statusChanged");
      assert.deepInclude(childStatus?.payload, {
        agentThreadId: CHILD_A,
        model: "child-rerouted",
        effort: "high",
      });
      assert.isTrue(
        events.some(
          (event) =>
            event.method === "model/rerouted" &&
            (event.payload as { threadId?: string }).threadId === ROOT,
        ),
        "the root reroute must stay on the parent path",
      );
      assert.isFalse(
        events.some(
          (event) =>
            (event.method === "thread/settings/updated" || event.method === "model/rerouted") &&
            (event.payload as { threadId?: string }).threadId === CHILD_A,
        ),
        "child metadata notifications must not leak to the parent path",
      );
      assert.equal(readRecordedRequests().length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not delay the parent turn when the child lookup fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      for (const [name, childSnapshot] of [
        ["hang", { hang: true }],
        ["error", { error: "child unavailable" }],
      ] as const) {
        yield* Effect.gen(function* () {
          const marker = `lookup-${name}`;
          const script = {
            rootThreadId: ROOT,
            recordRequests: true,
            resumeRequestMarker: marker,
            notifications: [capturedStartedActivity()],
            childResumeSnapshots: { [CHILD_A]: childSnapshot },
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });

          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-collab-model-${name}`),
            binaryPath: peerPath(platform),
            cwd: "/tmp",
            runtimeMode: "full-access",
            environment: {
              ...process.env,
              ...peerEnvironment,
              T3_CODEX_COLLAB_SCRIPT: scriptPath,
            },
          });
          const eventsFiber = yield* runtime.events.pipe(
            Stream.takeUntil(
              (event) =>
                event.method === "serverRequest/resolved" &&
                (event.payload as { requestId?: string }).requestId === marker,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "finish without child metadata" });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.isTrue(events.some((event) => event.method === "turn/completed"));
          assert.equal(readRecordedRequests().length, 1);

          yield* runtime.close;
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const rolloutPath = `${scriptPath}.rollout.jsonl`;
      buildNativeRollout(rolloutPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript(rolloutPath)), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(rolloutPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: peerPath(platform),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: {
          ...process.env,
          ...peerEnvironment,
          T3_CODEX_COLLAB_SCRIPT: scriptPath,
        },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");
      const childPrompt = events.find(
        (event) =>
          event.method === "collabAgent/prompt" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.equal(
        (childPrompt?.payload as { prompt?: string } | undefined)?.prompt,
        "Inspect the native mobile transcript.",
        "the native rollout recovers the exact launch prompt",
      );
      const secondChildPrompt = events.find(
        (event) =>
          event.method === "collabAgent/prompt" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.equal(
        (secondChildPrompt?.payload as { prompt?: string } | undefined)?.prompt,
        "Inspect the desktop transcript.",
        "one incremental rollout scan caches and emits every child prompt",
      );

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("backfills native launch prompts when an existing thread is reopened", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const rolloutPath = `${scriptPath}.reopen.rollout.jsonl`;
      buildNativeRollout(rolloutPath);
      const script = {
        rootThreadId: ROOT,
        notifications: [],
        threadOpenResponse: {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          cwd: platform === "win32" ? "C:\\tmp" : "/tmp",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          sandbox: { type: "dangerFullAccess" },
          thread: {
            ...wireFixture.responses.threadStart.thread,
            id: ROOT,
            path: rolloutPath,
            turns: [],
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(rolloutPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-reopen"),
        binaryPath: peerPath(platform),
        cwd: "/tmp",
        runtimeMode: "full-access",
        resumeCursor: { threadId: ROOT },
        environment: {
          ...process.env,
          ...peerEnvironment,
          T3_CODEX_COLLAB_SCRIPT: scriptPath,
        },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "session/ready"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const recovered = events.find(
        (event) =>
          event.method === "collabAgent/historicalPrompt" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.equal(
        (recovered?.payload as { prompt?: string } | undefined)?.prompt,
        "Inspect the native mobile transcript.",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("self Stop preserves children; tree Stop reports failures", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const memoryThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: MEMORY,
            sessionId: MEMORY,
            source: "unknown",
            threadSource: "memory_consolidation",
          },
        },
      };
      const memoryTurnStarted = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: MEMORY,
          turn: { ...turnStartedA.params.turn, id: "memory-consolidation-turn" },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [
          turnStartedA,
          registrationA,
          memoryThreadStarted,
          memoryTurnStarted,
          registrationB,
          turnStartedB,
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: peerPath(platform),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: {
          ...process.env,
          ...peerEnvironment,
          T3_CODEX_COLLAB_SCRIPT: scriptPath,
        },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      yield* runtime.interruptTurn(undefined, CHILD_B);
      // Only B is stopped: the main agent and A have not received any interrupt.
      const individual = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId: string });
      assert.deepEqual(
        individual.map((entry) => entry.threadId),
        [CHILD_B],
      );
      const unknownStop = yield* runtime
        .interruptTurn(undefined, "not-a-child")
        .pipe(Effect.result);
      assert.equal(unknownStop._tag, "Failure");

      yield* runtime.interruptTurn();
      yield* runtime.interruptTurn(undefined, undefined, "self");
      const selfInterrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId: string });
      assert.deepEqual(
        selfInterrupts.map((entry) => entry.threadId),
        [CHILD_B, ROOT, ROOT],
      );

      // Stop everything. The parent must be interrupted before child cleanup,
      // and A's hung interrupt must not prevent other cancellation attempts.
      const treeResult = yield* runtime
        .interruptTurn(undefined, undefined, "tree")
        .pipe(Effect.result);
      assert.equal(treeResult._tag, "Failure");
      if (treeResult._tag === "Failure") {
        assert.include(treeResult.failure.message, "not confirmed");
      }

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(
        interruptedThreads.has(MEMORY),
        "memory consolidation must be interrupted without appearing in chat",
      );
      assert.equal(interrupted[selfInterrupts.length]?.threadId, ROOT);
      assert.equal(interrupted.filter((entry) => entry.threadId === CHILD_A).length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const failParent of [false, true]) {
    it.live(
      `tree Stop includes racing launches and new turns (parent failure: ${failParent})`,
      () =>
        Effect.gen(function* () {
          const platform = yield* HostProcessPlatform;
          const started = (threadId: string) =>
            wireFixture.notifications.find(
              (entry) => entry.method === "turn/started" && entry.params.threadId === threadId,
            );
          const registration = (threadId: string) =>
            wireFixture.notifications.find(
              (entry) =>
                entry.method === "item/completed" &&
                "item" in entry.params &&
                entry.params.item.type === "subAgentActivity" &&
                entry.params.item.agentThreadId === threadId,
            );
          const turnA = started(CHILD_A);
          const turnB = started(CHILD_B);
          const registerA = registration(CHILD_A);
          const registerB = registration(CHILD_B);
          assert.isDefined(turnA);
          assert.isDefined(turnB);
          assert.isDefined(turnA.params.turn);
          assert.isDefined(turnB.params.turn);
          assert.isDefined(registerA);
          assert.isDefined(registerB);
          const replacementTurnId = "child-a-racing-turn";
          const script = {
            rootThreadId: ROOT,
            holdTurnOpen: true,
            ...(failParent ? { failInterruptFor: ROOT } : {}),
            notifications: [registerA, turnA],
            interruptNotifications: {
              [CHILD_A]: [
                [
                  registerB,
                  turnB,
                  {
                    ...turnA,
                    params: {
                      ...turnA.params,
                      turn: { ...turnA.params.turn, id: replacementTurnId },
                    },
                  },
                ],
              ],
            },
          };
          NodeFS.writeFileSync(scriptPath, yield* encodeMockPeerScript(script), "utf8");
          const interruptsPath = `${scriptPath}.interrupts`;
          NodeFS.rmSync(interruptsPath, { force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              NodeFS.rmSync(scriptPath, { force: true });
              NodeFS.rmSync(interruptsPath, { force: true });
            }),
          );
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make("thread-collab-stop-race"),
            binaryPath: peerPath(platform),
            cwd: "/tmp",
            runtimeMode: "full-access",
            environment: { ...process.env, ...peerEnvironment, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const ready = yield* runtime.events.pipe(
            Stream.filter((event) => event.method === "collabAgent/turnStarted"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* runtime.start();
          const parent = yield* runtime.sendTurn({ input: "Launch during cancellation" });
          yield* Fiber.join(ready);
          const result = yield* runtime
            .interruptTurn(undefined, undefined, "tree")
            .pipe(Effect.result);
          assert.equal(result._tag, failParent ? "Failure" : "Success");
          if (result._tag === "Failure")
            assert.include(result.failure.message, "thread already closed");
          const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { threadId: string; turnId: string });
          assert.deepEqual(interrupts[0], { threadId: ROOT, turnId: parent.turnId });
          assert.deepEqual(interrupts.slice(1), [
            { threadId: CHILD_A, turnId: turnA.params.turn.id },
            { threadId: CHILD_A, turnId: replacementTurnId },
            { threadId: CHILD_B, turnId: turnB.params.turn.id },
          ]);
          yield* runtime.close;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath(platform),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: {
          ...process.env,
          ...peerEnvironment,
          T3_CODEX_COLLAB_SCRIPT: scriptPath,
        },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const elicitationCases = [
    {
      decision: "accept",
      response: { action: "accept", content: { approval: "once" } },
    },
    {
      decision: "acceptForSession",
      response: {
        action: "accept",
        _meta: { persist: "session" },
        content: { approval: "session" },
      },
    },
    {
      decision: "acceptAlways",
      response: {
        action: "accept",
        _meta: { persist: "always" },
        content: { approval: "always" },
      },
    },
    { decision: "decline", response: { action: "decline" } },
    { decision: "cancel", response: { action: "cancel" } },
  ] satisfies ReadonlyArray<{
    readonly decision: ProviderApprovalDecision;
    readonly response: Record<string, unknown>;
  }>;

  for (const { decision, response } of elicitationCases) {
    it.live(`returns the MCP elicitation ${decision} response to Codex`, () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const scriptedRequest = {
          id: 7001,
          method: "mcpServer/elicitation/request",
          params: {
            mode: "form",
            message: "Allow ChatGPT to use Safari?",
            serverName: "computer-use",
            threadId: ROOT,
            turnId: wireFixture.responses.turnStart.turn.id,
            _meta: { app_name: "Safari", persist: ["session", "always"] },
            requestedSchema: {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  enum: ["once", "session", "always"],
                },
              },
              required: ["approval"],
            },
          },
        };
        const script = {
          rootThreadId: ROOT,
          holdTurnOpen: true,
          completeTurnOnServerResponse: true,
          notifications: [],
          serverRequests: [scriptedRequest],
        };
        const responsesPath = `${scriptPath}.responses`;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(responsesPath, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(responsesPath, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-mcp-elicitation"),
          binaryPath: peerPath(platform),
          cwd: "/tmp",
          runtimeMode: "auto",
          environment: {
            ...process.env,
            ...peerEnvironment,
            T3_CODEX_COLLAB_SCRIPT: scriptPath,
          },
        });
        const approvalRequested = yield* Deferred.make<ProviderEvent>();
        const turnCompleted = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.method === "mcpServer/elicitation/request"
              ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
              : event.method === "turn/completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        );

        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Open Safari" });
        const approval = yield* Deferred.await(approvalRequested);
        assert.equal(approval.requestKind, "mcp-elicitation");
        assert.isDefined(approval.requestId);
        if (approval.requestId === undefined) return;

        yield* runtime.respondToRequest(approval.requestId, decision);
        yield* Deferred.await(turnCompleted);

        const recordedResponse = yield* decodeMcpElicitationResponse(
          NodeFS.readFileSync(responsesPath, "utf8"),
        );
        assert.equal(recordedResponse.id, scriptedRequest.id);
        assert.deepEqual(recordedResponse.result, response);

        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});

for (const earlyContent of [false, true]) {
  it.live(
    `registers receiver-only children and isolates their transcript (early=${earlyContent})`,
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const childMessageId = "receiver-only-message";
        const script = {
          rootThreadId: ROOT,
          notifications: [
            {
              method: "item/completed",
              params: {
                threadId: ROOT,
                turnId: "parent-turn",
                completedAtMs: 1,
                item: {
                  type: "collabAgentToolCall",
                  id: "receiver-spawn",
                  tool: "spawnAgent",
                  status: "completed",
                  senderThreadId: ROOT,
                  receiverThreadIds: [CHILD_A, ROOT],
                  prompt: "Review the change",
                  agentsStates: { [CHILD_A]: { status: "pendingInit", message: null } },
                },
              },
            },
            {
              method: "item/agentMessage/delta",
              params: {
                threadId: CHILD_A,
                turnId: "child-turn",
                itemId: childMessageId,
                delta: "Child reply",
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: CHILD_A,
                turnId: "child-turn",
                completedAtMs: 2,
                item: { type: "agentMessage", id: childMessageId, text: "Child reply" },
              },
            },
          ],
        };
        if (earlyContent) script.notifications.unshift(script.notifications.splice(1, 1)[0]!);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("receiver-parent"),
          binaryPath: peerPath(platform),
          cwd: import.meta.dirname,
          runtimeMode: "full-access",
          environment: { ...process.env, ...peerEnvironment, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const collected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.method === "turn/completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Review" });
        const events = Array.from(yield* Fiber.join(collected));
        const registration = events.find((event) => event.method === "collabAgent/started");
        assert.equal((registration?.payload as { agentThreadId?: string })?.agentThreadId, CHILD_A);
        const messages = events.filter((event) => event.itemId === childMessageId);
        assert.deepEqual(
          messages.map((event) => event.method),
          ["collabAgent/contentDelta", "collabAgent/item"],
        );
        for (const event of messages)
          assert.equal((event.payload as { agentThreadId?: string }).agentThreadId, CHILD_A);
        assert.isFalse(
          events.some(
            (event) =>
              event.method.startsWith("collabAgent/") &&
              (event.payload as { agentThreadId?: string })?.agentThreadId === ROOT,
          ),
        );
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

for (const [receiverStatus, turnStatus, emitStarted] of [
  ["completed", "completed", false],
  ["completed", "completed", true],
  ["errored", "failed", true],
  ["notFound", "failed", true],
  ["interrupted", "interrupted", true],
  ["shutdown", "interrupted", true],
] as const) {
  it.live(
    `restores a ${receiverStatus} receiver (wait started: ${emitStarted}) without a later child lifecycle`,
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const script = {
          rootThreadId: ROOT,
          notifications: [
            {
              method: "turn/started",
              params: {
                threadId: CHILD_A,
                turn: { id: "early-child-turn", items: [], status: "inProgress", error: null },
              },
            },
            ...(emitStarted
              ? [
                  {
                    method: "item/started",
                    params: {
                      threadId: ROOT,
                      turnId: "parent-turn",
                      startedAtMs: 0,
                      item: {
                        type: "collabAgentToolCall",
                        id: "receiver-wait",
                        tool: "wait",
                        status: "inProgress",
                        senderThreadId: ROOT,
                        receiverThreadIds: [CHILD_A],
                        prompt: null,
                        agentsStates: { [CHILD_A]: { status: "running", message: null } },
                      },
                    },
                  },
                ]
              : []),
            {
              method: "item/completed",
              params: {
                threadId: ROOT,
                turnId: "parent-turn",
                completedAtMs: 1,
                item: {
                  type: "collabAgentToolCall",
                  id: "receiver-wait",
                  tool: "wait",
                  status: "completed",
                  senderThreadId: ROOT,
                  receiverThreadIds: [CHILD_A],
                  prompt: null,
                  agentsStates: { [CHILD_A]: { status: receiverStatus, message: null } },
                },
              },
            },
          ],
        };
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("receiver-parent"),
          binaryPath: peerPath(platform),
          cwd: import.meta.dirname,
          runtimeMode: "full-access",
          environment: { ...process.env, ...peerEnvironment, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const collected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.method === "turn/completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Read the result" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(events.filter((event) => event.method === "collabAgent/started").length, 1);
        const settled = events.find((event) => event.method === "collabAgent/turnCompleted");
        assert.include(settled?.payload, { agentThreadId: CHILD_A });
        assert.deepEqual((settled?.payload as { turn?: unknown } | undefined)?.turn, {
          status: turnStatus,
        });
        const lifecycle = events.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" ||
            event.method === "collabAgent/turnCompleted",
        );
        assert.equal(lifecycle.at(-1)?.method, "collabAgent/turnCompleted");
        const stopped = yield* runtime.interruptTurn(undefined, CHILD_A).pipe(Effect.result);
        assert.equal(stopped._tag, "Failure");
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
