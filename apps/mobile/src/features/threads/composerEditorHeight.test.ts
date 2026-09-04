import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerEditorHeight,
  resolveComposerSettingsControlHeight,
  resolveMobileComposerEditorMaxHeight,
} from "./composerEditorHeight";

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

  it("honors a surface-specific minimum height", () => {
    expect(
      resolveComposerEditorHeight({
        lineHeight: 24,
        explicitLineCount: 1,
        measuredTextHeight: 24,
        minHeight: 72,
        maxHeight: 160,
      }),
    ).toEqual({ desiredHeight: 72, height: 72 });
  });
});

describe("resolveMobileComposerEditorMaxHeight", () => {
  it("uses more of a phone screen without overtaking large layouts", () => {
    expect(resolveMobileComposerEditorMaxHeight(568)).toBe(227);
    expect(resolveMobileComposerEditorMaxHeight(844)).toBe(320);
    expect(resolveMobileComposerEditorMaxHeight(1_200)).toBe(320);
  });

  it("keeps a usable cap when the reported window is short", () => {
    expect(resolveMobileComposerEditorMaxHeight(320)).toBe(160);
  });
});

describe("resolveComposerSettingsControlHeight", () => {
  it("accounts for both appearance and accessibility text scaling", () => {
    expect(
      resolveComposerSettingsControlHeight({
        detailLineHeight: 16,
        fontScale: 0.8,
        modelLineHeight: 19,
      }),
    ).toBe(72);
    expect(
      resolveComposerSettingsControlHeight({
        detailLineHeight: 16,
        fontScale: 1.5,
        modelLineHeight: 19,
      }),
    ).toBe(108);
    expect(
      resolveComposerSettingsControlHeight({
        detailLineHeight: 22,
        fontScale: 1,
        modelLineHeight: 26,
      }),
    ).toBe(92);
  });
});
