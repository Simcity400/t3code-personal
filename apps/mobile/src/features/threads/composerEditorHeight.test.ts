import { describe, expect, it } from "vite-plus/test";

import { resolveComposerEditorHeight } from "./composerEditorHeight";

describe("resolveComposerEditorHeight", () => {
  it("shrinks again when wrapped text loses a line", () => {
    const expanded = resolveComposerEditorHeight({
      lineHeight: 24,
      explicitLineCount: 1,
      measuredTextHeight: 72,
      maxHeight: 160,
    });
    const shortened = resolveComposerEditorHeight({
      lineHeight: 24,
      explicitLineCount: 1,
      measuredTextHeight: 48,
      maxHeight: 160,
    });

    expect(expanded).toEqual({ desiredHeight: 72, height: 72 });
    expect(shortened).toEqual({ desiredHeight: 48, height: 48 });
  });

  it("keeps explicit newlines and the maximum height", () => {
    expect(
      resolveComposerEditorHeight({
        lineHeight: 24,
        explicitLineCount: 3,
        measuredTextHeight: 24,
        maxHeight: 60,
      }),
    ).toEqual({ desiredHeight: 72, height: 60 });
  });
});
