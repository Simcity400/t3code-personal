import { describe, expect, it } from "vite-plus/test";

import {
  agentStatusAccessibilityLabel,
  formatAgentElapsed,
  workingDotOpacities,
} from "./ThreadAgentsRouteScreen.logic";

describe("formatAgentElapsed", () => {
  const startedAt = "2026-08-17T00:00:00.000Z";

  it("shows a live seconds counter from zero", () => {
    expect(formatAgentElapsed(startedAt, Date.parse(startedAt))).toBe("0s");
    expect(formatAgentElapsed(startedAt, Date.parse("2026-08-17T00:00:17.800Z"))).toBe("17s");
  });

  it("keeps useful precision for longer work", () => {
    expect(formatAgentElapsed(startedAt, Date.parse("2026-08-17T00:03:09.000Z"))).toBe("3m 09s");
    expect(formatAgentElapsed(startedAt, Date.parse("2026-08-17T02:05:09.000Z"))).toBe("2h 05m");
  });

  it("rejects invalid or backwards timestamps", () => {
    expect(formatAgentElapsed("invalid", Date.parse(startedAt))).toBeNull();
    expect(formatAgentElapsed(startedAt, Date.parse("2026-08-16T23:59:59.000Z"))).toBeNull();
  });
});

describe("agent status presentation", () => {
  it("keeps three fixed-width dot slots while animating", () => {
    expect(workingDotOpacities(0, false)).toEqual([0.18, 0.18, 0.18]);
    expect(workingDotOpacities(2, false)).toEqual([1, 1, 0.18]);
    expect(workingDotOpacities(3, true)).toEqual([1, 1, 1]);
    expect(workingDotOpacities(99, false)).toHaveLength(3);
  });

  it("includes working state and elapsed time in the accessible name", () => {
    expect(agentStatusAccessibilityLabel("Working", "17s")).toBe("Working, 17s");
    expect(agentStatusAccessibilityLabel("Completed", null)).toBe("Completed");
  });
});
