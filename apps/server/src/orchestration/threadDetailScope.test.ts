import { EventId, ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  activityMatchesThreadDetailScope,
  eventMatchesThreadDetailScope,
  messageMatchesThreadDetailScope,
} from "./threadDetailScope.ts";

const threadId = ThreadId.make("thread-scope");

function activityEvent(
  sequence: number,
  kind: string,
  agentId?: string,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.make(`activity-${sequence}`),
        tone: "tool",
        kind,
        summary: kind,
        payload: { itemType: "command_execution", ...(agentId ? { agentId } : {}) },
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    },
  };
}

describe("thread detail agent scope", () => {
  it("scopes messages by attribution", () => {
    assert.isTrue(messageMatchesThreadDetailScope({}, undefined));
    assert.isTrue(messageMatchesThreadDetailScope({ agentId: "worker" }, undefined));
    assert.isTrue(messageMatchesThreadDetailScope({}, "root"));
    assert.isFalse(messageMatchesThreadDetailScope({ agentId: "worker" }, "root"));
    assert.isTrue(messageMatchesThreadDetailScope({ agentId: "worker" }, "agent:worker"));
    assert.isFalse(messageMatchesThreadDetailScope({ agentId: "other" }, "agent:worker"));
    assert.isFalse(messageMatchesThreadDetailScope({}, "agent:worker"));
  });

  it("keeps agent lifecycle rows in the root thread but not agent tool calls", () => {
    const rootTool = { kind: "tool.completed", payload: {} };
    const agentTool = { kind: "tool.completed", payload: { agentId: "worker" } };
    const agentTask = { kind: "task.updated", payload: { agentId: "worker" } };
    const agentRequest = { kind: "user-input.requested", payload: { agentId: "worker" } };
    assert.isTrue(activityMatchesThreadDetailScope(rootTool, "root"));
    assert.isFalse(activityMatchesThreadDetailScope(agentTool, "root"));
    assert.isTrue(activityMatchesThreadDetailScope(agentTask, "root"));
    assert.isTrue(activityMatchesThreadDetailScope(agentRequest, "root"));
    assert.isTrue(activityMatchesThreadDetailScope(agentTool, "agent:worker"));
    assert.isTrue(activityMatchesThreadDetailScope(agentTask, "agent:worker"));
    assert.isFalse(activityMatchesThreadDetailScope(rootTool, "agent:worker"));
    assert.isFalse(
      activityMatchesThreadDetailScope(
        { kind: "tool.completed", payload: { agentId: "other" } },
        "agent:worker",
      ),
    );
    assert.isTrue(activityMatchesThreadDetailScope(agentTool, undefined));
  });

  it("filters attributed events and passes thread-level events through", () => {
    assert.isTrue(eventMatchesThreadDetailScope(activityEvent(1, "tool.completed"), "root"));
    assert.isFalse(
      eventMatchesThreadDetailScope(activityEvent(2, "tool.completed", "worker"), "root"),
    );
    assert.isTrue(
      eventMatchesThreadDetailScope(activityEvent(3, "task.progress", "worker"), "root"),
    );
    assert.isTrue(
      eventMatchesThreadDetailScope(activityEvent(4, "tool.completed", "worker"), "agent:worker"),
    );
    assert.isFalse(
      eventMatchesThreadDetailScope(activityEvent(5, "tool.completed"), "agent:worker"),
    );
    const sessionEvent: OrchestrationEvent = {
      ...activityEvent(6, "tool.completed"),
      type: "thread.session-set",
      payload: {
        threadId,
        session: null,
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    } as unknown as OrchestrationEvent;
    assert.isTrue(eventMatchesThreadDetailScope(sessionEvent, "agent:worker"));
    assert.isTrue(eventMatchesThreadDetailScope(sessionEvent, "root"));
  });
});
