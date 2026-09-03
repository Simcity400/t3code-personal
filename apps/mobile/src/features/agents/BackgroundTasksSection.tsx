/**
 * Mobile counterpart of the web Agents panel's background-task surface.
 *
 * Same shared model (`@t3tools/client-runtime/state/backgroundTasks`), same
 * rules — live work and failures visible, successes behind a disclosure, one
 * arrow line per blocked owner. Only the markup differs.
 *
 * Elapsed times read from the existing agent status clock rather than a
 * second interval, and rows memo on the tick so a settled task never
 * re-renders while a watch loop ticks beside it.
 */
import {
  formatElapsedBetween,
  isActiveBackgroundTaskStatus,
  type AgentWaitState,
  type BackgroundTasksPanelModel,
  type BackgroundTaskKind,
  type RuntimeBackgroundTask,
} from "@t3tools/client-runtime/state/backgroundTasks";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { AgentStatusClockSnapshot } from "./agentStatusClock";

const TASK_KIND_LABEL: Record<BackgroundTaskKind, string> = {
  shell: "Shell",
  monitor: "Monitor",
  plan: "Plan",
  other: "Task",
};

function taskStatusLabel(task: RuntimeBackgroundTask): string {
  switch (task.status) {
    case "pending":
      return "Starting";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
  }
}

function taskDetailText(task: RuntimeBackgroundTask): string | null {
  return isActiveBackgroundTaskStatus(task.status)
    ? (task.progress ?? task.error ?? task.result)
    : (task.error ?? task.result ?? task.progress);
}

function TaskRowImpl({
  task,
  clock,
  ownerLabel,
}: {
  readonly task: RuntimeBackgroundTask;
  readonly clock: AgentStatusClockSnapshot;
  readonly ownerLabel?: string | undefined;
}) {
  const live = isActiveBackgroundTaskStatus(task.status);
  // An idle task never settled, so it has no endedAt; freeze it at the last
  // word from the provider rather than at render time.
  const elapsed =
    task.startedAt === null
      ? null
      : formatElapsedBetween(
          task.startedAt,
          live ? null : (task.endedAt ?? task.updatedAt),
          clock.nowMs,
        );
  const detail = taskDetailText(task);
  const status = taskStatusLabel(task);
  const badges = [
    ownerLabel,
    TASK_KIND_LABEL[task.kind],
    task.backgrounded ? "detached" : null,
    task.ambient ? "ambient" : null,
  ].filter((value): value is string => value !== undefined && value !== null);

  return (
    <View className="rounded-xl bg-card px-3 py-2">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {task.label}
        </Text>
        <Text
          accessibilityLabel={elapsed ? `${status}, ${elapsed}` : status}
          className="tabular-nums text-xs text-foreground-muted"
        >
          {status}
          {elapsed ? ` · ${elapsed}` : ""}
        </Text>
      </View>
      <Text
        className={
          task.status === "failed"
            ? "mt-1 text-xs text-danger-foreground"
            : "mt-1 text-xs text-foreground-muted"
        }
        numberOfLines={1}
      >
        {detail ?? TASK_KIND_LABEL[task.kind]}
      </Text>
      <Text className="mt-0.5 text-xs uppercase text-foreground-tertiary" numberOfLines={1}>
        {badges.join(" · ")}
      </Text>
    </View>
  );
}

// The clock publishes a snapshot every second while anything is active;
// settled rows render from endedAt and can ignore every tick.
const TaskRow = memo(
  TaskRowImpl,
  (prev, next) =>
    prev.task === next.task &&
    prev.ownerLabel === next.ownerLabel &&
    (!isActiveBackgroundTaskStatus(next.task.status) || prev.clock.tick === next.clock.tick),
);

