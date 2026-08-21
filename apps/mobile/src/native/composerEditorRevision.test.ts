import { describe, expect, it } from "@effect/vitest";

import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  beginComposerReset,
  COMPOSER_RESET_EVENT_COUNT,
  handOffComposerReset,
  IDLE_COMPOSER_RESET,
  isComposerNativeEcho,
  isComposerResetPending,
  isComposerResetWriteBack,
  observeComposerResetValue,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  retireComposerResetClear,
  type ComposerNativeEventKind,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";

describe("acknowledgeComposerNativeEvent", () => {
  it("advances to newer native text revisions", () => {
    expect(acknowledgeComposerNativeEvent(4, 5)).toBe(5);
  });

  it("accepts a duplicate event from the current native revision", () => {
    expect(acknowledgeComposerNativeEvent(5, 5)).toBe(5);
  });

  it("rejects events older than the latest native text revision", () => {
    expect(acknowledgeComposerNativeEvent(5, 4)).toBeNull();
  });

  it("rejects malformed revision counters", () => {
    expect(acknowledgeComposerNativeEvent(5, Number.NaN)).toBeNull();
    expect(acknowledgeComposerNativeEvent(5, 5.5)).toBeNull();
  });
});

describe("isComposerNativeEcho", () => {
  const snapshots = [{ eventCount: 3, value: "native", selection: { start: 6, end: 6 } }];

  it("matches the exact native text revision and selection", () => {
    expect(isComposerNativeEcho("native", { start: 6, end: 6 }, 3, snapshots)).toBe(true);
  });

  it("does not claim parent-driven selection or repeated-text updates", () => {
    expect(isComposerNativeEcho("native", { start: 2, end: 2 }, 3, snapshots)).toBe(false);
    expect(isComposerNativeEcho("native", { start: 6, end: 6 }, 4, snapshots)).toBe(false);
    expect(isComposerNativeEcho("parent edit", { start: 6, end: 6 }, 3, snapshots)).toBe(false);
  });

  it("matches value and revision when selection is uncontrolled", () => {
    expect(isComposerNativeEcho("native", null, 3, snapshots)).toBe(true);
  });

  it("does not claim a controlled selection against an assumed state without one", () => {
    // An echo payload serializes `selection: null`; classifying a controlled
    // selection as an echo of an assumed state would drop a parent caret move.
    const assumed = [{ eventCount: 3, value: "native", selection: null }];
    expect(isComposerNativeEcho("native", { start: 0, end: 0 }, 3, assumed)).toBe(false);
    expect(isComposerNativeEcho("other", { start: 0, end: 0 }, 3, assumed)).toBe(false);
  });

  it("matches an assumed state when selection is uncontrolled", () => {
    const assumed = [{ eventCount: 3, value: "native", selection: null }];
    expect(isComposerNativeEcho("native", null, 3, assumed)).toBe(true);
  });
});

describe("resolveComposerControlledEventCount", () => {
  const snapshots = [
    { eventCount: 0, value: "", selection: { start: 0, end: 0 } },
    { eventCount: 2, value: "a", selection: { start: 1, end: 1 } },
    { eventCount: 4, value: "ab", selection: { start: 2, end: 2 } },
  ];

  it("tags a delayed parent value with the native revision that produced it", () => {
    expect(resolveComposerControlledEventCount("a", { start: 1, end: 1 }, 4, snapshots)).toBe(2);
  });

  it("does not acknowledge the pre-edit parent value as the latest revision", () => {
    expect(resolveComposerControlledEventCount("", { start: 0, end: 0 }, 4, snapshots)).toBe(0);
  });

  it("acknowledges the latest native value at the latest revision", () => {
    expect(resolveComposerControlledEventCount("ab", { start: 2, end: 2 }, 4, snapshots)).toBe(4);
  });

  it("allows an unmatched parent-driven edit at the latest native revision", () => {
    expect(resolveComposerControlledEventCount("/plan ", { start: 6, end: 6 }, 4, snapshots)).toBe(
      4,
    );
  });

  it("uses the newest revision when selection events repeat the same value", () => {
    expect(
      resolveComposerControlledEventCount("ab", { start: 1, end: 1 }, 5, [
        ...snapshots,
        { eventCount: 5, value: "ab", selection: { start: 1, end: 1 } },
      ]),
    ).toBe(5);
  });

  it("keeps a stale selection paired with current text behind the native revision", () => {
    expect(resolveComposerControlledEventCount("ab", { start: 1, end: 1 }, 4, snapshots)).toBe(3);
  });

  it("does not control selection when no selection prop is provided", () => {
    expect(resolveComposerControlledEventCount("ab", null, 4, snapshots)).toBe(4);
  });
});

