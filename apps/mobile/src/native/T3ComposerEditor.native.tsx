import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { requireNativeView } from "expo";
import { TextInputWrapper } from "expo-paste-input";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { Image, StyleSheet } from "react-native";

import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@t3tools/mobile-markdown-text/links";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useNativePaste } from "../lib/useNativePaste";
import { useFontFamily } from "../lib/useFontFamily";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  beginComposerReset,
  COMPOSER_RESET_EVENT_COUNT,
  COMPOSER_RESET_SETTLE_FRAMES,
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
  type ComposerResetState,
} from "./composerEditorRevision";
import type { ComposerEditorProps, ComposerEditorSelection } from "./T3ComposerEditor.types";

const NATIVE_MODULE_NAME = "T3ComposerEditor";
const EMPTY_SKILLS: NonNullable<ComposerEditorProps["skills"]> = [];

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativeSelectionEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>;
}>;

type NativeContentSizeEvent = NativeSyntheticEvent<{
  readonly width?: number;
  readonly height: number;
}>;

interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly singleLineCentered: boolean;
  readonly editable: boolean;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerContentSizeChange?: (event: NativeContentSizeEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

function fileIconUri(path: string): string {
  return Image.resolveAssetSource(markdownFileIconSource(resolveMarkdownFileIcon(path))).uri;
}

export function ComposerEditor({
  ref,
  skills = EMPTY_SKILLS,
  selection,
  style,
  textStyle,
  onChangeText,
  onContentSizeChange,
  onSelectionChange,
  onPasteImages,
  onFocus,
  onBlur,
  ownerKey,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // The native editor mounts empty, so the snapshot history starts empty: the
  // first controlled payload must be a non-echo so a restored draft (or a
  // recycled native view) is applied rather than skipped.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  const composerResetRef = useRef<ComposerResetState>(IDLE_COMPOSER_RESET);
  const composerResetFrameRef = useRef<number | null>(null);
  // Identifies the submit that owns the window, so a disposer from an earlier
  // send cannot start the countdown against a newer one. The composer instance
  // is shared across threads in the split layout, where two sends can overlap.
  const submitTokenRef = useRef(0);
  // The editor accepts input only while it is focused with no blur pending.
  // A blur requested from JS counts immediately: the events it provokes — the
  // caret move, the autocorrect the keyboard commits on the way out — are
  // delivered before the native blur callback, and every one of them describes
  // state from before the submit.
  const composerFocusedRef = useRef(false);
  const composerBlurPendingRef = useRef(false);
  const composerOwnerKeyRef = useRef(ownerKey);
  // Value of the last committed render, which is what the native editor holds.
  // The send handler reads it before the draft store clears, so at that moment
  // it is exactly the submitted text.
  const latestValueRef = useRef(props.value);
  const [submitSequence, setSubmitSequence] = useState(0);
  const [initialConfirmedTokens] = useState(() => collectComposerInlineTokens(props.value));
  const confirmedTokensRef = useRef(initialConfirmedTokens);
  const theme = useUniwindTheme();
  const handlePaste = useNativePaste((uris) => onPasteImages?.(uris));

  const editorAcceptsInput = useCallback(
    () => composerFocusedRef.current && !composerBlurPendingRef.current,
    [],
  );
  const cancelComposerResetFrame = useCallback(() => {
    if (composerResetFrameRef.current !== null) {
      cancelAnimationFrame(composerResetFrameRef.current);
      composerResetFrameRef.current = null;
    }
  }, []);
  const closeComposerResetWindow = useCallback(() => {
    cancelComposerResetFrame();
    composerResetRef.current = IDLE_COMPOSER_RESET;
  }, [cancelComposerResetFrame]);
  // Only bounds the pending clear; suppression outlives it and ends on focus.
  const startComposerResetCountdown = useCallback(() => {
    cancelComposerResetFrame();
    let remainingFrames = COMPOSER_RESET_SETTLE_FRAMES;
    const step = () => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        composerResetFrameRef.current = requestAnimationFrame(step);
        return;
      }
      composerResetFrameRef.current = null;
      // A live editor at this point means the send provoked nothing that is
      // still in flight, so the whole window goes; otherwise suppression waits
      // for the focus that precedes the user's next keystroke.
      composerResetRef.current = editorAcceptsInput()
        ? IDLE_COMPOSER_RESET
        : retireComposerResetClear(composerResetRef.current);
    };
    composerResetFrameRef.current = requestAnimationFrame(step);
  }, [cancelComposerResetFrame, editorAcceptsInput]);
  useEffect(() => cancelComposerResetFrame, [cancelComposerResetFrame]);

  const handleNativeFocus = useCallback(() => {
    composerFocusedRef.current = true;
    composerBlurPendingRef.current = false;
    // Focus precedes the user's next keystroke, and every event the send
    // provoked was delivered long before it, so this is where suppression ends.
    closeComposerResetWindow();
    onFocus?.();
  }, [closeComposerResetWindow, onFocus]);
  const handleNativeBlur = useCallback(() => {
    composerFocusedRef.current = false;
    composerBlurPendingRef.current = false;
    onBlur?.();
  }, [onBlur]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => void nativeRef.current?.focus(),
      blur: () => {
        // Recorded before the native call: resigning first responder emits the
        // caret move and autocorrect commit that carry pre-submit text, and
        // they reach this bridge before the native blur callback does.
        if (composerFocusedRef.current) composerBlurPendingRef.current = true;
        void nativeRef.current?.blur();
      },
      setSelection: (nextSelection) =>
        void nativeRef.current?.setSelection(nextSelection.start, nextSelection.end),
      markSubmitted: () => {
        // Runs synchronously inside the send handler, before the draft store
        // clears, so the write-back window is already open by the time the
        // native events the submit provokes are delivered. The render it forces
        // stamps the cleared document even when the draft was already empty.
        const submitToken = submitTokenRef.current + 1;
        submitTokenRef.current = submitToken;
        composerResetRef.current = beginComposerReset(latestValueRef.current);
        // No countdown yet: the window has to span the whole in-flight send so
        // an asynchronous one (`/side` awaits the server before it clears) is
        // still eligible for the reset stamp when its clear finally lands.
        cancelComposerResetFrame();
        setSubmitSequence((sequence) => sequence + 1);
        return () => {
          // The send settled — cleared, failed or bailed out. Either way this
          // is the last moment it can provoke a native event, so the window
          // starts counting down from here and a pending clear that never
          // happened is retired with it. A newer submit owns the window by
          // then in the overlapping-send case, and it must not be disturbed.
          if (submitTokenRef.current !== submitToken) return;
          startComposerResetCountdown();
        };
      },
    }),
    [cancelComposerResetFrame, startComposerResetCountdown],
  );

  const skillLabels = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill.displayName?.trim() || skill.name])),
    [skills],
  );
  const tokensJson = useMemo(() => {
    const tokens = collectComposerInlineTokens(props.value, {
      preserveTrailingFrom: confirmedTokensRef.current,
    });
    confirmedTokensRef.current = tokens;
    return JSON.stringify(
      tokens.map((token) => ({
        type: token.type,
        source: token.source,
        start: token.start,
        end: token.end,
        label:
          token.type === "skill"
            ? (skillLabels.get(token.value) ?? token.value)
            : basename(token.value),
        iconUri: token.type === "mention" ? fileIconUri(token.value) : null,
      })),
    );
  }, [props.value, skillLabels]);
  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  // Read-only during render. The reset is armed imperatively by the send
  // handler and advanced in layout effects, so a render React interrupts or
  // discards can never leave the window half-applied.
  const composerResetStamp = isComposerResetPending(composerResetRef.current, props.value)
    ? COMPOSER_RESET_EVENT_COUNT
    : null;
  const controlledEventCount =
    composerResetStamp ??
    resolveComposerControlledEventCount(
      props.value,
      selection ?? null,
      mostRecentEventCount,
      nativeEventSnapshotsRef.current,
    );
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  // The post-submit clear is never an echo: the native side drops an echo whose
  // value does not already match its own text, which is exactly the case here.
  const isNativeEcho =
    composerResetStamp === null &&
    controlledEventCount === mostRecentEventCount &&
    acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
  const assumedValue = props.value;
  useEffect(() => {
    // A native event that arrived after this render was committed moves the
    // acknowledged revision forward; the editor rejects this payload, so the
    // snapshot history must not assume it applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      assumedValue,
    );
  }, [assumedValue, controlledEventCount, isNativeEcho, controlledDocumentJson]);
  // Layout effects, not passive ones: a native event delivered between the
  // commit and a passive effect would be classified against a reset phase the
  // commit already moved past, and could record a snapshot of superseded text.
  useLayoutEffect(() => {
    if (composerOwnerKeyRef.current !== ownerKey) {
      // The composer was pointed at another draft. Whatever a submit on the
      // previous one still had outstanding does not describe this editor's
      // contents, and inferring that from the text alone would miss two
      // threads whose drafts happen to match.
      composerOwnerKeyRef.current = ownerKey;
      closeComposerResetWindow();
    }
    latestValueRef.current = props.value;
    composerResetRef.current = observeComposerResetValue(composerResetRef.current, props.value);
  }, [closeComposerResetWindow, ownerKey, props.value]);
  useLayoutEffect(() => {
    if (composerResetStamp === null) return;
    // The acknowledged history describes the pre-submit document. The cleared
    // one supersedes all of it, so keeping those entries would let a later
    // render resolve back to a superseded revision and re-apply the sent text.
    // Discarding them is also what lets the cleared document be restated at a
    // racing revision, so a payload suppressed after the clear is erased from
    // the text view rather than left on screen.
    nativeEventSnapshotsRef.current = [];
    composerResetRef.current = handOffComposerReset(composerResetRef.current);
  }, [composerResetStamp, submitSequence]);
  const acceptNativeEvent = useCallback(
    (
      eventCount: number,
      value: string,
      nextSelection: ComposerEditorSelection,
      eventKind: ComposerNativeEventKind,
    ): "rejected" | "write-back" | "accepted" => {
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      );
      if (acknowledgedEventCount === null) {
        return "rejected";
      }
      mostRecentEventCountRef.current = acknowledgedEventCount;
      // A payload delivered after the submit while the editor is not accepting
      // input was produced before the native side applied the post-submit
      // clear: the submitted text, or an autocorrect/IME variant of it. Handing
      // one to the parent restores the message the user just sent, which is the
      // reported bug. Anything typed while the editor is still live is real
      // input and is forwarded untouched.
      const isWriteBack = isComposerResetWriteBack(composerResetRef.current, {
        value,
        eventKind,
        parentValue: latestValueRef.current,
        editorAcceptsInput: editorAcceptsInput(),
      });
      // Recorded either way. The snapshot is what stamps a later render of the
      // parent's own (now superseded) value behind this revision, so a payload
      // this window suppressed by mistake is merely ignored rather than
      // overwritten; a cleared draft resolves past it and still wins.
      nativeEventSnapshotsRef.current.push({
        eventCount: acknowledgedEventCount,
        value,
        selection: nextSelection,
      });
      // Acknowledged either way: a suppressed payload still moved the native
      // revision, and the next render has to restate the cleared document at
      // that revision for the native side to accept it.
      setMostRecentEventCount(acknowledgedEventCount);
      forceNativeEventRender((sequence) => sequence + 1);
      return isWriteBack ? "write-back" : "accepted";
    },
    [editorAcceptsInput],
  );
  const themeJson = JSON.stringify({
    text: theme["--color-foreground"],
    placeholder: theme["--color-placeholder"],
    chipBackground: theme["--color-subtle"],
    chipBorder: theme["--color-border"],
    chipText: theme["--color-foreground"],
    skillBackground: theme["--color-inline-skill-background"],
    skillBorder: theme["--color-inline-skill-border"],
    skillText: theme["--color-inline-skill-foreground"],
    fileTint: theme["--color-icon-muted"],
  });
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  const regularFontFamily = useFontFamily("regular");
  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
        themeJson={themeJson}
        placeholder={props.placeholder ?? ""}
        fontFamily={
          typeof resolvedTextStyle.fontFamily === "string"
            ? resolvedTextStyle.fontFamily
            : regularFontFamily
        }
        fontSize={
          typeof resolvedTextStyle.fontSize === "number"
            ? resolvedTextStyle.fontSize
            : MOBILE_TYPOGRAPHY.body.fontSize
        }
        lineHeight={
          typeof resolvedTextStyle.lineHeight === "number"
            ? resolvedTextStyle.lineHeight
            : MOBILE_TYPOGRAPHY.body.lineHeight
        }
        contentInsetVertical={contentInsetVertical}
        singleLineCentered={props.singleLineCentered ?? false}
        editable={(props.editable ?? true) && !(props.readOnly ?? false)}
        scrollEnabled={props.scrollEnabled ?? true}
        autoFocus={props.autoFocus ?? false}
        autoCorrect={props.autoCorrect ?? true}
        spellCheck={props.spellCheck ?? true}
        style={{ flex: 1, minHeight: 0 }}
        onComposerContentSizeChange={(event) => onContentSizeChange?.(event.nativeEvent)}
        onComposerChange={(event) => {
          const nativeEventResult = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
            "change",
          );
          if (nativeEventResult !== "accepted") return;
          onChangeText(event.nativeEvent.value);
          onSelectionChange?.(event.nativeEvent.selection);
        }}
        onComposerSelectionChange={(event) => {
          const nativeEventResult = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
            "selection",
          );
          if (nativeEventResult !== "accepted") return;
          // Android emits the selection change mid-mutation, before the change
          // event, so the payload can carry post-edit text. It must reach the
          // parent alongside the acknowledged revision, or the next render
          // stamps the stale draft at that revision and can re-apply it over
          // the newer native text.
          if (event.nativeEvent.value !== props.value) {
            onChangeText(event.nativeEvent.value);
          }
          onSelectionChange?.(event.nativeEvent.selection);
        }}
        onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
        onComposerFocus={handleNativeFocus}
        onComposerBlur={handleNativeBlur}
      />
    </TextInputWrapper>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
