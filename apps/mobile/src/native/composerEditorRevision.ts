export interface ComposerNativeEventSnapshot {
  readonly eventCount: number;
  readonly value: string;
  readonly selection: ComposerEditorSelection | null;
}

interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

export function acknowledgeComposerNativeEvent(
  mostRecentEventCount: number,
  incomingEventCount: number,
): number | null {
  if (!Number.isSafeInteger(incomingEventCount) || incomingEventCount < mostRecentEventCount) {
    return null;
  }
  return incomingEventCount;
}

export function resolveComposerControlledEventCount(
  value: string,
  selection: ComposerEditorSelection | null,
  mostRecentEventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): number {
  let newestValueEventCount: number | null = null;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot?.value !== value) continue;

    newestValueEventCount ??= snapshot.eventCount;
    if (selection === null || snapshotSelectionMatches(snapshot, selection)) {
      return snapshot.eventCount;
    }
  }

  // A value emitted by native paired with a different selection is an
  // intermediate React render. Keep it behind the native revision so it
  // cannot move the caret while newer keystrokes are being processed.
  if (newestValueEventCount !== null && mostRecentEventCount > 0) {
    return Math.min(newestValueEventCount, mostRecentEventCount - 1);
  }

  return mostRecentEventCount;
}

// A snapshot without a selection describes a state the editor applied itself
// (an assumed controlled document, where the native side may have bounded the
// caret). Revision stamping treats it as matching any controlled selection so
// a parent caret move on the assumed value stays at the assumed revision and
// passes the editor's staleness guard. Echo detection must not reuse this
// wildcard: an echo payload serializes `selection: null`, which would drop
// that caret move instead of applying it.
function snapshotSelectionMatches(
  snapshot: ComposerNativeEventSnapshot,
  selection: ComposerEditorSelection,
): boolean {
  if (snapshot.selection === null) return true;
  return snapshot.selection.start === selection.start && snapshot.selection.end === selection.end;
}

export function isComposerNativeEcho(
  value: string,
  selection: ComposerEditorSelection | null,
  eventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): boolean {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (
      snapshot !== undefined &&
      snapshot.eventCount === eventCount &&
      snapshot.value === value &&
      (selection === null ||
        (snapshot.selection !== null &&
          snapshot.selection.start === selection.start &&
          snapshot.selection.end === selection.end))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Records that a parent-driven controlled document was handed to the native
 * editor. From that point the acknowledged snapshot history describes a
 * superseded native state, so it is replaced with the assumed applied state;
 * a later parent update back to a previously acknowledged value must classify
 * as a fresh edit, not as a native echo the editor would drop. Native events
 * that raced past the controlled revision stay authoritative and are kept.
 */
export function assumeComposerControlledState(
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
  eventCount: number,
  value: string,
): ComposerNativeEventSnapshot[] {
  return [
    { eventCount, value, selection: null },
    ...snapshots.filter((snapshot) => snapshot.eventCount > eventCount),
  ];
}

export function pruneAcknowledgedComposerNativeEvents(
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
  acknowledgedEventCount: number,
): ComposerNativeEventSnapshot[] {
  // The newest acknowledged snapshot must survive pruning: it is what lets a
  // later, unrelated re-render classify the settled composer state as a native
  // echo instead of a parent-driven edit that would re-control the caret (and
  // reset the keyboard's autocorrect context on iOS).
  let latestAcknowledgedIndex = -1;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot !== undefined && snapshot.eventCount <= acknowledgedEventCount) {
      latestAcknowledgedIndex = index;
      break;
    }
  }
  return snapshots.filter(
    (snapshot, index) =>
      index === latestAcknowledgedIndex || snapshot.eventCount > acknowledgedEventCount,
  );
}

/**
 * Revision stamped on the controlled document that clears the composer after a
 * submit. It has to outrank every revision the native editor can reach on its
 * own: submitting provokes native events — the caret move iOS emits when the
 * text view resigns first responder for the post-send blur handoff, a trailing
 * autocorrect commit, Android's mid-mutation selection callback — and each one
 * bumps the native revision counter. A clear stamped with the last revision JS
 * knew about is then behind that counter, the native side silently drops it,
 * and the submitted text stays in the input box.
 *
 * Int32 max rather than `Number.MAX_SAFE_INTEGER`: Android reads this field
 * with org.json's `optInt`, which truncates the parsed `Long` to its low 32
 * bits, so 2^53-1 would arrive as -1 and the clear would always be rejected.
 * The native counters only ever advance one event at a time, so Int32 max is
 * unreachable by real input.
 */
export const COMPOSER_RESET_EVENT_COUNT = 2147483647;

/**
 * Frames after a send settles before its pending clear is given up.
 *
 * This bounds only {@link ComposerResetState.clearPending} — a send that never
 * cleared the draft must not leave a reset armed to fire on some unrelated
 * empty draft later. It deliberately does NOT bound
 * {@link ComposerResetState.suppressing}: suppression is gated on the editor
 * not accepting input, which no deadline can express, and it is released by the
 * focus that precedes the user's next keystroke.
 *
 * The countdown starts when the send settles rather than at the submit, so it
 * spans the whole in-flight send — `/side` awaits the server before it clears,
 * and that late clear still has to be eligible for the reset stamp.
 */
