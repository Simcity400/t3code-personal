export async function blurComposerAfterDraftCommit(input: {
  readonly targetThreadKey: string;
  readonly currentThreadKey: () => string | null;
  readonly requestFrame: (callback: () => void) => unknown;
  readonly blur: () => void;
}): Promise<void> {
  await new Promise<void>((resolve) => input.requestFrame(resolve));
  if (input.currentThreadKey() === input.targetThreadKey) input.blur();
}
