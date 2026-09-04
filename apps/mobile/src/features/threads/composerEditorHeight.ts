export function resolveComposerEditorHeight(input: {
  readonly lineHeight: number;
  readonly explicitLineCount: number;
  readonly measuredTextHeight: number;
  readonly minHeight?: number;
  readonly maxHeight: number;
}): { readonly desiredHeight: number; readonly height: number } {
  const desiredHeight = Math.max(
    input.minHeight ?? 0,
    input.lineHeight,
    input.explicitLineCount * input.lineHeight,
    Math.ceil(input.measuredTextHeight),
  );

  return {
    desiredHeight,
    height: Math.min(input.maxHeight, desiredHeight),
  };
}

export function resolveMobileComposerEditorMaxHeight(windowHeight: number): number {
  return Math.max(160, Math.min(320, Math.floor(windowHeight * 0.4)));
}

export function resolveComposerSettingsControlHeight(input: {
  readonly detailLineHeight: number;
  readonly fontScale: number;
  readonly modelLineHeight: number;
}): number {
  const contentHeight = input.modelLineHeight + input.detailLineHeight * 3;
  return Math.ceil(Math.max(72, contentHeight) * Math.max(1, input.fontScale));
}