export const COMPOSER_RESET_SETTLE_FRAMES = 3;

export interface ComposerResetState {
  /** A submit happened and the cleared document has not been stamped yet. */
  readonly clearPending: boolean;
  /** True while native events can still describe pre-submit editor state. */
  readonly suppressing: boolean;
  /** Draft text at submit time; used only to notice the user has edited since. */
  readonly submittedText: string;
}

export const IDLE_COMPOSER_RESET: ComposerResetState = {
  clearPending: false,
  suppressing: false,
  submittedText: "",
};

/**
 * A submit handed the draft off. Called synchronously from the send handler,
 * before the draft store clears, so the window is already open when the native
 * events the submit provoked are delivered.
 */
export function beginComposerReset(submittedText: string): ComposerResetState {
  return { clearPending: true, suppressing: true, submittedText };
}

/** The cleared document was stamped at the reset revision and handed to native. */
export function handOffComposerReset(state: ComposerResetState): ComposerResetState {
  if (!state.clearPending) return state;
  return { clearPending: false, suppressing: true, submittedText: state.submittedText };
}

/**
 * The settle countdown elapsed without the send ever clearing the draft, so no
 * clear is coming. Suppression is untouched: it ends when the editor is ready
 * to accept input again, not on a deadline — the caller drops the whole window
 * instead when the editor is already live at that point.
 */
export function retireComposerResetClear(state: ComposerResetState): ComposerResetState {
  if (!state.clearPending) return state;
  return {
    clearPending: false,
    suppressing: state.suppressing,
    submittedText: state.submittedText,
  };
}

/**
 * True while the cleared draft still has to be stamped. A submit whose send
 * failed leaves the draft in place, so the reset stays pending but never
 * stamps: only an empty draft is cleared through this path, and the settle
 * window retires the pending state either way.
 */
export function isComposerResetPending(state: ComposerResetState, value: string): boolean {
  return state.clearPending && value.length === 0;
}

/** Which native callback delivered a payload. */
export type ComposerNativeEventKind = "change" | "selection";

export interface ComposerNativeEventClassification {
  /** Text the payload reports the native editor holds. */
  readonly value: string;
  readonly eventKind: ComposerNativeEventKind;
  /** Draft the parent owns as of the last committed render. */
  readonly parentValue: string;
  /** False from the moment a blur is requested until the editor is focused again. */
  readonly editorAcceptsInput: boolean;
}

/**
 * A native payload that must not reach the parent, because it describes editor
 * state the post-submit clear already superseded: the caret move the text view
 * emits as it resigns first responder, the autocorrect the keyboard commits on
 * the way out, a trailing IME mutation. Forwarding one writes the sent message
 * back into the draft store, which is the reported bug.
 *
 * Matching the exact submitted text would not do: an autocorrect that committed
 * around the submit ("teh" -> "the") describes the same stale state under a
 * different string, and a re-sent message would match it by accident. What
 * classifies a payload is where it came from and what the parent owns now.
 *
 * A caret move cannot change text, so one whose text disagrees with an already
 * cleared draft is describing the document the clear superseded — whether or
 * not the editor is still focused. (Android also emits a caret payload
 * mid-mutation, but the change event carrying the same text follows it
 * immediately and is forwarded, so nothing is lost.) While the parent still
 * owns text — an asynchronous send that has not cleared yet, a send that bailed
 * out — caret moves are live editing and must reach the parent, or the trigger
 * popover and command insertion work from a stale range.
 *
 * A text mutation is real input — unless the editor is already on its way out.
 * The keyboard commits a pending autocorrection as the text view resigns first
 * responder, and `editorAcceptsInput` is false from the moment the blur is
 * requested, which is what separates that commit from typing.
 */
export function isComposerResetWriteBack(
  state: ComposerResetState,
  event: ComposerNativeEventClassification,
): boolean {
  if (!state.suppressing || event.value.length === 0) return false;
  if (event.eventKind === "selection" && event.parentValue.length === 0) return true;
  return !event.editorAcceptsInput;
}

/**
 * The parent owns a draft again — the user typed, a command was inserted, a
 * rolled-back send put the message back — so the submit is over and the whole
 * window goes, suppression included.
 *
 * The one exception is the submitted text while the clear is still pending:
 * that is a send that has not cleared yet, and treating it as a fresh draft
 * would disarm the reset before it ever stamps. Once the clear has been handed
 * to native the exception lapses, so a rollback restoring exactly the submitted
 * text ends the window like any other parent-owned draft.
 */
export function observeComposerResetValue(
  state: ComposerResetState,
  value: string,
): ComposerResetState {
  if (!state.suppressing || value.length === 0) return state;
  if (state.clearPending && value === state.submittedText) return state;
  return IDLE_COMPOSER_RESET;
}
