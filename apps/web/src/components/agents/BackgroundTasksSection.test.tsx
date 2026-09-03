import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveBackgroundTasksPanelModel,
  emptyBackgroundTasksPanelModel,
  type AgentWaitState,
  type RuntimeBackgroundTask,
} from "@t3tools/client-runtime/state/backgroundTasks";

import { BackgroundTasksSection, WaitingOnStrip } from "./BackgroundTasksSection";

function task(overrides: Partial<RuntimeBackgroundTask> & { id: string }): RuntimeBackgroundTask {
  return {
    kind: "shell",
    taskType: "local_bash",
    label: overrides.id,
    ownerAgentId: null,
    status: "running",
    startedAt: "2026-09-03T10:00:00.000Z",
    endedAt: null,
    progress: null,
    result: null,
    error: null,
    backgrounded: false,
    ambient: false,
    firstSeenAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

const wait = (overrides: Partial<AgentWaitState>): AgentWaitState => ({
  ownerId: null,
  ownerLabel: "Main",
  kind: "agents",
  label: "Reviewer",
  since: "2026-09-03T10:00:00.000Z",
  blockingIds: [],
  needsUser: false,
  ...overrides,
});

describe("BackgroundTasksSection", () => {
  it("renders nothing when the thread has no background work", () => {
    expect(
      renderToStaticMarkup(<BackgroundTasksSection model={emptyBackgroundTasksPanelModel()} />),
    ).toBe("");
  });

  it("shows live work and failures, and hides successes behind the disclosure", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({
          tasks: [
            task({ id: "live", label: "pnpm test --watch" }),
            task({ id: "bad", label: "cargo build", status: "failed", error: "exit 101" }),
            task({ id: "good", label: "git fetch", status: "completed", result: "up to date" }),
          ],
        })}
      />,
    );

    expect(markup).toContain("pnpm test --watch");
    expect(markup).toContain("cargo build");
    expect(markup).toContain("exit 101");
    // Collapsed by default: the receipt is available, not in the way.
    expect(markup).not.toContain("git fetch");
    expect(markup).toContain("Finished");
    expect(markup).toContain("1 failed");
  });

  it("labels every task with its kind and marks detached and ambient work", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({
          tasks: [
            task({ id: "m", label: "watch ci", kind: "monitor", taskType: "monitor" }),
            task({ id: "b", label: "npm run dev", backgrounded: true }),
            task({ id: "a", label: "compacting", ambient: true }),
          ],
        })}
      />,
    );
    expect(markup).toContain("Monitor");
    // Visible badges, not screen-reader-only text.
    expect(markup).toContain("detached");
    expect(markup).toContain("ambient");
    expect(markup).not.toContain('sr-only">Running, detached');
  });

  it("keeps interrupted work visible instead of collapsing it as finished", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({
          tasks: [
            task({ id: "dead", label: "tail -f log", status: "interrupted" }),
            task({ id: "done", label: "git fetch", status: "completed" }),
          ],
        })}
      />,
    );
    // Interrupted work died with its session and may need restarting.
    expect(markup).toContain("tail -f log");
    expect(markup).not.toContain("git fetch");
  });

  it("attributes finished rows to their owner when several owners exist", () => {
    const model = deriveBackgroundTasksPanelModel({
      tasks: [
        task({ id: "live", label: "pnpm test", ownerAgentId: "ag-1" }),
        task({ id: "done", label: "git fetch", status: "completed", ownerAgentId: "ag-1" }),
      ],
      agentTitles: new Map([["ag-1", "Reviewer"]]),
    });
    expect(model.finished[0]?.ownerLabel).toBe("Reviewer");
  });

  it("omits owner headings when only the main agent owns tasks", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({ tasks: [task({ id: "t1", label: "pnpm test" })] })}
      />,
    );
    expect(markup).not.toContain("Main");
  });

  it("names the owning subagent once background work is split across owners", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({
          tasks: [
            task({ id: "t1", label: "pnpm test" }),
            task({ id: "t2", label: "cargo build", ownerAgentId: "ag-1" }),
          ],
          agentTitles: new Map([["ag-1", "Reviewer"]]),
        })}
      />,
    );
    expect(markup).toContain("Main");
    expect(markup).toContain("Reviewer");
  });

  it("freezes an idle task's elapsed at its last update rather than render time", () => {
    // Idle never settles, so there is no endedAt; counting to now would show
    // a number that grows on every remount.
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({
          tasks: [
            task({
              id: "resting",
              label: "watcher",
              status: "idle",
              startedAt: "2026-09-03T10:00:00.000Z",
              endedAt: null,
              updatedAt: "2026-09-03T10:00:12.000Z",
            }),
          ],
        })}
      />,
    );
    expect(markup).toContain("12s");
  });

  it("keeps a settled task's elapsed frozen at its end time", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksSection
        model={deriveBackgroundTasksPanelModel({
          tasks: [
            task({
              id: "bad",
              label: "flaky",
              status: "failed",
              startedAt: "2026-09-03T10:00:00.000Z",
              endedAt: "2026-09-03T10:00:07.000Z",
            }),
          ],
        })}
      />,
    );
    expect(markup).toContain("7s");
  });
});

describe("WaitingOnStrip", () => {
  it("renders nothing when nothing is blocked", () => {
    expect(renderToStaticMarkup(<WaitingOnStrip waits={[]} />)).toBe("");
  });

  it("renders one arrow line per blocked owner", () => {
    const markup = renderToStaticMarkup(
      <WaitingOnStrip
        waits={[
          wait({ label: "Reviewer + 1 more agent" }),
          wait({ ownerId: "ag-1", ownerLabel: "Reviewer", kind: "tasks", label: "cargo build" }),
        ]}
      />,
    );
    expect(markup).toContain("←");
    expect(markup).toContain("Reviewer + 1 more agent");
    expect(markup).toContain("cargo build");
    // The row reads "Main -> is waiting on -> <blocker>" once. It previously
    // repeated the whole sentence in sr-only text, so screen readers
    // announced every row twice.
    expect(markup).toContain('<span class="sr-only">is waiting on</span>');
    expect(markup).not.toContain("Main is waiting on Reviewer + 1 more agent");
  });

  it("tints the strip only when the user is the one holding it up", () => {
    const machine = renderToStaticMarkup(<WaitingOnStrip waits={[wait({})]} />);
    expect(machine).not.toContain("border-warning/40");

    const user = renderToStaticMarkup(
      <WaitingOnStrip
        waits={[wait({ kind: "approval", label: "Command approval", needsUser: true })]}
      />,
    );
    expect(user).toContain("border-warning/40");
    expect(user).toContain("Command approval");
  });
});
