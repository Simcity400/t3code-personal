import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentTitle,
  subagentPanelSection,
  filterWorkflowForPanelSection,
} from "./agentPanelPresentation";
let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("formatSubagentTitle", () => {
  it("humanizes provider task keys and preserves familiar product casing", () => {
    expect(formatSubagentTitle("verify_iphone_transcript")).toBe("Verify iPhone transcript");
    expect(formatSubagentTitle("test-t3-mobile")).toBe("Test T3 mobile");
    expect(formatSubagentTitle("claude_api_review")).toBe("Claude API review");
    expect(formatSubagentTitle("constructor_review")).toBe("Constructor review");
  });

  it("preserves explicit titles and opaque identifiers", () => {
    expect(formatSubagentTitle("Review the mobile transcript")).toBe(
      "Review the mobile transcript",
    );
    expect(formatSubagentTitle("01a00487-efa7-7592-9855-eb10be42717c")).toBe(
      "01a00487-efa7-7592-9855-eb10be42717c",
    );
  });
});

describe("agent panel sections", () => {
  it("puts working states on top and every non-working state under idle", () => {
    expect(subagentPanelSection("pending")).toBe("active");
    expect(subagentPanelSection("running")).toBe("active");
    expect(subagentPanelSection("waiting")).toBe("active");
    expect(subagentPanelSection("idle")).toBe("idle");
    expect(subagentPanelSection("completed")).toBe("idle");
    expect(subagentPanelSection("failed")).toBe("idle");
    expect(subagentPanelSection("interrupted")).toBe("idle");
  });

  it("splits mixed workflows without moving idle members into active", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-section",
        taskType: "local_workflow",
        status: "running",
      }),
      activity("task.progress", {
        taskId: "wf-section:wf:0",
        parentAgentId: "wf-section",
        phaseIndex: 0,
        status: "running",
      }),
      activity("task.progress", {
        taskId: "wf-section:wf:1",
        parentAgentId: "wf-section",
        phaseIndex: 0,
        status: "completed",
      }),
      activity("task.progress", {
        taskId: "wf-section:wf:2",
        parentAgentId: "wf-section",
        phaseIndex: 0,
        status: "idle",
      }),
    ]);
    const group = deriveAgentPanelModel({ agents }).workflows[0]!;
    const active = filterWorkflowForPanelSection(group, "active");
    const idle = filterWorkflowForPanelSection(group, "idle");

    expect(group.workflow.status).toBe("running");
    expect(active?.phases.flatMap((phase) => phase.members).map((member) => member.id)).toEqual([
      "wf-section:wf:0",
    ]);
    expect(idle?.phases.flatMap((phase) => phase.members).map((member) => member.id)).toEqual([
      "wf-section:wf:1",
      "wf-section:wf:2",
    ]);
    expect(active?.workflow.status).toBe("running");
    expect(idle?.workflow.status).toBe("idle");
    expect(idle?.phases[0]).toMatchObject({ state: "running", activeCount: 1, settledCount: 1 });
  });
});
