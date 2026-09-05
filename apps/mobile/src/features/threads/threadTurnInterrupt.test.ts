import { ThreadId, TurnId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveThreadWorkState } from "@t3tools/shared/threadWorkState";
import { buildThreadTurnInterruptInput } from "./threadTurnInterrupt";

const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const session = {
  status: "running",
  activeTurnId: turnId,
} as OrchestrationThreadShell["session"];

describe("buildThreadTurnInterruptInput", () => {
  it("targets only the active main turn by default", () => {
    expect(buildThreadTurnInterruptInput({ id: threadId, session })).toEqual({
      threadId,
      turnId,
      scope: "self",
    });
  });

  it("does not reuse a turn id from an idle session", () => {
    expect(
      buildThreadTurnInterruptInput({ id: threadId, session: { ...session!, status: "ready" } }),
    ).toEqual({
      threadId,
      scope: "self",
    });
  });

  it("addresses the root tree with no task or turn id, including after the turn ends", () => {
    for (const currentSession of [session, { ...session!, status: "ready" as const }, null]) {
      expect(
        buildThreadTurnInterruptInput({ id: threadId, session: currentSession }, "tree"),
      ).toEqual({
        threadId,
        scope: "tree",
      });
    }
  });

  it("retains the background waiting action after the main session stops", () => {
    const thread = {
      id: threadId,
      session: { ...session!, status: "stopped" as const, activeTurnId: null },
      backgroundWait: { count: 1, label: "Reviewer", since: null, monitorOnly: false },
    };
    expect(resolveThreadWorkState(thread)).toMatchObject({
      state: "waiting",
      label: "Waiting on Reviewer",
    });
    expect(buildThreadTurnInterruptInput(thread, "tree")).toEqual({ threadId, scope: "tree" });
  });
});