export function WaitingOnSection({
  waits,
  clock,
}: {
  readonly waits: ReadonlyArray<AgentWaitState>;
  readonly clock: AgentStatusClockSnapshot;
}) {
  if (waits.length === 0) return null;
  const needsUser = waits.some((wait) => wait.needsUser);
  return (
    <View
      accessibilityLabel="Waiting on"
      className={
        needsUser
          ? "gap-1 rounded-2xl border border-danger-border bg-card/40 p-2"
          : "gap-1 rounded-2xl border border-border bg-card/20 p-2"
      }
    >
      <View className="flex-row items-center gap-2 px-1 py-1">
        <Text
          className={
            needsUser
              ? "text-xs font-t3-semibold uppercase tracking-wider text-danger-foreground"
              : "text-xs font-t3-semibold uppercase tracking-wider text-foreground-muted"
          }
        >
          Waiting on
        </Text>
        <Text className="text-xs text-foreground-muted">{waits.length}</Text>
      </View>
      {waits.map((wait) => (
        <View
          key={`${wait.ownerId ?? "main"}:${wait.kind}`}
          accessibilityLabel={`${wait.ownerLabel} is waiting on ${wait.label}`}
          className="flex-row items-center gap-2 px-1"
        >
          <Text className="shrink-0 text-xs font-t3-semibold text-foreground" numberOfLines={1}>
            {wait.ownerLabel}
          </Text>
          <Text className="shrink-0 text-xs text-foreground-muted">{"←"}</Text>
          <Text
            className={
              wait.needsUser
                ? "min-w-0 flex-1 text-xs text-danger-foreground"
                : "min-w-0 flex-1 text-xs text-foreground-muted"
            }
            numberOfLines={1}
          >
            {wait.label}
          </Text>
          {wait.since ? (
            <Text className="shrink-0 tabular-nums text-xs text-foreground-muted">
              {formatElapsedBetween(wait.since, null, clock.nowMs)}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function BackgroundTasksSection({
  model,
  clock,
}: {
  readonly model: BackgroundTasksPanelModel;
  readonly clock: AgentStatusClockSnapshot;
}) {
  const [finishedOpen, setFinishedOpen] = useState(false);
  const chevronColor = useThemeColor("--color-chevron");
  if (!model.hasTasks) return null;

  const showOwners = model.groups.length > 1 || model.groups[0]?.ownerId !== null;

  return (
    <View
      className={
        model.activeCount > 0
          ? "gap-2 rounded-2xl border border-primary/25 bg-card/40 p-2"
          : "gap-2 rounded-2xl border border-border bg-card/20 p-2"
      }
    >
      <View className="flex-row items-center gap-2 px-1 py-1">
        <Text
          className={
            model.activeCount > 0
              ? "text-xs font-t3-semibold uppercase tracking-wider text-primary"
              : "text-xs font-t3-semibold uppercase tracking-wider text-foreground-muted"
          }
        >
          Tasks
        </Text>
        <Text className="text-xs text-foreground-muted">{model.totalCount}</Text>
        {model.failedCount > 0 ? (
          <Text className="ml-auto text-xs text-danger-foreground">{model.failedCount} failed</Text>
        ) : null}
      </View>
      {model.groups.map((group) => (
        <View key={group.ownerId ?? "main"} className="gap-2">
          {showOwners ? (
            <Text
              className="px-1 text-xs font-t3-semibold uppercase tracking-wider text-foreground-muted"
              numberOfLines={1}
            >
              {group.ownerLabel}
            </Text>
          ) : null}
          {group.tasks.map((task) => (
            <TaskRow key={task.id} task={task} clock={clock} />
          ))}
        </View>
      ))}
      {model.finished.length > 0 ? (
        <View className="gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${finishedOpen ? "Hide" : "Show"} finished tasks`}
            accessibilityState={{ expanded: finishedOpen }}
            onPress={() => setFinishedOpen((value) => !value)}
            className="flex-row items-center gap-2 rounded-lg px-1 py-1 active:opacity-70"
          >
            <SymbolView
              name={finishedOpen ? "chevron.down" : "chevron.right"}
              size={14}
              tintColor={chevronColor}
              type="monochrome"
            />
            <Text className="text-xs font-t3-semibold uppercase tracking-wider text-foreground-muted">
              Finished
            </Text>
            <Text className="text-xs text-foreground-muted">{model.finished.length}</Text>
          </Pressable>
          {finishedOpen
            ? model.finished.map((entry) => (
                <TaskRow
                  key={entry.task.id}
                  task={entry.task}
                  clock={clock}
                  ownerLabel={showOwners ? entry.ownerLabel : undefined}
                />
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}
