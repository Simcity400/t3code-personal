import { describe, expect, it } from "vite-plus/test";

import { resolveComposerEditorHeight } from "./composerEditorHeight";

describe("resolveComposerEditorHeight", () => {
  const base = { lineHeight: 24, explicitLineCount: 1, measuredTextHeight: 0, maxHeight: 160 };

  it("starts at one line and follows native soft wrapping in both directions", () => {
    expect(resolveComposerEditorHeight(base)).toBe(24);
    expect(resolveComposerEditorHeight({ ...base, measuredTextHeight: 72 })).toBe(72);
    expect(resolveComposerEditorHeight({ ...base, measuredTextHeight: 24 })).toBe(24);
  });

  it("reserves explicit newlines before native measurement arrives", () => {
    expect(resolveComposerEditorHeight({ ...base, explicitLineCount: 3 })).toBe(72);
  });

  it("caps long drafts and respects larger text", () => {
    expect(resolveComposerEditorHeight({ ...base, measuredTextHeight: 480 })).toBe(160);
    expect(resolveComposerEditorHeight({ ...base, lineHeight: 38 })).toBe(38);
  });

  it("rounds fractional measurements up and ignores invalid measurements", () => {
    expect(resolveComposerEditorHeight({ ...base, measuredTextHeight: 48.2 })).toBe(49);
    expect(resolveComposerEditorHeight({ ...base, measuredTextHeight: NaN })).toBe(24);
  });
});
