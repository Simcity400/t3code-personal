import * as Cause from "effect/Cause";
import { canResumeCrossProviderTask } from "@t3tools/client-runtime/state/subagentRuntime";
import { AsyncResult } from "effect/unstable/reactivity";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import {
  readTaskStates,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  type TaskState,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

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
  threadRef: ScopedThreadRef;
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
      <View className="flex-1">
        {localFailure ? (
          <Text accessibilityRole="alert" className="px-3 py-2 text-xs text-danger-foreground">
            {localFailure}
          </Text>
        ) : null}
        {failures.slice(-1).map((failure) => (
          <Text
            key={failure.id}
            accessibilityRole="alert"
            className="px-3 py-2 text-xs text-danger-foreground"
          >
            {failure.summary}:{" "}
            {typeof failure.payload === "object" &&
            failure.payload !== null &&
            "detail" in failure.payload
              ? String(failure.payload.detail)
              : "Please try again."}
          </Text>
        ))}
        {children}
      </View>
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${action} ${label}`}
      accessibilityHint={
        canAct ? undefined : "This provider does not expose individual task stopping."
      }
      accessibilityState={{ disabled: busy || !canAct }}
      disabled={busy || !canAct}
      className="min-h-11 justify-center px-3"
      onPress={async (event) => {
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
      <Text className="text-xs text-foreground-muted">
        {busy ? (canResume ? "Resuming…" : "Stopping…") : action}
      </Text>
    </Pressable>
  );
}
