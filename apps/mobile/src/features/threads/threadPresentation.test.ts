import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadStatus } from "./threadPresentation";

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestTurn: null,
    session: {
      status: "ready",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const wait = {
  count: 3,
  label: "3 tasks",
  since: "2026-09-04T09:00:00.000Z",
  monitorOnly: false,
};

describe("resolveThreadStatus", () => {
  it("says nothing for a quiescent thread", () => {
    expect(resolveThreadStatus(thread())).toBeNull();
  });

  it("names the work a settled thread is waiting on", () => {
    const status = resolveThreadStatus(thread({ backgroundWait: wait }));
    expect(status?.kind).toBe("waiting");
    expect(status?.label).toBe("Waiting on 3 tasks");
    // No pulse: the agent's own turn is over and it will answer immediately.
    expect(status?.pulse).toBe(false);
  });

  it("keeps the agent's own turn ahead of the work it launched", () => {
    const status = resolveThreadStatus(
      thread({
        backgroundWait: wait,
        session: {
          status: "running",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-09-04T10:00:00.000Z",
        } as unknown as EnvironmentThreadShell["session"],
      }),
    );
    expect(status?.kind).toBe("working");
    expect(status?.label).toBe("Working");
  });

  it("keeps attention states ahead of the wait", () => {
    expect(
      resolveThreadStatus(thread({ backgroundWait: wait, hasPendingApprovals: true }))?.kind,
    ).toBe("pending-approval");
    expect(
      resolveThreadStatus(thread({ backgroundWait: wait, hasPendingUserInput: true }))?.kind,
    ).toBe("awaiting-input");
  });

  it("names compaction rather than the running session it reports through", () => {
    const status = resolveThreadStatus(
      thread({
        compactingSince: "2026-09-04T09:58:00.000Z",
        session: {
          status: "running",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-09-04T10:00:00.000Z",
        } as unknown as EnvironmentThreadShell["session"],
      }),
    );
    expect(status?.kind).toBe("waiting");
    expect(status?.label).toBe("Waiting on context compaction");
  });

  it("renders the phone label identically to the web sidebar", () => {
    // One shared derivation, so a thread cannot read as Working on one
    // surface and Waiting on the other.
    expect(
      resolveThreadStatus(thread({ backgroundWait: { ...wait, label: "Reviewer" } }))?.label,
    ).toBe("Waiting on Reviewer");
  });
});
