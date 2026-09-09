import { describe, expect, it } from "vite-plus/test";
import {
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
});
