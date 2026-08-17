import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentStatusClock, useAgentStatusClock } from "./agentStatusClock";

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: vi.fn(() => Promise.resolve(false)),
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

describe("createAgentStatusClock", () => {
  it("shares one timer, follows reduced motion, and cleans up after the final subscriber", async () => {
    let nowMs = 1_000;
    let intervalCallback: () => void = () => undefined;
    let reducedMotionListener: (enabled: boolean) => void = () => undefined;
    const clearInterval = vi.fn();
    const removeReducedMotionListener = vi.fn();
    const setInterval = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return 9 as never;
    });
    const clock = createAgentStatusClock({
      now: () => nowMs,
      setInterval,
      clearInterval,
      readReducedMotion: () => Promise.resolve(false),
      subscribeReducedMotion: (listener) => {
        reducedMotionListener = listener;
        return removeReducedMotionListener;
      },
    });
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const unsubscribeA = clock.subscribe(listenerA);
    const unsubscribeB = clock.subscribe(listenerB);
    expect(setInterval).toHaveBeenCalledTimes(1);
    nowMs = 2_000;
    intervalCallback();
    expect(clock.getSnapshot()).toMatchObject({ nowMs: 2_000, tick: 1 });
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);

    reducedMotionListener(true);
    expect(clock.getSnapshot().reduceMotion).toBe(true);

    unsubscribeA();
    expect(clearInterval).not.toHaveBeenCalled();
    unsubscribeB();
    expect(clearInterval).toHaveBeenCalledWith(9);
    expect(removeReducedMotionListener).toHaveBeenCalledTimes(1);

    await Promise.resolve();
  });

  it("ignores a stale reduced-motion read after stop and restart", async () => {
    let resolveFirst: (value: boolean) => void = () => undefined;
    let resolveSecond: (value: boolean) => void = () => undefined;
    const reads = [
      new Promise<boolean>((resolve) => {
        resolveFirst = resolve;
      }),
      new Promise<boolean>((resolve) => {
        resolveSecond = resolve;
      }),
    ];
    const clock = createAgentStatusClock({
      now: () => 1_000,
      setInterval: () => 1 as never,
      clearInterval: vi.fn(),
      readReducedMotion: () => reads.shift() ?? Promise.resolve(false),
      subscribeReducedMotion: () => () => undefined,
    });

    clock.subscribe(() => undefined)();
    const unsubscribeSecond = clock.subscribe(() => undefined);
    resolveSecond(true);
    await Promise.resolve();
    expect(clock.getSnapshot().reduceMotion).toBe(true);

    resolveFirst(false);
    await Promise.resolve();
    expect(clock.getSnapshot().reduceMotion).toBe(true);
    unsubscribeSecond();
  });

  it("mounts one hook subscription and cleans it across enabled transitions", () => {
    let intervalCallback: () => void = () => undefined;
    let nowMs = 1_000;
    const setInterval = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return 11 as never;
    });
    const clearInterval = vi.fn();
    const clock = createAgentStatusClock({
      now: () => nowMs,
      setInterval,
      clearInterval,
      readReducedMotion: () => Promise.resolve(false),
      subscribeReducedMotion: () => () => undefined,
    });
    const Probe = ({ enabled }: { readonly enabled: boolean }) => {
      const snapshot = useAgentStatusClock(enabled, clock);
      return createElement("clock-probe", { tick: snapshot.tick });
    };

    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(Probe, { enabled: true }));
    });
    expect(setInterval).toHaveBeenCalledTimes(1);
    nowMs = 2_000;
    act(() => intervalCallback());
    expect(renderer!.root.findByProps({ tick: 1 }).props.tick).toBe(1);

    act(() => renderer!.update(createElement(Probe, { enabled: false })));
    expect(clearInterval).toHaveBeenCalledWith(11);
    act(() => renderer!.update(createElement(Probe, { enabled: true })));
    expect(setInterval).toHaveBeenCalledTimes(2);
    act(() => renderer!.unmount());
    expect(clearInterval).toHaveBeenCalledTimes(2);
  });
});