describe("pruneAcknowledgedComposerNativeEvents", () => {
  it("releases an arbitrarily long acknowledged backlog without a fixed-size cliff", () => {
    const snapshots = Array.from({ length: 1_000 }, (_, eventCount) => ({
      eventCount,
      value: `value-${eventCount}`,
      selection: { start: eventCount, end: eventCount },
    }));

    expect(pruneAcknowledgedComposerNativeEvents(snapshots, 999)).toEqual([snapshots[999]]);
  });

  it("retains native events that arrive after the acknowledged render", () => {
    const snapshots = [
      { eventCount: 40, value: "a", selection: { start: 1, end: 1 } },
      { eventCount: 41, value: "ab", selection: { start: 2, end: 2 } },
    ];

    expect(pruneAcknowledgedComposerNativeEvents(snapshots, 40)).toEqual(snapshots);
  });

  it("retains the newest acknowledged snapshot so settled re-renders stay echoes", () => {
    const snapshots = [
      { eventCount: 40, value: "a", selection: { start: 1, end: 1 } },
      { eventCount: 41, value: "ab", selection: { start: 2, end: 2 } },
      { eventCount: 42, value: "abc", selection: { start: 3, end: 3 } },
    ];

    const pruned = pruneAcknowledgedComposerNativeEvents(snapshots, 42);
    expect(pruned).toEqual([snapshots[2]]);
    expect(isComposerNativeEcho("abc", { start: 3, end: 3 }, 42, pruned)).toBe(true);
  });

  it("keeps the newest of several snapshots sharing the acknowledged revision", () => {
    const snapshots = [
      { eventCount: 41, value: "ab", selection: { start: 2, end: 2 } },
      { eventCount: 41, value: "ab", selection: { start: 1, end: 1 } },
    ];

    expect(pruneAcknowledgedComposerNativeEvents(snapshots, 41)).toEqual([snapshots[1]]);
  });
});

describe("assumeComposerControlledState", () => {
  it("replaces the acknowledged history with the applied controlled state", () => {
    const snapshots = [{ eventCount: 3, value: "typed", selection: { start: 5, end: 5 } }];

    expect(assumeComposerControlledState(snapshots, 3, "")).toEqual([
      { eventCount: 3, value: "", selection: null },
    ]);
  });

  it("keeps native events that raced past the controlled revision", () => {
    const snapshots = [
      { eventCount: 3, value: "typed", selection: { start: 5, end: 5 } },
      { eventCount: 4, value: "typed!", selection: { start: 6, end: 6 } },
    ];

    expect(assumeComposerControlledState(snapshots, 3, "")).toEqual([
      { eventCount: 3, value: "", selection: null },
      snapshots[1],
    ]);
  });

  it("applies a parent caret move on the assumed value at the assumed revision", () => {
    // Same value, new caret: not an echo (so the selection is serialized) but
    // still stamped at the assumed revision so the editor accepts it.
    const snapshots = assumeComposerControlledState([], 3, "typed");

    expect(isComposerNativeEcho("typed", { start: 2, end: 2 }, 3, snapshots)).toBe(false);
    expect(resolveComposerControlledEventCount("typed", { start: 2, end: 2 }, 3, snapshots)).toBe(
      3,
    );
  });

  it("re-applies a parent value that round-trips back to an acknowledged state", () => {
    // Native acknowledged "typed", the parent then controlled the editor to ""
    // (a send clearing the draft) and back to "typed" (the send failed and the
    // draft was restored). The restore must be a fresh non-echo edit stamped at
    // the current revision, not an echo the editor would drop.
    const snapshots = assumeComposerControlledState(
      [{ eventCount: 3, value: "typed", selection: { start: 5, end: 5 } }],
      3,
      "",
    );

    expect(isComposerNativeEcho("typed", { start: 5, end: 5 }, 3, snapshots)).toBe(false);
    expect(resolveComposerControlledEventCount("typed", { start: 5, end: 5 }, 3, snapshots)).toBe(
      3,
    );
  });
});

