import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { Square } from "lucide-react";
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
  const value = useMemo(
    () => ({
      reportFailure,
      tasks: new Map(readTaskStates(activities).map((task) => [task.id, task])),
      threadRef,
      stopping: new Set(
        activities.flatMap((activity) =>
          activity.kind === "task.stop.requested" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          "taskId" in activity.payload &&
          typeof activity.payload.taskId === "string"
            ? [activity.payload.taskId]
            : [],
        ),
      ),
    }),
    [activities, threadRef],
  );
  const failures = activities.filter((activity) => activity.kind === "task.stop.failed");
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
  const stop = useAtomCommand(threadEnvironment.interruptTurn, "stop task");
  const [pending, setPending] = useState(false);
  const task = tasks.get(taskId);
  const busy = pending || stopping.has(taskId);
  if (!active || !threadRef || !task) return null;
  const button = (
    <button
      type="button"
      aria-label={busy ? `Stopping ${label}` : `Stop ${label}`}
      aria-busy={busy}
      disabled={busy || !task.canStop}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-50"
      onClick={async (event) => {
        event.stopPropagation();
        if (busy || !task.canStop) return;
        reportFailure(null);
        setPending(true);
        try {
          const result = await stop({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, taskId },
          });
          if (AsyncResult.isFailure(result)) {
            const error = Cause.squash(result.cause);
            reportFailure(
              `Could not stop ${label}. ${error instanceof Error ? error.message : "Please try again."}`,
            );
          }
        } finally {
          setPending(false);
        }
      }}
    >
      <Square aria-hidden className="size-3 fill-current" />
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
      <TooltipPopup>
        {busy
          ? `Stopping ${label}…`
          : task.canStop
            ? `Stop ${label}`
            : "This provider does not expose individual task stopping."}
      </TooltipPopup>
    </Tooltip>
  );
}
