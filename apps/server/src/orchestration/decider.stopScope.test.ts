import {
  ApprovalRequestId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  readTaskStates,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { taskStateActivity, updateTaskState } from "./taskState.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("root");
const commandId = CommandId.make("control");

function model(activities: OrchestrationThreadActivity[] = []): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Root",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        messages: [],
        proposedPlans: [],
        activities,
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: now,
  };
}

function task(
  id: string,
  owner?: "cross-provider",
  status = "running",
  taskType = owner ? "cross_provider" : "subagent",
  canResume = owner !== undefined,
): OrchestrationThreadActivity {
  const state = updateTaskState(undefined, {
    id: EventId.make(id),
    kind: "task.started",
    tone: "info",
    summary: id,
    turnId: null,
    createdAt: now,
    payload: { taskId: id, taskType, status, executionOwner: owner, canResume },
  });
  if (!state) throw new Error("Expected task state");
  return taskStateActivity(threadId, { ...state, ...(owner ? { executionOwner: owner } : {}) });
}

it.layer(NodeServices.layer)("scoped agent controls", (it) => {
  it.effect("defaults legacy interrupts to self and preserves explicit Stop all scope", () =>
    Effect.gen(function* () {
      for (const scope of [undefined, "self", "tree"] as const) {
        const result = yield* decideOrchestrationCommand({
          readModel: model(),
          command: {
            type: "thread.turn.interrupt",
            commandId,
            threadId,
            createdAt: now,
            ...(scope ? { scope } : {}),
          },
        });
        expect(result).toMatchObject({
          type: "thread.turn-interrupt-requested",
          payload: { threadId, scope: scope ?? "self" },
        });
      }
    }),
  );

  it.effect("resumes only an inactive resumable cross-provider task belonging to this root", () =>
    Effect.gen(function* () {
      const readModel = model([
        task("bridge", "cross-provider", "interrupted"),
        task("native", undefined, "interrupted"),
        task("bridge-native", "cross-provider", "interrupted", "subagent"),
        task("orphan", "cross-provider", "interrupted", "cross_provider", false),
        task("active", "cross-provider"),
        task("pending", "cross-provider", "pending"),
        task("waiting", "cross-provider", "waiting"),
        task("failed", "cross-provider", "failed"),
        task("completed", "cross-provider", "completed"),
        task("idle", "cross-provider", "idle"),
        task("cancelled", "cross-provider", "cancelled"),
      ]);
      const command = {
        type: "thread.turn.interrupt" as const,
        commandId,
        threadId,
        createdAt: now,
        taskId: "bridge",
        resume: true,
      };
      expect(yield* decideOrchestrationCommand({ readModel, command })).toMatchObject({
        type: "thread.turn-interrupt-requested",
        payload: { taskId: "bridge", scope: "self", resume: true },
      });
      for (const taskId of ["failed", "completed", "idle"]) {
        expect(
          yield* decideOrchestrationCommand({ readModel, command: { ...command, taskId } }),
        ).toMatchObject({
          type: "thread.turn-interrupt-requested",
          payload: { taskId, resume: true },
        });
      }
      expect(
        (yield* decideOrchestrationCommand({ readModel, command, taskState: null }).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      for (const taskId of [
        undefined,
        "foreign",
        "native",
        "bridge-native",
        "orphan",
        "active",
        "pending",
        "waiting",
        "cancelled",
      ]) {
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: { ...command, taskId },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      for (const resume of [true, false]) {
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: { ...command, scope: "tree", resume },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  );

  it.effect("parent stop, interruption and error leave independently owned tasks active", () =>
    Effect.gen(function* () {
      const readModel = model([
        task("bridge", "cross-provider"),
        task("native"),
        task("waiting", "cross-provider", "waiting"),
      ]);
      for (const status of ["stopped", "interrupted", "error"] as const) {
        const session: OrchestrationSession = {
          threadId,
          status,
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        };
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: { type: "thread.session.set", commandId, threadId, createdAt: now, session },
        });
        const events = Array.isArray(result) ? result : [result];
        const tasks = readTaskStates(
          events.flatMap((event) =>
            event.type === "thread.activity-appended" ? [event.payload.activity] : [],
          ),
        );
        expect(tasks.map((task) => [task.id, task.status])).toEqual([["native", "interrupted"]]);
      }
    }),
  );

  it.effect(
    "routes validated asynchronous bridge answers without starting or resolving the parent turn",
    () =>
      Effect.gen(function* () {
        const request: OrchestrationThreadActivity = {
          id: EventId.make("question"),
          kind: "user-input.requested",
          summary: "Question",
          tone: "info",
          turnId: null,
          createdAt: now,
          payload: {
            requestId: "request",
            responseMode: "message",
            delivery: "agent",
            agentId: "bridge",
            questions: [{ id: "q", header: "Pick", question: "Which?", options: [] }],
          },
        };
        const command = {
          type: "thread.user-input.respond" as const,
          commandId,
          threadId,
          createdAt: now,
          requestId: ApprovalRequestId.make("request"),
          answers: { q: "One" },
        };
        expect(
          yield* decideOrchestrationCommand({
            readModel: model(),
            command,
            userInputActivity: request,
          }),
        ).toMatchObject({
          type: "thread.user-input-response-requested",
          payload: { requestId: "request", answers: { q: "One" } },
        });
        const blank = yield* decideOrchestrationCommand({
          readModel: model(),
          command: { ...command, answers: { q: " " } },
          userInputActivity: request,
        }).pipe(Effect.result);
        expect(blank._tag).toBe("Failure");
        const answered = yield* decideOrchestrationCommand({
          readModel: model(),
          command,
          userInputActivity: { ...request, kind: "user-input.resolved" },
        }).pipe(Effect.result);
        expect(answered._tag).toBe("Failure");
      }),
  );
});
