/**
 * The Agents panel's background-task surface: a "Waiting on" strip and a
 * "Tasks" section, both derived from the same durable activity stream as the
 * subagent roster they sit beside.
 *
 * Visualization rules follow the roster's:
 * - Static status dots. No continuously repainting animation.
 * - Elapsed timers self-tick via DOM writes, zero React commits per second.
 * - Rows reserve a fixed height, so a progress line arriving cannot reflow
 *   the list under the reader's cursor.
 * - Live work and failures stay visible; successes collapse behind a
 *   disclosure, because a finished task is a receipt and a failed one is a
 *   reason the thread is quietly wrong.
 */
import {
  backgroundTaskSourceLabel,
  isActiveBackgroundTaskStatus,
  formatElapsedBetween,
  type AgentWaitState,
  type BackgroundTaskGroup,
  type BackgroundTaskKind,
  type BackgroundTasksPanelModel,
  type BackgroundTaskStatus,
  type RuntimeBackgroundTask,
} from "@t3tools/client-runtime/state/backgroundTasks";
import {
  Box,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Layers,
  MessageSquare,
  Radar,
  ShieldAlert,
  Terminal,
  Users,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Same dot vocabulary as the agent roster so one legend reads across both
 * sections: every in-flight state is one steady "Working", only settled
 * states differentiate.
 */
const TASK_STATUS_VISUALS: Record<BackgroundTaskStatus, { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Starting" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Interrupted" },
};

const TASK_KIND_ICON: Record<BackgroundTaskKind, typeof Terminal> = {
  shell: Terminal,
  monitor: Radar,
  plan: ClipboardList,
  other: Box,
};

const TASK_KIND_LABEL: Record<BackgroundTaskKind, string> = {
  shell: "Shell",
  monitor: "Monitor",
  plan: "Plan",
  other: "Task",
};

/**
 * One 1s interval for the whole panel, not one per row.
 *
 * A thread can hold hundreds of background rows; a timer each meant hundreds
 * of wakeups a second on a surface the repo explicitly asks to keep cheap.
 * Subscribers are plain callbacks that write text into their own node, so a
 * tick still costs zero React commits. The interval exists only while at
 * least one live row is mounted.
 */
const elapsedTickers = new Set<() => void>();
let elapsedIntervalId: ReturnType<typeof setInterval> | null = null;

export function subscribeElapsedTick(tick: () => void): () => void {
  elapsedTickers.add(tick);
  if (elapsedIntervalId === null) {
    elapsedIntervalId = setInterval(() => {
      for (const listener of elapsedTickers) listener();
    }, 1000);
  }
  return () => {
    elapsedTickers.delete(tick);
    if (elapsedTickers.size === 0 && elapsedIntervalId !== null) {
      clearInterval(elapsedIntervalId);
      elapsedIntervalId = null;
    }
  };
}

/**
 * Elapsed for one row. Live rows self-tick through a DOM write; settled rows
 * freeze and never subscribe.
 *
 * `endedAt` is the settle instant when there is one. A task that is idle
 * rather than terminal has none, so it freezes at the last time the provider
 * said anything about it (`updatedAt`) — counting to render time instead
 * would show an arbitrary number that grows every time the panel remounts.
 */
function TaskElapsed({
  startedAt,
  endedAt,
  live,
}: {
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
}) {
  const textRef = useRef<HTMLSpanElement>(null);

  // A live row's first value is written here, not during render: reading the
  // clock while rendering is impure, and a layout effect still lands before
  // paint so there is no flash of an empty timer.
  useLayoutEffect(() => {
    if (!live || startedAt === null) return;
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsedBetween(startedAt, null, Date.now());
      }
    };
    update();
    return subscribeElapsedTick(update);
  }, [live, startedAt]);

  if (startedAt === null) return null;
  return (
    <span ref={textRef} className="tabular-nums">
      {/* Settled rows render their final value directly — `now` is unused
          once an end instant is known, so this stays pure. */}
      {live ? "" : formatElapsedBetween(startedAt, endedAt, 0)}
    </span>
  );
}

