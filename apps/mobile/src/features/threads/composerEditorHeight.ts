export function resolveComposerEditorHeight(input: {
  readonly lineHeight: number;
  readonly explicitLineCount: number;
  readonly measuredTextHeight: number;
  readonly maxHeight: number;
}): { readonly desiredHeight: number; readonly height: number } {
  const desiredHeight = Math.max(
    input.lineHeight,
    input.explicitLineCount * input.lineHeight,
    Math.ceil(input.measuredTextHeight),
  );

  return {
    desiredHeight,
    height: Math.min(input.maxHeight, desiredHeight),
  };
}
