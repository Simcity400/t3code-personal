import { createElement } from "react";
import { Pressable } from "react-native";
import { act, create } from "react-test-renderer";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  EventId,
  ThreadId,
  type OrchestrationThreadActivity,
  type TaskState,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ interrupt: vi.fn() }));
vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { interruptTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.interrupt }));

import { TaskControls, TaskStopButton } from "./TaskControls";

const threadRef = {
  environmentId: EnvironmentId.make("remote-env"),
  threadId: ThreadId.make("thread-1"),
};
const task: TaskState = {
  id: "task-1",
  agentKind: "agent",
  kind: "subagent",
  executionOwner: "cross-provider",
  taskType: "cross_provider",
  canResume: true,
  title: "Reviewer",
  role: null,
  model: null,
  effort: null,
  status: "interrupted",
  waitReason: null,
  waitingSince: null,
  asynchronous: true,
  activationCount: 1,
  usage: null,
  progress: null,
  lastToolName: null,
  result: null,
  error: null,
  outputFile: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  command: null,
  server: null,
  tool: null,
  canStop: false,
  backgrounded: false,
  ambient: false,
  firstSeenAt: "2026-09-05T00:00:00.000Z",
  startedAt: "2026-09-05T00:00:00.000Z",
  completedAt: "2026-09-05T00:00:01.000Z",
  updatedAt: "2026-09-05T00:00:01.000Z",
};

function activity(kind: string, payload: unknown, second = 2): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${kind}-${second}`),
    kind,
    payload,
    tone: "info",
    summary: kind,
    turnId: null,
    createdAt: `2026-09-05T00:00:0${second}.000Z`,
  };
}

function taskControlActivity(
  action: "stop" | "resume",
  status: "requested" | "accepted" | "failed",
  detail?: string,
): OrchestrationThreadActivity {
  return {
    ...activity(`task.${action}.${status}`, { taskId: task.id, ...(detail ? { detail } : {}) }),
    id: EventId.make(`task-${action}:${JSON.stringify([threadRef.threadId, task.id])}`),
  };
}

describe("mobile task controls", () => {
  let renderer: ReturnType<typeof create> | undefined;
  function renderTask(currentTask: TaskState, events: OrchestrationThreadActivity[] = []) {
    const tree = createElement(TaskControls, {
      threadRef,
      activities: [activity("task.state", currentTask, 1), ...events],
      children: createElement(TaskStopButton, {
        taskId: currentTask.id,
        label: currentTask.title,
        active: currentTask.status === "running",
      }),
    });
    act(() => {
      if (renderer) renderer.update(tree);
      else renderer = create(tree);
    });
  }
  function button(label: string) {
    return renderer!.root.find(
      (node) => node.type === Pressable && node.props.accessibilityLabel === label,
    );
  }
  beforeEach(() =>
    commands.interrupt.mockReset().mockResolvedValue(AsyncResult.success({ sequence: 1 })),
  );
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it.each(["interrupted", "failed", "completed", "idle"] as const)(
    "resumes a %s durable wrapper with the same scoped task ID",
    async (status) => {
      renderTask({ ...task, status });
      await act(async () => button("Resume Reviewer").props.onPress({ stopPropagation() {} }));
      expect(commands.interrupt).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, taskId: task.id, scope: "self", resume: true },
      });
      renderTask({ ...task, executionOwner: undefined });
      expect(renderer!.root.findAll((node) => node.type === Pressable)).toHaveLength(0);
      renderTask({ ...task, taskType: "local_agent" });
      expect(renderer!.root.findAll((node) => node.type === Pressable)).toHaveLength(0);
      renderTask({ ...task, status: "cancelled" });
      expect(renderer!.root.findAll((node) => node.type === Pressable)).toHaveLength(0);
    },
  );

  it.each([false, undefined])(
    "hides Resume for an orphan wrapper with canResume=%s",
    (canResume) => {
      renderTask({ ...task, canResume });
      expect(renderer!.root.findAll((node) => node.type === Pressable)).toHaveLength(0);
      expect(commands.interrupt).not.toHaveBeenCalled();
    },
  );

  it("keeps Resume pending after acceptance and permits Stop after the task runs again", async () => {
    const events = [
      activity("task.stop.requested", { taskId: task.id }, 0),
      taskControlActivity("resume", "requested"),
    ];
    renderTask(task, events);
    expect(button("Resuming Reviewer").props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    // The projection replaces the request with acceptance under the same ID.
    events[1] = taskControlActivity("resume", "accepted");
    renderTask(task, events);
    expect(button("Resuming Reviewer").props.disabled).toBe(true);
    renderTask(
      { ...task, status: "running", canStop: true, updatedAt: "2026-09-05T00:00:04.000Z" },
      events,
    );
    expect(button("Stop Reviewer").props.disabled).toBe(false);
    await act(async () => button("Stop Reviewer").props.onPress({ stopPropagation() {} }));
    expect(commands.interrupt).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, taskId: task.id, scope: "self" },
    });
  });

  it("keeps Stop pending when acceptance replaces the request until newer task state arrives", () => {
    const runningTask = { ...task, status: "running" as const, canStop: true };
    renderTask(runningTask, [taskControlActivity("stop", "requested")]);
    expect(button("Stopping Reviewer").props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    renderTask(runningTask, [taskControlActivity("stop", "accepted")]);
    expect(button("Stopping Reviewer").props.disabled).toBe(true);
    renderTask({ ...runningTask, updatedAt: "2026-09-05T00:00:04.000Z" }, [
      taskControlActivity("stop", "accepted"),
    ]);
    expect(button("Stop Reviewer").props.disabled).toBe(false);
  });

  it.each(["stop", "resume"] as const)(
    "reports %s failure replacing the pending activity and enables retry",
    (action) => {
      const currentTask =
        action === "stop" ? { ...task, status: "running" as const, canStop: true } : task;
      const label = action === "stop" ? "Stop Reviewer" : "Resume Reviewer";
      const busyLabel = action === "stop" ? "Stopping Reviewer" : "Resuming Reviewer";
      renderTask(currentTask, [taskControlActivity(action, "requested")]);
      expect(button(busyLabel).props.disabled).toBe(true);
      renderTask(currentTask, [taskControlActivity(action, "accepted")]);
      expect(button(busyLabel).props.disabled).toBe(true);
      renderTask(currentTask, [taskControlActivity(action, "failed", "Action unavailable")]);
      expect(button(label).props.disabled).toBe(false);
      expect(JSON.stringify(renderer!.toJSON())).toContain("Action unavailable");
    },
  );

  it("reports command failure with the Resume action and clears the local pending state", async () => {
    commands.interrupt.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Connection lost"))),
    );
    renderTask(task);
    await act(async () => button("Resume Reviewer").props.onPress({ stopPropagation() {} }));
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Could not resume Reviewer. Connection lost",
    );
    expect(button("Resume Reviewer").props.disabled).toBe(false);
  });

  it("does not permit Stop for a provider task without individual stopping support", () => {
    renderTask({ ...task, status: "running", executionOwner: undefined });
    expect(button("Stop Reviewer").props.disabled).toBe(true);
  });
});
