/** Native measurements include soft wraps and inline tokens at the current width. */
export function resolveComposerEditorHeight(input: {
  readonly lineHeight: number;
  readonly explicitLineCount: number;
  readonly measuredTextHeight: number;
  readonly maxHeight: number;
}): number {
  return Math.min(
    input.maxHeight,
    Math.max(
      input.lineHeight,
      input.explicitLineCount * input.lineHeight,
      Number.isFinite(input.measuredTextHeight) ? Math.ceil(input.measuredTextHeight) : 0,
    ),
  );
}
