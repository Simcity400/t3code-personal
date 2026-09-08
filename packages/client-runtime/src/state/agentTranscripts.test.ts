import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isAgentMessage, selectAgentTranscript } from "./agentTranscripts.ts";

const at = "2026-09-08T00:00:00.000Z";
function message(id: string, agentId?: string): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text: id,
    agentId,
    turnId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}
function activity(id: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "tool.completed",
    summary: id,
    tone: "tool",
    turnId: null,
    createdAt: at,
    payload,
  };
}

describe("agent transcripts", () => {
  it("isolates interleaved agent messages and activities without claiming unattributed history", () => {
    const messages = [
      message("root"),
      message("child", "agent-a"),
      message("sibling", "agent-b"),
      message("child-next", "agent-a"),
    ];
    const activities = [
      activity("root-tool", {}),
      activity("child-tool", { agentId: "agent-a" }),
      activity("sibling-tool", { agentId: "agent-b" }),
      activity("descendant-tool", { agentId: "agent-c", parentAgentId: "agent-a" }),
      activity("lifecycle", { taskId: "agent-a" }),
    ];
    const scoped = selectAgentTranscript(messages, activities, "agent-a");
    expect(scoped.messages.map((row) => row.text)).toEqual(["child", "child-next"]);
    expect(scoped.activities.map((row) => row.summary)).toEqual(["child-tool"]);
    expect(messages.filter((row) => !isAgentMessage(row)).map((row) => row.text)).toEqual(["root"]);
  });

  it("removes routing stamps from copies while preserving stored content and the source attribution", () => {
    const storedMessage = Object.freeze({ ...message("answer", "agent-a"), streaming: true });
    const payload = Object.freeze({
      agentId: "agent-a",
      timelineBypass: true,
      itemType: "reasoning",
      detail: "Consider the two options",
      data: { output: "full output" },
    });
    const storedActivity = Object.freeze(activity("reasoning", payload));
    const scoped = selectAgentTranscript(
      Object.freeze([storedMessage]),
      Object.freeze([storedActivity]),
      "agent-a",
    );
    expect(scoped.messages[0]).toMatchObject({ text: "answer", streaming: true });
    expect(isAgentMessage(scoped.messages[0]!)).toBe(false);
    expect(scoped.activities[0]?.payload).toEqual({
      itemType: "reasoning",
      detail: "Consider the two options",
      data: payload.data,
    });
    expect(storedMessage.agentId).toBe("agent-a");
    expect(storedActivity.payload).toBe(payload);
    expect(payload.timelineBypass).toBe(true);
  });

  it("ignores malformed payloads and never treats an empty selection as the root transcript", () => {
    const activities = [null, "text", 42, [], { agentId: 123 }, { agentId: "" }].map(
      (payload, index) => activity(String(index), payload),
    );
    expect(selectAgentTranscript([], activities, "agent-a")).toEqual({
      messages: [],
      activities: [],
    });
    expect(selectAgentTranscript([message("root")], activities, " ")).toEqual({
      messages: [],
      activities: [],
    });
    expect(isAgentMessage(message("legacy", " "))).toBe(false);
  });
});
