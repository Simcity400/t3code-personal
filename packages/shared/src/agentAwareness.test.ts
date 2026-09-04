import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import { projectThreadAwareness } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<OrchestrationProjectShell, "title">;

function thread(
  overrides: Partial<OrchestrationThreadShell> = {},
): Pick<
  OrchestrationThreadShell,
  | "id"
  | "title"
  | "modelSelection"
  | "session"
  | "latestTurn"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundWait"
> {
  return {
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("projectThreadAwareness", () => {
  it("returns null for idle threads without an active awareness state", () => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread(),
      }),
    ).toBeNull();
  });

  it("prioritizes approval requests over running state", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        hasPendingApprovals: true,
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("waiting_for_approval");
    expect(state?.headline).toBe("Approval needed");
  });

  it("projects running provider sessions", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "running",
      headline: "Agent is working",
      detail: "Codex is active.",
      modelTitle: "gpt-5.4",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("projects completed turns as completed even when teardown settled them as interrupted", () => {
    const finishedTurn = {
      turnId: "turn-1" as TurnId,
      state: "interrupted" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    };
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: finishedTurn }),
    });

    // Session teardown settles still-running turns by session status, and
    // that write can race turn.completed; the completion timestamp is the
    // durable signal. Without this the thread resolves to null persistently
    // and gets tombstoned off the lock-screen card instead of showing Done.
    expect(state?.phase).toBe("completed");

    const trulyInterrupted = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: { ...finishedTurn, completedAt: null } }),
    });
    expect(trulyInterrupted).toBeNull();
  });

  it("projects ready sessions with no materialized turn as completed", () => {
    // Quick threads without code changes never get a checkpoint, so the SQL
    // shell has no latestTurn row and latest_turn_id is cleared when the
    // session settles; the ready session is the only completion signal left.
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "ready",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("completed");
  });

  it("projects failures with the session error detail", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "error",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Provider process exited.",
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "failed",
      headline: "Agent failed",
      detail: "Provider process exited.",
    });
  });
});

describe("projectThreadAwareness completion vs live background work", () => {
  const readySession = {
    threadId: "thread-1" as ThreadId,
    status: "ready" as const,
    providerName: "Codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
  const completedTurn = {
    turnId: "turn-1" as TurnId,
    state: "completed" as const,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    assistantMessageId: null,
  };

  const awareness = (overrides: Partial<OrchestrationThreadShell>) =>
    projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ session: readySession, ...overrides }),
    });

  it("completes normally when the turn ended with nothing left running", () => {
    expect(awareness({ latestTurn: completedTurn })?.phase).toBe("completed");
    // Same for the no-turn path: a live session at rest is Done.
    expect(awareness({})?.phase).toBe("completed");
  });

  it("withholds Done while work the turn launched is still alive, and names it", () => {
    const state = awareness({
      latestTurn: completedTurn,
      backgroundWait: {
        count: 2,
        label: "Reviewer + 1 more agent",
        since: "2026-05-22T11:00:00.000Z",
        monitorOnly: false,
      },
    });
    // Phase stays a value the hosted relay already accepts; only the copy
    // changes. "completed" is what fires the push, so this is the guard.
    expect(state?.phase).toBe("running");
    expect(state?.headline).toBe("Waiting on Reviewer + 1 more agent");
  });

  it("withholds Done on every settled path, not just the completed turn", () => {
    const wait = {
      count: 1,
      label: "one agent",
      since: NOW,
      monitorOnly: false,
    };
    expect(awareness({ backgroundWait: wait })?.phase).toBe("running");
    expect(
      awareness({
        backgroundWait: wait,
        latestTurn: { ...completedTurn, state: "interrupted" as const },
      })?.phase,
    ).toBe("running");
  });

  it("still fires Done when only watch loops are alive", () => {
    // A monitor can outlive every turn a thread will run; holding the ladder
    // open for one would suppress the completion forever, not delay it.
    const state = awareness({
      latestTurn: completedTurn,
      backgroundWait: {
        count: 1,
        label: "a watch loop",
        since: NOW,
        monitorOnly: true,
      },
    });
    expect(state?.phase).toBe("completed");
    expect(state?.headline).toBe("Agent finished");
  });

  it("leaves a genuinely running turn saying it is working", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: { ...readySession, status: "running", activeTurnId: "turn-1" as TurnId },
        backgroundWait: {
          count: 1,
          label: "one agent",
          since: NOW,
          monitorOnly: false,
        },
      }),
    });
    expect(state?.phase).toBe("running");
    expect(state?.headline).toBe("Agent is working");
  });

  it("names compaction on the card instead of claiming the agent is working", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: { ...readySession, status: "running", activeTurnId: "turn-1" as TurnId },
        compactingSince: "2026-05-22T11:58:00.000Z",
      }),
    });
    // Phase unchanged, so no completion push fires and the relay still gets a
    // value its schema accepts; only the copy tells the truth.
    expect(state?.phase).toBe("running");
    expect(state?.headline).toBe("Waiting on context compaction");
  });

  it("keeps attention states ahead of the wait", () => {
    const wait = { count: 1, label: "one agent", since: NOW, monitorOnly: false };
    expect(awareness({ hasPendingApprovals: true, backgroundWait: wait })?.phase).toBe(
      "waiting_for_approval",
    );
    expect(awareness({ hasPendingUserInput: true, backgroundWait: wait })?.phase).toBe(
      "waiting_for_input",
    );
    expect(
      awareness({
        session: { ...readySession, status: "error", lastError: "boom" },
        backgroundWait: wait,
      })?.phase,
    ).toBe("failed");
  });
});
