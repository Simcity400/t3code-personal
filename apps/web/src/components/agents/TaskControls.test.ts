import { describe, expect, it } from "vite-plus/test";
import { canResumeCrossProviderTask } from "@t3tools/client-runtime/state/subagentRuntime";
import type { TaskState } from "@t3tools/contracts";

describe("web task control resume eligibility", () => {
  const wrapper = {
    executionOwner: "cross-provider",
    taskType: "cross_provider",
    canResume: true,
    status: "interrupted",
  } satisfies Pick<TaskState, "executionOwner" | "taskType" | "canResume" | "status">;

  it.each(["interrupted", "failed", "completed", "idle"] as const)(
    "allows explicit resume of a durable %s wrapper",
    (status) => expect(canResumeCrossProviderTask({ ...wrapper, status })).toBe(true),
  );

  it.each(["pending", "running", "waiting", "cancelled"] as const)(
    "does not replace Stop with Resume for a %s task",
    (status) => expect(canResumeCrossProviderTask({ ...wrapper, status })).toBe(false),
  );

  it("requires durable capability and explicit wrapper ownership", () => {
    expect(canResumeCrossProviderTask(undefined)).toBe(false);
    expect(canResumeCrossProviderTask({ ...wrapper, canResume: false })).toBe(false);
    expect(canResumeCrossProviderTask({ ...wrapper, canResume: undefined })).toBe(false);
    expect(canResumeCrossProviderTask({ ...wrapper, executionOwner: undefined })).toBe(false);
    expect(canResumeCrossProviderTask({ ...wrapper, taskType: "local_agent" })).toBe(false);
  });
});
