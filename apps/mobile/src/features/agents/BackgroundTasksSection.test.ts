import {
  deriveBackgroundTasksPanelModel,
  type AgentWaitState,
  type RuntimeBackgroundTask,
} from "@t3tools/client-runtime/state/backgroundTasks";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { BackgroundTasksSection, WaitingOnSection } from "./BackgroundTasksSection";

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));

const clock = { nowMs: Date.parse("2026-09-04T10:00:30.000Z"), tick: 1, reduceMotion: false };

function task(overrides: Partial<RuntimeBackgroundTask> & { id: string }): RuntimeBackgroundTask {
  return {
    kind: "shell",
    taskType: "local_bash",
    label: overrides.id,
    command: null,
    server: null,
    tool: null,
    ownerAgentId: null,
    status: "running",
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: null,
    progress: null,
    result: null,
    error: null,
    backgrounded: false,
    ambient: false,
    firstSeenAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
    ...overrides,
  };
}

function renderedText(element: Parameters<typeof create>[0]): string {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(element);
  });
  return JSON.stringify(renderer!.toJSON());
}

describe("mobile BackgroundTasksSection", () => {
  it("names a monitor by its MCP server and tool", () => {
    const markup = renderedText(
      createElement(BackgroundTasksSection, {
        model: deriveBackgroundTasksPanelModel({
          tasks: [
            task({
              id: "mon-1",
              kind: "monitor",
              taskType: "monitor_mcp",
              label: "github/list_issues",
              server: "github",
              tool: "list_issues",
            }),
          ],
        }),
        clock,
        chevronColor: "#fff",
      }),
    );
    // Without it every watch loop in a thread reads as the same anonymous
    // "Monitor" row.
    expect(markup).toContain("github · list_issues");
  });

  it("leads a shell row with its command line", () => {
    const markup = renderedText(
      createElement(BackgroundTasksSection, {
        model: deriveBackgroundTasksPanelModel({
          tasks: [task({ id: "sh-1", label: "pnpm test --watch", command: "pnpm test --watch" })],
        }),
        clock,
        chevronColor: "#fff",
      }),
    );
    expect(markup).toContain("pnpm test --watch");
  });
});

describe("mobile WaitingOnSection", () => {
  it("prints the compacting wait as a machine wait", () => {
    const wait: AgentWaitState = {
      ownerId: null,
      ownerLabel: "Main",
      kind: "compacting",
      label: "Compacting context",
      since: "2026-09-04T10:00:00.000Z",
      blockingIds: [],
      needsUser: false,
    };
    const markup = renderedText(createElement(WaitingOnSection, { waits: [wait], clock }));
    expect(markup).toContain("Main");
    expect(markup).toContain("Compacting context");
    // No user action shortens a compaction, so the section stays untinted.
    expect(markup).not.toContain("border-danger-border");
  });
});
