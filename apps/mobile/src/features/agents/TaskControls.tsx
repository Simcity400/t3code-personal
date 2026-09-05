import * as Cause from "effect/Cause";
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
import { SymbolView } from "../../components/AppSymbol";
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
  const stop = useAtomCommand(threadEnvironment.interruptTurn, "stop task");
  const [pending, setPending] = useState(false);
  const task = tasks.get(taskId);
  const busy = pending || stopping.has(taskId);
  if (!active || !threadRef || !task) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy ? `Stopping ${label}` : `Stop ${label}`}
      accessibilityHint={
        task.canStop ? undefined : "This provider does not expose individual task stopping."
      }
      accessibilityState={{ disabled: busy || !task.canStop, busy }}
      disabled={busy || !task.canStop}
      className="min-h-11 min-w-11 items-center justify-center disabled:opacity-50"
      onPress={async (event) => {
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
      <SymbolView name="stop.fill" size={14} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}