/**
 * Replays the revision handshake the composer runs across the JS/native
 * boundary: JS stamps a controlled document, and the native editors apply it
 * only when the stamp is not behind their own event counter
 * (`document.mostRecentEventCount >= nativeEventCount` in
 * T3ComposerEditorView.swift and T3ComposerEditorView.kt). Native bumps that
 * counter on every text change and caret move it did not make itself, so a
 * submit provokes revisions the JS side has not seen yet.
 *
 * The simulator models the revision bookkeeping and the focus/blur state the
 * classifier reads; frames and event delivery latency are driven explicitly by
 * the tests, since those are exactly what the design must not depend on.
 */
function createComposerHandshake(initialValue: string) {
  let parentValue = initialValue;
  let resetState = IDLE_COMPOSER_RESET;
  let snapshots: ComposerNativeEventSnapshot[] = [];
  let acknowledgedEventCount = 0;
  let nativeEventCount = 0;
  let nativeText = initialValue;
  let latestValue = initialValue;
  let focused = true;
  let blurPending = false;
  const inFlight: Array<{
    eventCount: number;
    value: string;
    kind: ComposerNativeEventKind;
  }> = [];

  const editorAcceptsInput = () => focused && !blurPending;

  return {
    get parentValue() {
      return parentValue;
    },
    get nativeText() {
      return nativeText;
    },
    /** One committed render of the editor, plus the native side's decision. */
    render() {
      const resetStamp = isComposerResetPending(resetState, parentValue)
        ? COMPOSER_RESET_EVENT_COUNT
        : null;
      const mostRecentEventCount =
        resetStamp ??
        resolveComposerControlledEventCount(parentValue, null, acknowledgedEventCount, snapshots);
      const applied = mostRecentEventCount >= nativeEventCount;
      // The native views suppress their own callbacks while applying a
      // controlled document, so an applied clear is never echoed back.
      if (applied) nativeText = parentValue;
      // Layout effects: synchronous with the commit, in declaration order.
      latestValue = parentValue;
      resetState = observeComposerResetValue(resetState, parentValue);
      if (resetStamp !== null) {
        snapshots = [];
        resetState = handOffComposerReset(resetState);
      } else if (mostRecentEventCount === acknowledgedEventCount) {
        snapshots = assumeComposerControlledState(snapshots, mostRecentEventCount, parentValue);
      }
      return { mostRecentEventCount, applied };
    },
    /**
     * The send handler marking the submit before the draft store clears.
     * Returns the callback it invokes once the send settles.
     */
    submit(clearsDraft = true) {
      resetState = beginComposerReset(latestValue);
      if (clearsDraft) parentValue = "";
      // The disposer starts the settle countdown; `elapseSettleFrames` models
      // the frames running out.
      return () => {};
    },
    /** The settle countdown elapsed. */
    elapseSettleFrames() {
      resetState = editorAcceptsInput()
        ? IDLE_COMPOSER_RESET
        : retireComposerResetClear(resetState);
    },
    /** The send handoff calling `blur()` on the imperative handle. */
    requestBlur() {
      if (focused) blurPending = true;
    },
    /** The native `onComposerBlur` callback arriving. */
    deliverNativeBlur() {
      focused = false;
      blurPending = false;
    },
    /** The native `onComposerFocus` callback arriving. */
    deliverNativeFocus() {
      focused = true;
      blurPending = false;
      resetState = IDLE_COMPOSER_RESET;
    },
    /** The parent writes the draft (a rolled-back send, a command insertion). */
    setParentValue(value: string) {
      parentValue = value;
    },
    /**
     * The composer is pointed at another thread's draft. The editor keys the
     * window on that identity, so a reset armed for the previous draft ends
     * even when the two drafts happen to hold the same text.
     */
    pointAtAnotherDraft(value: string) {
      resetState = IDLE_COMPOSER_RESET;
      parentValue = value;
    },
    /**
     * The native editor produces an event. Its counter moves immediately; the
     * JS callback runs later, which is the window the clear has to survive.
     */
    emitNativeEvent(value: string, kind: ComposerNativeEventKind = "change") {
      nativeEventCount += 1;
      nativeText = value;
      inFlight.push({ eventCount: nativeEventCount, value, kind });
    },
    /** Drains the queued native events into the editor's handler. */
    deliverNativeEvents() {
      const outcomes: string[] = [];
      for (const event of inFlight.splice(0, inFlight.length)) {
        const acknowledged = acknowledgeComposerNativeEvent(
          acknowledgedEventCount,
          event.eventCount,
        );
        if (acknowledged === null) {
          outcomes.push("rejected");
          continue;
        }
        acknowledgedEventCount = acknowledged;
        const writeBack = isComposerResetWriteBack(resetState, {
          value: event.value,
          eventKind: event.kind,
          parentValue: latestValue,
          editorAcceptsInput: editorAcceptsInput(),
        });
        snapshots.push({ eventCount: acknowledged, value: event.value, selection: null });
        if (!writeBack) parentValue = event.value;
        outcomes.push(writeBack ? "write-back" : "accepted");
      }
      return outcomes;
    },
  };
}

