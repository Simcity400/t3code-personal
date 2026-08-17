import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

export interface AgentStatusClockSnapshot {
  readonly nowMs: number;
  readonly tick: number;
  readonly reduceMotion: boolean;
}

interface AgentStatusClockDependencies {
  readonly now: () => number;
  readonly setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  readonly clearInterval: (intervalId: ReturnType<typeof setInterval>) => void;
  readonly readReducedMotion: () => Promise<boolean>;
  readonly subscribeReducedMotion: (listener: (enabled: boolean) => void) => () => void;
}

export interface AgentStatusClock {
  readonly getSnapshot: () => AgentStatusClockSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createAgentStatusClock(
  dependencies: AgentStatusClockDependencies,
): AgentStatusClock {
  const listeners = new Set<() => void>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let removeReducedMotionListener: (() => void) | null = null;
  let running = false;
  let runGeneration = 0;
  let snapshot: AgentStatusClockSnapshot = {
    nowMs: dependencies.now(),
    tick: 0,
    reduceMotion: false,
  };

  const publish = (next: AgentStatusClockSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const setReducedMotion = (reduceMotion: boolean) => {
    if (!running || snapshot.reduceMotion === reduceMotion) return;
    publish({ ...snapshot, reduceMotion });
  };
  const start = () => {
    if (running) return;
    running = true;
    const generation = ++runGeneration;
    snapshot = { ...snapshot, nowMs: dependencies.now() };
    intervalId = dependencies.setInterval(() => {
      publish({ ...snapshot, nowMs: dependencies.now(), tick: snapshot.tick + 1 });
    }, 1_000);
    removeReducedMotionListener = dependencies.subscribeReducedMotion(setReducedMotion);
    void dependencies
      .readReducedMotion()
      .then((reduceMotion) => {
        if (generation === runGeneration) setReducedMotion(reduceMotion);
      })
      .catch(() => undefined);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    runGeneration++;
    if (intervalId !== null) dependencies.clearInterval(intervalId);
    intervalId = null;
    removeReducedMotionListener?.();
    removeReducedMotionListener = null;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}

const clock = createAgentStatusClock({
  now: Date.now,
  setInterval,
  clearInterval,
  readReducedMotion: () => AccessibilityInfo.isReduceMotionEnabled(),
  subscribeReducedMotion: (listener) => {
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", listener);
    return () => subscription.remove();
  },
});

const NOOP_SUBSCRIBE = () => () => undefined;

export function useAgentStatusClock(
  enabled: boolean,
  source: AgentStatusClock = clock,
): AgentStatusClockSnapshot {
  return useSyncExternalStore(
    enabled ? source.subscribe : NOOP_SUBSCRIBE,
    source.getSnapshot,
    source.getSnapshot,
  );
}
