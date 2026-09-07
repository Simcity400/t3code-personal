import { createElement } from "react";
import { Pressable } from "react-native";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { ApprovalRequestId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  View: "View",
  ScrollView: "ScrollView",
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "Symbol" }));
vi.mock("../../components/ControlPill", () => ({ ControlPill: "ControlPill" }));
vi.mock("react-native-reanimated", () => {
  const transition = {
    duration: (_duration: number) => transition,
    easing: (_easing: unknown) => transition,
  };
  return {
    default: { View: "AnimatedView" },
    Easing: { out: (value: unknown) => value, cubic: "cubic" },
    FadeInUp: transition,
    FadeOutDown: transition,
    LinearTransition: transition,
    useAnimatedStyle: (read: () => unknown) => read(),
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
  };
});

import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { buildThreadTurnInterruptInput } from "./threadTurnInterrupt";

const stoppedThread = {
  id: ThreadId.make("root-thread"),
  session: { status: "stopped", activeTurnId: null } as OrchestrationThreadShell["session"],
};
const requestId = ApprovalRequestId.make("child-request");

function isAccessible(node: ReactTestInstance): boolean {
  for (let current: ReactTestInstance | null = node; current; current = current.parent) {
    if (current.props.accessibilityElementsHidden || current.props.pointerEvents === "none")
      return false;
  }
  return true;
}

describe("Stop all while a child needs input after Main Stop", () => {
  it("remains usable on the approval card while an approval response is pending", async () => {
    const dispatch = vi.fn();
    const onRespond = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(PendingApprovalCard, {
          approval: { requestId, requestKind: "command", createdAt: "2026-09-05T00:00:00.000Z" },
          respondingApprovalId: requestId,
          onRespond,
          onStopAll: () => dispatch(buildThreadTurnInterruptInput(stoppedThread, "tree")),
        }),
      );
    });
    const stop = renderer!.root.find(
      (node) => node.type === Pressable && node.props.accessibilityLabel === "Stop all",
    );
    expect(isAccessible(stop)).toBe(true);
    expect(stop.props.disabled).not.toBe(true);
    await act(async () => stop.props.onPress());
    expect(dispatch).toHaveBeenCalledWith({ threadId: stoppedThread.id, scope: "tree" });
    expect(onRespond).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
  });

  it.each([false, true])(
    "keeps an accessible root Stop all with incomplete answers, collapsed=%s",
    async (collapsed) => {
      const dispatch = vi.fn();
      const onSubmit = vi.fn();
      let renderer: ReturnType<typeof create>;
      act(() => {
        renderer = create(
          createElement(PendingUserInputCard, {
            pendingUserInput: {
              requestId,
              questions: [],
              createdAt: "2026-09-05T00:00:00.000Z",
              dismissible: false,
            },
            maxHeight: 400,
            collapsed,
            onToggleCollapsed: vi.fn(),
            onDismiss: vi.fn(),
            drafts: {},
            answers: null,
            respondingUserInputId: requestId,
            onSelectOption: vi.fn(),
            onChangeCustomAnswer: vi.fn(),
            onSubmit,
            onStopAll: () => dispatch(buildThreadTurnInterruptInput(stoppedThread, "tree")),
          }),
        );
      });
      const stops = renderer!.root.findAll(
        (node) =>
          node.type === Pressable &&
          node.props.accessibilityLabel === "Stop all" &&
          isAccessible(node),
      );
      expect(stops).toHaveLength(1);
      expect(stops[0]!.props.disabled).not.toBe(true);
      await act(async () => stops[0]!.props.onPress());
      expect(dispatch).toHaveBeenCalledWith({ threadId: stoppedThread.id, scope: "tree" });
      expect(onSubmit).not.toHaveBeenCalled();
      act(() => renderer!.unmount());
    },
  );
});
