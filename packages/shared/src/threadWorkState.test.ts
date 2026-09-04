import { describe, expect, it } from "vite-plus/test";

import type { ThreadBackgroundWait } from "@t3tools/contracts";

import { formatThreadWaitLabel, resolveThreadWorkState } from "./threadWorkState.ts";

const session = (status: "running" | "ready" | "idle" | "starting" | "stopped" | "error") =>
  ({
    status,
    activeTurnId: status === "running" ? "turn-1" : null,
    providerName: "provider",
    updatedAt: "2026-09-04T10:00:00.000Z",
  }) as never;

const wait = (overrides?: Partial<ThreadBackgroundWait>): ThreadBackgroundWait => ({
  count: 1,
  label: "one thing",
  since: "2026-09-04T09:00:00.000Z",
  monitorOnly: false,
  ...overrides,
});

describe("resolveThreadWorkState", () => {
  it("is working while the thread's own turn is in flight, whatever else is alive", () => {
    expect(resolveThreadWorkState({ session: session("running") })).toEqual({
      state: "working",
      label: "Working",
      since: null,
      monitorOnly: false,
    });
    // Background work underneath a running turn does not demote it: the agent
    // is generating, and a message sent now steers that turn.
    expect(
      resolveThreadWorkState({ session: session("running"), backgroundWait: wait() }).state,
    ).toBe("working");
  });

  it("is waiting once the turn ends with background work still alive", () => {
    expect(
      resolveThreadWorkState({
        session: session("ready"),
        backgroundWait: wait({ count: 3, label: "3 tasks" }),
      }),
    ).toEqual({
      state: "waiting",
      label: "Waiting on 3 tasks",
      since: "2026-09-04T09:00:00.000Z",
      monitorOnly: false,
    });
  });

  it("is idle with nothing live, and treats an absent field as nothing live", () => {
    expect(resolveThreadWorkState({ session: session("ready") }).state).toBe("idle");
    expect(resolveThreadWorkState({ session: session("idle"), backgroundWait: null }).state).toBe(
      "idle",
    );
    expect(resolveThreadWorkState({ session: null }).state).toBe("idle");
  });

  it("carries monitorOnly through so the alert can treat watch loops as settled", () => {
    const status = resolveThreadWorkState({
      session: session("ready"),
      backgroundWait: wait({ monitorOnly: true }),
    });
    expect(status.state).toBe("waiting");
    expect(status.monitorOnly).toBe(true);
  });

  it("does not claim work for a session that is merely connecting or stopped", () => {
    // "starting" is a session coming up, not the agent working; surfaces
    // resolve their own Connecting state before consulting this.
    expect(resolveThreadWorkState({ session: session("starting") }).state).toBe("idle");
    expect(
      resolveThreadWorkState({ session: session("stopped"), backgroundWait: wait() }).state,
    ).toBe("waiting");
  });

  it("names compaction as a machine wait, ahead of the running session it reports through", () => {
    // Compaction reports itself as `running` so the composer refuses a fresh
    // turn; the agent is nonetheless generating nothing, and saying "Working"
    // there is the lying spinner this model exists to remove.
    expect(
      resolveThreadWorkState({
        session: session("running"),
        compactingSince: "2026-09-04T09:58:00.000Z",
      }),
    ).toEqual({
      state: "waiting",
      label: "Waiting on context compaction",
      since: "2026-09-04T09:58:00.000Z",
      monitorOnly: false,
    });
  });

  it("prefers compaction over background work, and never calls it monitor-only", () => {
    // Compaction always ends, so it must never be treated as settled by the
    // completion alert the way a watch loop is.
    const status = resolveThreadWorkState({
      session: session("running"),
      compactingSince: "2026-09-04T09:58:00.000Z",
      backgroundWait: wait({ monitorOnly: true, label: "a watch loop" }),
    });
    expect(status.label).toBe("Waiting on context compaction");
    expect(status.monitorOnly).toBe(false);
  });

  it("goes back to working when compaction ends", () => {
    expect(
      resolveThreadWorkState({ session: session("running"), compactingSince: null }).state,
    ).toBe("working");
  });

  it("renders the provider's own words after a fixed prefix", () => {
    expect(formatThreadWaitLabel(wait({ label: "pnpm test --watch" }))).toBe(
      "Waiting on pnpm test --watch",
    );
    expect(formatThreadWaitLabel(wait({ label: "Reviewer + 2 more agents" }))).toBe(
      "Waiting on Reviewer + 2 more agents",
    );
  });
});
