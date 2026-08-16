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
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";

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
          event.method === "collabAgent/prompt" &&
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
  it.live("Stop interrupts every live child regardless of registration timing", () =>
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

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

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
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
});
