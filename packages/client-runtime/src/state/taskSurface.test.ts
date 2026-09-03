import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTaskSurfaces } from "./taskSurface.ts";

let sequence = 0;

/** Post-ingestion row: ingestion stamps agentKind with the same classifier. */
function activity(kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: {
      ...payload,
      agentKind: classifyTaskAgentKind({
        taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
        agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
      }),
    },
    turnId: null,
    createdAt: `2026-09-04T10:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

/** A row with an explicit stamp, bypassing the classifier. */
function stamped(
  kind: string,
  payload: Record<string, unknown>,
  agentKind?: "agent" | "background",
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: agentKind === undefined ? payload : { ...payload, agentKind },
    turnId: null,
    createdAt: `2026-09-04T10:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

describe("deriveTaskSurfaces", () => {
  it("gives an agent-stamped row with agent-shaped evidence to the roster", () => {
    const surfaces = deriveTaskSurfaces([
      activity("task.started", { taskId: "a-1", taskType: "local_agent", role: "reviewer" }),
    ]);
    expect(surfaces.get("a-1")).toBe("agent");
  });

  it("gives a described background row to the tasks panel", () => {
    const surfaces = deriveTaskSurfaces([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
    ]);
    expect(surfaces.get("sh-1")).toBe("background");
  });

  /**
   * The G3 case. A resumed session has no remembered linkage, so the terminal
   * notification carries only taskId + status and ingestion's classifier
   * defaults it to "agent". Judged on its own that row is an agent; judged
   * with its siblings the task is plainly the shell that started earlier.
   */
  it("keeps a described shell on one surface when a thin terminal row is stamped agent", () => {
    const surfaces = deriveTaskSurfaces([
      activity("task.started", { taskId: "sh-1", taskType: "local_bash", detail: "pnpm test" }),
      stamped("task.completed", { taskId: "sh-1", status: "completed" }, "agent"),
    ]);
    expect(surfaces.get("sh-1")).toBe("background");
  });

  it("resolves contradictory evidence to the roster", () => {
    // Both surfaces have a positive claim. Agent wins, matching what the
    // roster fold did before membership was shared, so a real subagent is
    // never demoted into Tasks.
    const surfaces = deriveTaskSurfaces([
      activity("task.started", { taskId: "x-1", taskType: "local_agent", role: "reviewer" }),
      stamped("task.progress", { taskId: "x-1", detail: "still going" }, "background"),
    ]);
    expect(surfaces.get("x-1")).toBe("agent");
  });

  it("leaves a bare agent stamp with no evidence to the roster", () => {
    const surfaces = deriveTaskSurfaces([
      stamped("task.completed", { taskId: "orphan", status: "completed" }, "agent"),
    ]);
    expect(surfaces.get("orphan")).toBe("agent");
  });

  it("claims nothing for an unstamped row that describes nothing", () => {
    // A legacy pre-stamp row with no descriptive field: neither surface can
    // honestly claim it, and it still renders in the ordinary work log.
    const surfaces = deriveTaskSurfaces([stamped("task.completed", { taskId: "legacy" })]);
    expect(surfaces.get("legacy")).toBe("unclassified");
  });

  it("treats a synthesized child's timeline bypass as agent evidence", () => {
    const surfaces = deriveTaskSurfaces([
      stamped("task.progress", { taskId: "codex-1", timelineBypass: true }, "agent"),
    ]);
    expect(surfaces.get("codex-1")).toBe("agent");
  });

  it("counts recovered launch detail as background evidence", () => {
    // A snapshot-repaired monitor may carry its MCP server/tool and nothing
    // else descriptive; that is still a positive description of real work.
    const surfaces = deriveTaskSurfaces([
      stamped(
        "task.updated",
        { taskId: "mon-1", server: "github", tool: "list_issues" },
        "background",
      ),
    ]);
    expect(surfaces.get("mon-1")).toBe("background");
  });

  it("ignores rows with no task id", () => {
    expect(deriveTaskSurfaces([activity("approval.requested", { requestId: "r1" })]).size).toBe(0);
  });
});
