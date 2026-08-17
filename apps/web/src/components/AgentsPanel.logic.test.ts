import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AgentRowActivity } from "./AgentWorkingStatus";
import {
  type ReducedMotionPreference,
  startWorkingDotsAnimation,
  workingDotsFrame,
} from "./AgentsPanel.logic";

describe("startWorkingDotsAnimation", () => {
  it("uses fixed-width frames and follows reduced-motion changes at runtime", () => {
    let changeListener: () => void = () => undefined;
    const motionPreference: ReducedMotionPreference = {
      matches: false,
      addEventListener: (_type, listener) => {
        changeListener = listener;
      },
      removeEventListener: vi.fn(),
    };
    let intervalCallback: () => void = () => undefined;
    const clearInterval = vi.fn();
    const writes: string[] = [];

    const cleanup = startWorkingDotsAnimation({
      motionPreference,
      writeDots: (value) => writes.push(value),
      setInterval: (callback) => {
        intervalCallback = callback;
        return 7 as never;
      },
      clearInterval,
    });

    expect(writes.at(-1)).toBe(workingDotsFrame(1));
    intervalCallback();
    expect(writes.at(-1)).toBe(workingDotsFrame(2));
    expect(writes.every((frame) => frame.length === 3)).toBe(true);

    Object.defineProperty(motionPreference, "matches", { value: true, configurable: true });
    changeListener();
    expect(writes.at(-1)).toBe("...");
    expect(clearInterval).toHaveBeenCalledTimes(1);

    Object.defineProperty(motionPreference, "matches", { value: false, configurable: true });
    changeListener();
    expect(writes.at(-1)).toBe(workingDotsFrame(1));

    cleanup();
    expect(clearInterval).toHaveBeenCalledTimes(2);
    expect(motionPreference.removeEventListener).toHaveBeenCalledWith("change", changeListener);
  });
});

describe("AgentRowActivity", () => {
  it("keeps animated Working visible beside ordinary progress", () => {
    const html = renderToStaticMarkup(
      createElement(AgentRowActivity, {
        status: "running",
        activity: "Reading files",
        settledLabel: "Working",
      }),
    );

    expect(html).toContain("Working");
    expect(html).toContain("Reading files");
    expect(html).toContain('aria-label="Working"');
  });
});
