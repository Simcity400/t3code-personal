import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Ref } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

export type ComposerEditorSelection = {
  readonly start: number;
  readonly end: number;
};

export type ComposerEditorContentSize = {
  readonly width?: number;
  readonly height: number;
};

export interface ComposerEditorHandle {
  focus: () => void;
  blur: () => void;
  setSelection: (selection: ComposerEditorSelection) => void;
  /**
   * Called synchronously by the send handler the moment a draft is submitted,
   * before the draft store clears. The native editors use it to stamp the
   * cleared document at a revision no racing native event can outrank, and to
   * drop the in-flight native events that would otherwise write the just-sent
   * text back into the draft.
   *
   * Returns a callback the send handler must invoke once the send settles
   * (success, failure or bail-out), which is what keeps an asynchronous send's
   * late clear inside the window and starts the settle countdown.
   */
  markSubmitted: () => () => void;
}

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  readonly skills?: ReadonlyArray<
    Pick<ServerProviderSkill, "name" | "displayName" | "shortDescription" | "description">
  >;
  readonly selection?: ComposerEditorSelection;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  readonly scrollEnabled?: boolean;
  readonly autoCorrect?: boolean;
  readonly spellCheck?: boolean;
  readonly multiline?: boolean;
  /**
   * Identifies the draft this composer is editing (the scoped thread key). A
   * change means the composer was pointed at another draft, which ends any
   * post-submit reset armed for the previous one — two threads whose drafts
   * happen to match cannot be told apart from the text alone.
   */
  readonly ownerKey?: string;
  readonly contentInsetVertical?: number;
  /** Android: center a single line vertically (collapsed pill); no-op on iOS. */
  readonly singleLineCentered?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: StyleProp<TextStyle>;
  readonly onChangeText: (value: string) => void;
  readonly onContentSizeChange?: (size: ComposerEditorContentSize) => void;
  readonly onSelectionChange?: (selection: ComposerEditorSelection) => void;
  readonly onPasteImages?: (uris: ReadonlyArray<string>) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Invoked by the native editor when Command-Return is pressed on a hardware keyboard. */
  readonly onSubmit?: () => void;
}
