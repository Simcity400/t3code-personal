import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { AgentCard } from "./AgentCard";

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));

describe("AgentCard", () => {
  it("renders three fixed dot slots and announces working state with elapsed time", () => {
    const startedAt = "2026-08-17T00:00:00.000Z";
    const agent = {
      id: "agent-1",
      title: "Review changes",
      role: "reviewer",
      status: "running",
      progress: "Reading files",
      firstSeenAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
    } as RuntimeSubagent;

    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(AgentCard, {
          agent,
          clock: {
            nowMs: Date.parse("2026-08-17T00:00:17.000Z"),
            tick: 2,
            reduceMotion: false,
          },
          onOpen: vi.fn(),
        }),
      );
    });

    const pressable = renderer!.root.findByProps({ accessibilityRole: "button" });
    expect(pressable.props.accessibilityLabel).toBe("Open Review changes transcript. Working, 17s");
    const dotSlots = renderer!.root.findAll(
      (node) =>
        node.children.length === 1 &&
        node.children[0] === "." &&
        typeof node.props.style?.opacity === "number",
    );
    expect(dotSlots).toHaveLength(3);
    expect(dotSlots.map((slot) => slot.props.style.opacity)).toEqual([1, 1, 0.18]);

    act(() => renderer!.unmount());
  });
});
