import { describe, expect, it } from "vite-plus/test";
import {
  compareSubagentsInSection,
  formatSubagentElapsed,
  subagentActivityText,
  subagentStatusLabel,
} from "./subagentPresentation.ts";

describe("subagent presentation", () => {
  it("leads live rows with current activity and settled rows with the outcome", () => {
    const base = { progress: "Reading b.ts", lastToolName: "Grep", result: "Done", error: null };
    expect(subagentActivityText({ ...base, status: "running" })).toBe("Reading b.ts");
    expect(subagentActivityText({ ...base, status: "completed" })).toBe("Done");
    expect(subagentActivityText({ ...base, status: "failed", error: "boom" })).toBe("boom");
    expect(
      subagentActivityText({
        status: "waiting",
        progress: null,
        lastToolName: "Bash",
        result: null,
        error: null,
      }),
    ).toBe("▸ Bash");
  });
  it("labels every live state as working and only idle batches as plain idle", () => {
    expect(subagentStatusLabel({ kind: "subagent", status: "waiting" })).toBe("Working");
    expect(subagentStatusLabel({ kind: "subagent", status: "idle" })).toBe("Idle · resumable");
    expect(subagentStatusLabel({ kind: "subagent_batch", status: "idle" })).toBe("Idle");
    expect(subagentStatusLabel({ kind: "workflow", status: "interrupted" })).toBe("Stopped");
  });
  it("formats elapsed time and stays empty for unreadable timestamps", () => {
    const start = "2026-09-09T10:00:00.000Z";
    const now = Date.parse("2026-09-09T10:00:42.000Z");
    expect(formatSubagentElapsed(start, null, now)).toBe("42s");
    expect(formatSubagentElapsed(start, "2026-09-09T10:05:07.000Z", now)).toBe("5m 07s");
    expect(formatSubagentElapsed(start, "2026-09-09T12:05:07.000Z", now)).toBe("2h 05m");
    expect(formatSubagentElapsed("garbage", null, now)).toBe("");
  });
  it("keeps active rows in spawn order and leads idle rows with the latest to settle", () => {
    const agent = (
      id: string,
      firstSeenAt: string,
      completedAt: string | null,
      startedAt = firstSeenAt,
    ) => ({ id, firstSeenAt, completedAt, startedAt });
    const first = agent("a", "2026-09-09T10:00:00.000Z", null);
    const second = agent("b", "2026-09-09T10:01:00.000Z", null);
    const third = agent("c", "2026-09-09T10:02:00.000Z", null);
    expect(
      [third, first, second].sort(compareSubagentsInSection("active")).map((entry) => entry.id),
    ).toEqual(["a", "b", "c"]);

    // The oldest spawn finished last, so it leads; the resumable idle agent
    // has no completion time and orders by when it started.
    const finishedLast = agent("a", "2026-09-09T10:00:00.000Z", "2026-09-09T10:10:00.000Z");
    const finishedFirst = agent("b", "2026-09-09T10:01:00.000Z", "2026-09-09T10:05:00.000Z");
    const restingIdle = agent("c", "2026-09-09T10:02:00.000Z", null, "2026-09-09T10:07:00.000Z");
    expect(
      [finishedFirst, restingIdle, finishedLast]
        .sort(compareSubagentsInSection("idle"))
        .map((entry) => entry.id),
    ).toEqual(["a", "c", "b"]);
  });
});
