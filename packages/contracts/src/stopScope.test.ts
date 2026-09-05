import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientOrchestrationCommand } from "./orchestration.ts";
import { ProviderInterruptTurnInput } from "./provider.ts";

describe.each([
  ["provider", Schema.decodeUnknownSync(ProviderInterruptTurnInput)],
  ["client", Schema.decodeUnknownSync(ClientOrchestrationCommand)],
] as const)("%s interrupt scope", (_name, decode) => {
  const base = {
    type: "thread.turn.interrupt",
    commandId: "stop-1",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts legacy, selected-agent, and explicit root tree stops", () => {
    expect(decode(base)).toMatchObject({ threadId: "thread-1" });
    expect(decode({ ...base, scope: "self", taskId: "child" })).toMatchObject({
      scope: "self",
      taskId: "child",
    });
    expect(decode({ ...base, scope: "tree" })).toMatchObject({ scope: "tree" });
  });

  it("accepts explicit child resume and rejects root or tree resume", () => {
    expect(decode({ ...base, taskId: "child", resume: true })).toMatchObject({
      taskId: "child",
      resume: true,
    });
    expect(() => decode({ ...base, resume: true })).toThrow();
    expect(() => decode({ ...base, scope: "tree", taskId: "child", resume: true })).toThrow();
  });

  it("rejects unknown scopes and subtree controls", () => {
    expect(() => decode({ ...base, scope: "everything" })).toThrow();
    expect(() => decode({ ...base, taskId: "child", scope: "tree" })).toThrow();
  });
});
