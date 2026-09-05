import * as Cause from "effect/Cause";
import { canResumeCrossProviderTask } from "@t3tools/client-runtime/state/subagentRuntime";
import { AsyncResult } from "effect/unstable/reactivity";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import {
  readTaskStates,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  type TaskState,
} from "@t3tools/contracts";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

const TaskControlsContext = createContext<{
  reportFailure: (message: string | null) => void;
  tasks: ReadonlyMap<string, TaskState>;
  stopping: ReadonlySet<string>;
  threadRef: ScopedThreadRef | undefined;
}>({ reportFailure: () => {}, tasks: new Map(), stopping: new Set(), threadRef: undefined });

export function TaskControls({
  activities,
  threadRef,
  children,
}: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  threadRef: ScopedThreadRef | undefined;
  children: ReactNode;
}) {
  const [localFailure, reportFailure] = useState<string | null>(null);
  const value = useMemo(() => {
    const tasks = new Map(readTaskStates(activities).map((task) => [task.id, task]));
    const stops = new Map<string, OrchestrationThreadActivity>();
    for (const activity of activities) {
      if (
        (activity.kind === "task.stop.requested" ||
          activity.kind === "task.stop.accepted" ||
          activity.kind === "task.stop.failed" ||
          activity.kind === "task.resume.requested" ||
          activity.kind === "task.resume.accepted" ||
          activity.kind === "task.resume.failed") &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "taskId" in activity.payload &&
        typeof activity.payload.taskId === "string"
      ) {
        stops.set(activity.payload.taskId, activity);
      }
    }
    const stopping = new Set(
      [...stops].flatMap(([taskId, activity]) =>
        (activity.kind === "task.stop.requested" ||
          activity.kind === "task.stop.accepted" ||
          activity.kind === "task.resume.requested" ||
          activity.kind === "task.resume.accepted") &&
        activity.createdAt > (tasks.get(taskId)?.updatedAt ?? "")
          ? [taskId]
          : [],
      ),
    );
    return { reportFailure, tasks, threadRef, stopping };
  }, [activities, threadRef]);
  const failures = activities.filter(
    (activity) => activity.kind === "task.stop.failed" || activity.kind === "task.resume.failed",
  );
  return (
    <TaskControlsContext value={value}>
      {localFailure ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive-foreground">
          {localFailure}
        </p>
      ) : null}
      {failures.slice(-1).map((failure) => (
        <p key={failure.id} role="alert" className="px-3 py-2 text-xs text-destructive-foreground">
          {failure.summary}:{" "}
          {typeof failure.payload === "object" &&
          failure.payload !== null &&
          "detail" in failure.payload
            ? String(failure.payload.detail)
            : "Please try again."}
        </p>
      ))}
      {children}
    </TaskControlsContext>
  );
}

export function TaskStopButton({
  taskId,
  label,
  active,
}: {
  taskId: string;
  label: string;
  active: boolean;
}) {
  const { tasks, stopping, threadRef, reportFailure } = use(TaskControlsContext);
  const stop = useAtomCommand(threadEnvironment.interruptTurn, "task control");
  const [pending, setPending] = useState(false);
  const task = tasks.get(taskId);
  const canResume = canResumeCrossProviderTask(task);
  const busy = pending || stopping.has(taskId);
  const canAct = canResume || task?.canStop;
  const action = canResume ? "Resume" : "Stop";
  if ((!active && !canResume) || !threadRef || !task) return null;
  const button = (
    <button
      type="button"
      aria-label={`${action} ${label}`}
      disabled={busy || !canAct}
      className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      onClick={async (event) => {
        event.stopPropagation();
        if (busy || !canAct) return;
        reportFailure(null);
        setPending(true);
        try {
          const result = await stop({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              taskId,
              scope: "self",
              ...(canResume ? { resume: true } : {}),
            },
          });
          if (AsyncResult.isFailure(result)) {
            const error = Cause.squash(result.cause);
            reportFailure(
              `Could not ${action.toLowerCase()} ${label}. ${error instanceof Error ? error.message : "Please try again."}`,
            );
          }
        } finally {
          setPending(false);
        }
      }}
    >
      {busy ? (canResume ? "Resuming…" : "Stopping…") : action}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
      <TooltipPopup>
        {canAct ? `${action} ${label}` : "This provider does not expose individual task stopping."}
      </TooltipPopup>
    </Tooltip>
  );
}