describe("composer post-submit reset", () => {
  it("stays inside the 32-bit range the Android bridge can read", () => {
    // org.json optInt truncates a parsed Long to its low 32 bits, so
    // Number.MAX_SAFE_INTEGER would arrive as -1 and the clear would be dropped.
    expect(COMPOSER_RESET_EVENT_COUNT).toBe(2 ** 31 - 1);
    expect(COMPOSER_RESET_EVENT_COUNT | 0).toBe(COMPOSER_RESET_EVENT_COUNT);
  });

  it("stamps only the cleared draft", () => {
    const submitted = beginComposerReset("hello");
    expect(submitted).toEqual({
      clearPending: true,
      suppressing: true,
      submittedText: "hello",
    });
    // A send still in flight has not cleared the draft yet; the reset must not
    // clear it on its behalf.
    expect(isComposerResetPending(submitted, "hello")).toBe(false);
    expect(isComposerResetPending(submitted, "")).toBe(true);
    expect(isComposerResetPending(handOffComposerReset(submitted), "")).toBe(false);
    expect(isComposerResetPending(IDLE_COMPOSER_RESET, "")).toBe(false);
  });

  it("keeps suppressing after the clear was handed to native", () => {
    const handedOff = handOffComposerReset(beginComposerReset("hello"));
    expect(handedOff).toEqual({
      clearPending: false,
      suppressing: true,
      submittedText: "hello",
    });
    expect(handOffComposerReset(handedOff)).toBe(handedOff);
  });

  it("retires only the pending clear when the settle frames run out", () => {
    const submitted = beginComposerReset("hello");
    expect(retireComposerResetClear(submitted)).toEqual({
      clearPending: false,
      suppressing: true,
      submittedText: "hello",
    });
    expect(retireComposerResetClear(IDLE_COMPOSER_RESET)).toBe(IDLE_COMPOSER_RESET);
  });

  const classify = (
    state: typeof IDLE_COMPOSER_RESET,
    event: {
      value: string;
      eventKind: ComposerNativeEventKind;
      parentValue: string;
      editorAcceptsInput: boolean;
    },
  ) => isComposerResetWriteBack(state, event);

  it("drops a caret move that disagrees with an already cleared draft", () => {
    const handedOff = handOffComposerReset(beginComposerReset("hello"));
    // A caret move cannot change text, so one reporting text the parent no
    // longer owns describes the document the clear superseded — focused or not.
    const cleared = { parentValue: "", eventKind: "selection" as const };
    expect(classify(handedOff, { ...cleared, value: "hello", editorAcceptsInput: true })).toBe(
      true,
    );
    expect(classify(handedOff, { ...cleared, value: "hello", editorAcceptsInput: false })).toBe(
      true,
    );
    expect(classify(handedOff, { ...cleared, value: "", editorAcceptsInput: false })).toBe(false);
    expect(
      classify(IDLE_COMPOSER_RESET, { ...cleared, value: "hello", editorAcceptsInput: false }),
    ).toBe(false);
  });

  it("keeps caret moves while the parent still owns the draft", () => {
    // An asynchronous send has not cleared yet, or a send bailed out: the
    // document is still live, and the trigger popover works off this range.
    const pending = beginComposerReset("/side /mo");
    expect(
      classify(pending, {
        value: "/side /mo",
        eventKind: "selection",
        parentValue: "/side /mo",
        editorAcceptsInput: true,
      }),
    ).toBe(false);
  });

  it("drops a text mutation only once the editor is on its way out", () => {
    const handedOff = handOffComposerReset(beginComposerReset("teh"));
    // The keyboard commits a pending autocorrection as the text view resigns
    // first responder: a different string for the same pre-submit state, which
    // is why matching the submitted text exactly would not do.
    expect(
      classify(handedOff, {
        value: "the",
        eventKind: "change",
        parentValue: "",
        editorAcceptsInput: false,
      }),
    ).toBe(true);
    // Typing into a live editor is real input and must reach the draft.
    expect(
      classify(handedOff, {
        value: "n",
        eventKind: "change",
        parentValue: "",
        editorAcceptsInput: true,
      }),
    ).toBe(false);
    expect(
      classify(handedOff, {
        value: "",
        eventKind: "change",
        parentValue: "",
        editorAcceptsInput: false,
      }),
    ).toBe(false);
  });

  it("suppresses from the submit, before the clear is stamped", () => {
    // The window opens with the submit itself: an event delivered before the
    // cleared document renders would otherwise put the text back and leave
    // nothing for the reset stamp to clear.
    expect(
      classify(beginComposerReset("hello"), {
        value: "hello",
        eventKind: "selection",
        parentValue: "",
        editorAcceptsInput: true,
      }),
    ).toBe(true);
  });

  it("ends the whole window when the parent owns a draft again", () => {
    const submitted = beginComposerReset("hello");
    // The user typed during a send that never cleared: the submit is over.
    expect(observeComposerResetValue(submitted, "hello!")).toBe(IDLE_COMPOSER_RESET);
    // The submitted text arriving unchanged while the clear is still pending is
    // a send that has not cleared yet, and must not disarm the reset.
    expect(observeComposerResetValue(submitted, "hello")).toBe(submitted);
    expect(observeComposerResetValue(submitted, "")).toBe(submitted);
    expect(observeComposerResetValue(IDLE_COMPOSER_RESET, "anything")).toBe(IDLE_COMPOSER_RESET);
  });

  it("ends the window when a rolled-back send restores the submitted text", () => {
    // Once the clear reached native the exception lapses: the enqueue failed
    // and merged the message back into the draft, so the parent owns it again
    // and the native events that follow are live editing, not a write-back.
    const handedOff = handOffComposerReset(beginComposerReset("hello"));
    expect(observeComposerResetValue(handedOff, "hello")).toBe(IDLE_COMPOSER_RESET);
    expect(observeComposerResetValue(handedOff, "")).toBe(handedOff);
  });

  it("parent clears while a native event raced the send", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("hello");
    editor.deliverNativeEvents();
    expect(editor.render()).toEqual({ mostRecentEventCount: 1, applied: true });

    // A caret move emitted around the submit puts native at revision 2 before
    // the cleared document is stamped, and JS has not seen that revision yet.
    editor.emitNativeEvent("hello", "selection");
    const finishSubmit = editor.submit();

    // Without the reset stamp the clear is stamped at revision 1, which the
    // native side rejects as stale. That is the bug.
    expect(resolveComposerControlledEventCount("", null, 1, [])).toBe(1);

    expect(editor.render()).toEqual({
      mostRecentEventCount: COMPOSER_RESET_EVENT_COUNT,
      applied: true,
    });
    expect(editor.nativeText).toBe("");

    // The raced event reaches JS while the editor is still focused — the send
    // handoff blurs a frame later — still carrying the submitted text. Writing
    // it back is what left the sent message sitting in the input box.
    expect(editor.deliverNativeEvents()).toEqual(["write-back"]);
    expect(editor.parentValue).toBe("");
    finishSubmit();
    editor.render();
    expect(editor.nativeText).toBe("");
  });

  it("does not restore an autocorrect the keyboard commits on the way out", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("teh");
    editor.deliverNativeEvents();
    editor.render();

    editor.submit();
    editor.render();
    // The send handoff asks for the blur; resigning first responder makes the
    // keyboard commit "teh" -> "the", so the payload differs from the text JS
    // submitted and arrives while the editor is on its way out.
    editor.requestBlur();
    editor.emitNativeEvent("the");
    expect(editor.deliverNativeEvents()).toEqual(["write-back"]);
    expect(editor.parentValue).toBe("");
    editor.deliverNativeBlur();
    editor.elapseSettleFrames();
    editor.render();
    expect(editor.nativeText).toBe("");
  });

  it("keeps a character typed before the send handoff blurs the editor", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("k");
    editor.deliverNativeEvents();
    editor.render();

    // Hardware Command-Return submits without blurring, so the next character
    // can land before the handoff's blur. It is real input.
    editor.emitNativeEvent("k", "selection");
    editor.submit();
    editor.render();
    expect(editor.deliverNativeEvents()).toEqual(["write-back"]);

    editor.emitNativeEvent("n");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
    expect(editor.parentValue).toBe("n");
    expect(editor.render().applied).toBe(true);
    expect(editor.nativeText).toBe("n");
  });

  it("ignores rather than overwrites a payload suppressed without a clear", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("hello");
    editor.deliverNativeEvents();
    editor.render();

    // A send that bailed out, and the user dismissed the keyboard while it was
    // still in flight: the trailing mutation is suppressed, so it does not
    // reach the draft, but the parent's own value is stamped behind the native
    // revision, so the text view keeps what it has instead of being overwritten
    // from a superseded draft. Nothing was cleared, so nothing is erased.
    const finishSubmit = editor.submit(false);
    editor.requestBlur();
    editor.emitNativeEvent("hellox");
    expect(editor.deliverNativeEvents()).toEqual(["write-back"]);
    expect(editor.parentValue).toBe("hello");
    expect(editor.render().applied).toBe(false);
    expect(editor.nativeText).toBe("hellox");

    // The next accepted event resynchronises the draft.
    finishSubmit();
    editor.deliverNativeBlur();
    editor.deliverNativeFocus();
    editor.emitNativeEvent("hellox!");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
    expect(editor.parentValue).toBe("hellox!");
    expect(editor.render().applied).toBe(true);
  });

  it("keeps text typed while an asynchronous send is still in flight", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("/side prompt");
    editor.deliverNativeEvents();
    editor.render();

    // `/side` awaits the server before clearing, so the window spans seconds.
    const finishSubmit = editor.submit(false);
    editor.emitNativeEvent("/side prompt", "selection");
    editor.emitNativeEvent("/side prompt!");
    expect(editor.deliverNativeEvents()).toEqual(["accepted", "accepted"]);
    expect(editor.parentValue).toBe("/side prompt!");
    expect(editor.render().applied).toBe(true);
    expect(editor.nativeText).toBe("/side prompt!");
    finishSubmit();
  });

  it("stamps an asynchronous send's late clear", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("/side prompt");
    editor.deliverNativeEvents();
    editor.render();

    // The window stays open for the whole in-flight send, which is what keeps
    // the late clear eligible for the reset stamp.
    const finishSubmit = editor.submit(false);
    editor.render();
    editor.requestBlur();
    editor.emitNativeEvent("/side prompt", "selection");
    editor.setParentValue("");
    expect(editor.render()).toEqual({
      mostRecentEventCount: COMPOSER_RESET_EVENT_COUNT,
      applied: true,
    });
    expect(editor.nativeText).toBe("");
    finishSubmit();
    expect(editor.deliverNativeEvents()).toEqual(["write-back"]);
    expect(editor.parentValue).toBe("");
  });

  it("keeps text typed after the editor regains focus, even the text just sent", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("k");
    editor.deliverNativeEvents();
    editor.render();

    editor.submit();
    editor.render();
    editor.requestBlur();
    editor.emitNativeEvent("k", "selection");
    editor.deliverNativeEvents();
    editor.deliverNativeBlur();
    editor.elapseSettleFrames();

    // Tapping back into the composer closes the window before any keystroke,
    // so re-sending the same one-character message is never mistaken for a
    // stale write-back.
    editor.deliverNativeFocus();
    editor.emitNativeEvent("k");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
    expect(editor.parentValue).toBe("k");
    editor.render();
    expect(editor.nativeText).toBe("k");
  });

  it("releases the window when the composer is pointed at another draft", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("/side prompt");
    editor.deliverNativeEvents();
    editor.render();

    // A slow `/side` on one thread, then the split layout points the same
    // composer at another thread. That thread's editing must not be suppressed
    // for the rest of the first thread's request.
    editor.submit(false);
    editor.pointAtAnotherDraft("another thread draft");
    editor.render();
    editor.emitNativeEvent("another thread draft", "selection");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
  });

  it("releases the window even when the other thread holds the same draft", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("/side prompt");
    editor.deliverNativeEvents();
    editor.render();

    // Two threads can hold byte-identical drafts, so the text alone cannot say
    // which one a reset belongs to; the editor keys the window on the draft's
    // identity instead.
    editor.submit(false);
    editor.pointAtAnotherDraft("/side prompt");
    editor.render();
    editor.requestBlur();
    editor.emitNativeEvent("/side prompt.");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
    expect(editor.parentValue).toBe("/side prompt.");
  });

  it("retires a reset whose send never cleared the draft", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("/side");
    editor.deliverNativeEvents();
    editor.render();

    // The send bailed out (`/side` with attachments), so the reset must not
    // survive to clear an unrelated draft later.
    editor.submit(false)();
    editor.elapseSettleFrames();

    editor.setParentValue("");
    expect(editor.render().mostRecentEventCount).not.toBe(COMPOSER_RESET_EVENT_COUNT);
    editor.setParentValue("a new thread draft");
    editor.render();
    editor.emitNativeEvent("a new thread draft!");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
    expect(editor.parentValue).toBe("a new thread draft!");
  });

  it("restores the draft when a send is rolled back after the clear", () => {
    const editor = createComposerHandshake("");
    editor.emitNativeEvent("hello");
    editor.deliverNativeEvents();
    editor.render();

    editor.emitNativeEvent("hello", "selection");
    editor.submit()();
    editor.render();
    expect(editor.nativeText).toBe("");
    // The suppressed write-back still acknowledges the raced revision, so the
    // restore below is not stamped behind the native counter.
    expect(editor.deliverNativeEvents()).toEqual(["write-back"]);
    editor.render();

    // The outbox write failed and merged the message back into the draft, while
    // the editor is still blurring and the window would otherwise still be open.
    editor.requestBlur();
    editor.setParentValue("hello");
    expect(editor.render().applied).toBe(true);
    expect(editor.nativeText).toBe("hello");

    // The restore ended the window, so the autocorrect the keyboard commits on
    // the way out reaches the draft like any other live edit.
    editor.emitNativeEvent("hello!");
    expect(editor.deliverNativeEvents()).toEqual(["accepted"]);
    expect(editor.parentValue).toBe("hello!");
  });
});