/** Live rows lead with what is happening; settled rows lead with the outcome. */
function taskDetailText(task: RuntimeBackgroundTask): string | null {
  if (isActiveBackgroundTaskStatus(task.status)) {
    return task.progress ?? task.error ?? task.result;
  }
  return task.error ?? task.result ?? task.progress;
}

function TaskRow({ task, ownerLabel }: { task: RuntimeBackgroundTask; ownerLabel?: string }) {
  const visuals = TASK_STATUS_VISUALS[task.status];
  const Icon = TASK_KIND_ICON[task.kind];
  const detail = taskDetailText(task);
  const live = isActiveBackgroundTaskStatus(task.status);
  // An idle task never settled, so it has no endedAt; freeze it at the last
  // word from the provider rather than at render time.
  const frozenAt = task.endedAt ?? task.updatedAt;
  const badges = [
    ownerLabel,
    TASK_KIND_LABEL[task.kind],
    // A monitor's identity is its MCP server and tool; without them every
    // watch loop in a thread reads as the same anonymous "Monitor" row.
    backgroundTaskSourceLabel(task),
    task.backgrounded ? "detached" : null,
    task.ambient ? "ambient" : null,
  ].filter((value): value is string => value !== undefined && value !== null);

  return (
    <div
      className={cn(
        // Three fixed lines — identity, detail, badges — mirroring the agent
        // roster so a row's height never changes as data arrives.
        "grid h-[3.5rem] w-full grid-cols-[0.375rem_auto_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left",
        task.ambient ? "opacity-70" : null,
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", visuals.dotClass)} />
      </span>
      <Icon aria-hidden className="col-start-2 row-start-1 size-3.5 text-muted-foreground/70" />
      <span className="col-start-3 row-start-1 min-w-0 truncate font-mono text-xs">
        {task.label}
      </span>
      <span className="col-start-4 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <TaskElapsed startedAt={task.startedAt} endedAt={frozenAt} live={live} />
      </span>
      <span
        className={cn(
          "col-start-2 col-end-5 row-start-2 block truncate text-[.7rem]",
          task.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {detail ?? visuals.label}
      </span>
      <span className="col-start-2 col-end-5 row-start-3 truncate font-mono text-[.6rem] uppercase tracking-wide text-muted-foreground/50">
        {badges.join(" · ")}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </div>
  );
}

/**
 * An owner sub-header only appears once a subagent owns tasks of its own —
 * a thread whose only background work is the main agent's reads as one flat
 * list, which is the common case.
 */
function TaskOwnerGroup({ group, showOwner }: { group: BackgroundTaskGroup; showOwner: boolean }) {
  return (
    <div className="flex flex-col">
      {showOwner ? (
        <div className="flex items-center gap-1.5 px-1.5 pt-1 text-[.6rem] font-medium uppercase tracking-wider text-muted-foreground/60">
          <span className="truncate">{group.ownerLabel}</span>
          <span className="font-mono font-normal">{group.tasks.length}</span>
        </div>
      ) : null}
      {group.tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
}

const WAIT_ICON = {
  approval: ShieldAlert,
  "user-input": MessageSquare,
  compacting: Layers,
  agents: Users,
  tasks: Terminal,
} as const;

/**
 * One line per blocked owner: `Main ← Command approval · 2m 14s`.
 *
 * The arrow is the point of the strip — it makes the dependency legible at a
 * glance, which is what "what are we waiting on" actually asks. Waits only
 * the user can clear are tinted; everything else is machine progress and
 * stays quiet.
 */
function WaitRow({ wait }: { wait: AgentWaitState }) {
  const Icon = WAIT_ICON[wait.kind];
  return (
    // The visible text already reads "Owner <- blocker"; an extra sr-only
    // sentence made screen readers announce the row twice. The arrow is
    // decorative, so it is the only thing hidden from the accessibility tree.
    <div className="flex h-6 items-center gap-1.5 px-1.5 text-xs">
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          wait.needsUser ? "text-warning-foreground" : "text-muted-foreground/70",
        )}
      />
      <span className="shrink-0 truncate font-medium">{wait.ownerLabel}</span>
      <span className="shrink-0 text-muted-foreground/50">
        <span aria-hidden>←</span>
        <span className="sr-only">is waiting on</span>
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          wait.needsUser ? "text-warning-foreground" : "text-muted-foreground",
        )}
      >
        {wait.label}
      </span>
      {wait.since ? (
        <span className="shrink-0 font-mono text-[.7rem] text-muted-foreground/70">
          <TaskElapsed startedAt={wait.since} endedAt={null} live />
        </span>
      ) : null}
    </div>
  );
}

export function WaitingOnStrip({ waits }: { waits: ReadonlyArray<AgentWaitState> }) {
  if (waits.length === 0) return null;
  const needsUser = waits.some((wait) => wait.needsUser);
  return (
    <section
      aria-label="Waiting on"
      className={cn(
        "rounded-lg border p-1.5",
        needsUser ? "border-warning/40 bg-warning/5" : "border-border/60 bg-card/20",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 px-1.5 py-1 text-[.65rem] font-medium uppercase tracking-wider",
          needsUser ? "text-warning-foreground" : "text-muted-foreground",
        )}
      >
        <span>Waiting on</span>
        <span className="font-mono font-normal text-muted-foreground/70">{waits.length}</span>
      </div>
      <div className="flex flex-col">
        {waits.map((wait) => (
          <WaitRow key={`${wait.ownerId ?? "main"}:${wait.kind}`} wait={wait} />
        ))}
      </div>
    </section>
  );
}

export function BackgroundTasksSection({ model }: { model: BackgroundTasksPanelModel }) {
  const [open, setOpen] = useState(true);
  // Derived, not initialized: useState would freeze this at whatever the
  // model looked like on first mount (usually empty), so the section would
  // keep the wrong default as work started and finished, and would carry the
  // previous thread's state across a thread switch. null means "follow the
  // model"; a click pins the user's choice.
  const [finishedOverride, setFinishedOverride] = useState<boolean | null>(null);
  const finishedOpen = finishedOverride ?? model.groups.length === 0;
  const setFinishedOpen = (value: boolean) => setFinishedOverride(value);
  if (!model.hasTasks) return null;

  // Attribution is needed whenever ANY row belongs to a subagent — including
  // one that only appears under Finished. Deriving this from the visible
  // groups alone dropped the owner from finished rows whenever main happened
  // to own all the live work.
  const showOwners =
    model.groups.length > 1 ||
    model.groups.some((group) => group.ownerId !== null) ||
    model.finished.some((entry) => entry.task.ownerAgentId !== null);
  const visibleCount = model.groups.reduce((total, group) => total + group.tasks.length, 0);

  return (
    <section
      className={cn(
        "rounded-lg border p-1.5",
        model.activeCount > 0 ? "border-info/30 bg-info/5" : "border-border/60 bg-card/20",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          model.activeCount > 0 ? "text-info-foreground" : "text-muted-foreground",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )}
        <span>Tasks</span>
        <span className="font-mono font-normal text-muted-foreground/70">{model.totalCount}</span>
        {model.failedCount > 0 ? (
          <span className="ml-auto font-mono font-normal text-destructive-foreground">
            {model.failedCount} failed
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5">
          {visibleCount === 0 ? (
            <p className="px-1.5 py-1 text-[.7rem] text-muted-foreground">
              Nothing running right now.
            </p>
          ) : (
            model.groups.map((group) => (
              <TaskOwnerGroup key={group.ownerId ?? "main"} group={group} showOwner={showOwners} />
            ))
          )}
          {model.finished.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setFinishedOpen(!finishedOpen)}
                aria-expanded={finishedOpen}
                className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[.6rem] font-medium uppercase tracking-wider text-muted-foreground/70 hover:bg-accent/40"
              >
                {finishedOpen ? (
                  <ChevronDown aria-hidden className="size-3 shrink-0" />
                ) : (
                  <ChevronRight aria-hidden className="size-3 shrink-0" />
                )}
                <span>Finished</span>
                <span className="font-mono font-normal">{model.finished.length}</span>
              </button>
              {finishedOpen
                ? model.finished.map((entry) => (
                    <TaskRow
                      key={entry.task.id}
                      task={entry.task}
                      {...(showOwners ? { ownerLabel: entry.ownerLabel } : {})}
                    />
                  ))
                : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
