// Fork feature: user-editable interface colors, layered on top of whichever
// preset color theme is active. Overrides are stored per theme and per
// light/dark mode in localStorage and injected as a <style> tag whose
// declarations carry !important, so they outrank every stylesheet layer
// (index.css defaults, themes.css presets, and the [data-sidebar-version]
// shell overrides) without touching upstream files.

import { useCallback, useEffect, useState } from "react";

import type { ColorTheme } from "./useTheme";

export type ThemeMode = "light" | "dark";

export interface CustomColorToken {
  readonly key: string;
  readonly label: string;
  readonly cssVars: readonly string[];
}

/**
 * Curated palette knobs. Each picker drives every CSS variable that shares
 * its visual role, so one choice stays consistent across the app shell,
 * cards, popovers, and the sidebar.
 */
export const CUSTOM_COLOR_TOKENS: readonly CustomColorToken[] = [
  {
    key: "background",
    label: "Background",
    cssVars: ["--background", "--app-chrome-background"],
  },
  {
    key: "panels",
    label: "Panels & menus",
    cssVars: ["--card", "--popover", "--sidebar"],
  },
  {
    key: "mainText",
    label: "Main text",
    cssVars: [
      "--foreground",
      "--card-foreground",
      "--popover-foreground",
      "--secondary-foreground",
      "--sidebar-foreground",
    ],
  },
  {
    key: "secondaryText",
    label: "Secondary text",
    cssVars: ["--muted-foreground", "--sidebar-muted-foreground"],
  },
  {
    key: "accent",
    label: "Accent color",
    cssVars: ["--primary", "--ring"],
  },
  {
    key: "accentText",
    label: "Text on accent",
    cssVars: ["--primary-foreground", "--accent-foreground"],
  },
  {
    key: "highlight",
    label: "Hover highlight",
    cssVars: ["--accent", "--sidebar-row-hover", "--sidebar-row-active", "--sidebar-row-selected"],
  },
  {
    key: "borders",
    label: "Borders & outlines",
    // --chat-composer-outline is the composer bubble's private border var;
    // it's (re)defined on .chat-composer-glass-shell, which is why that
    // element is part of the override selector below.
    cssVars: ["--border", "--sidebar-border", "--input", "--chat-composer-outline"],
  },
];

const TOKENS_BY_KEY = new Map(CUSTOM_COLOR_TOKENS.map((token) => [token.key, token]));

const STORAGE_KEY = "t3code:custom-colors";
const STYLE_ELEMENT_ID = "t3code-custom-color-overrides";
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

type ModeOverrides = Record<string, string>;
type ThemeOverrides = Partial<Record<ThemeMode, ModeOverrides>>;
type AllOverrides = Partial<Record<ColorTheme, ThemeOverrides>>;

let onAppliedCallback: (() => void) | null = null;

/** Lets useTheme re-sync the window chrome color after overrides change. */
export function setCustomColorsAppliedCallback(callback: () => void): void {
  onAppliedCallback = callback;
}

function readAllOverrides(): AllOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as AllOverrides;
  } catch {
    return {};
  }
}

function writeAllOverrides(all: AllOverrides): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage rejected the write; the in-memory style tag still applies for
    // this session, so stay quiet rather than surfacing an error.
  }
}

function sanitizeModeOverrides(overrides: unknown): ModeOverrides {
  if (typeof overrides !== "object" || overrides === null) return {};
  const sanitized: ModeOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (TOKENS_BY_KEY.has(key) && typeof value === "string" && HEX_COLOR_PATTERN.test(value)) {
      sanitized[key] = value.toLowerCase();
    }
  }
  return sanitized;
}

export function getCustomColorOverrides(theme: ColorTheme, mode: ThemeMode): ModeOverrides {
  return sanitizeModeOverrides(readAllOverrides()[theme]?.[mode]);
}

function buildBlock(selectorPrefix: string, overrides: ModeOverrides): string {
  const declarations: string[] = [];
  for (const [key, hex] of Object.entries(overrides)) {
    const token = TOKENS_BY_KEY.get(key);
    if (!token) continue;
    for (const cssVar of token.cssVars) {
      declarations.push(`  ${cssVar}: ${hex} !important;`);
    }
  }
  if (declarations.length === 0) return "";
  // Descendant surfaces that (re)define palette vars locally must be listed
  // here: a var set on the element itself beats anything inherited from
  // :root, no matter the specificity or !important on the root declaration.
  const shells = `:is([data-sidebar-version="v1"], [data-sidebar-version="v2"], .chat-composer-glass-shell)`;
  return `${selectorPrefix}, ${selectorPrefix} ${shells} {\n${declarations.join("\n")}\n}\n`;
}

/**
 * Injects (or refreshes) the override style tag for the active preset theme.
 * Both modes are emitted so a light/dark toggle needs no re-apply.
 */
export function applyCustomThemeColors(theme: ColorTheme): void {
  // Tolerate minimal document stubs (tests) that lack full DOM APIs.
  if (
    typeof document === "undefined" ||
    typeof document.getElementById !== "function" ||
    typeof document.createElement !== "function" ||
    !document.head
  ) {
    return;
  }
  const themeOverrides = readAllOverrides()[theme] ?? {};
  const css =
    buildBlock(":root:not(.dark)", sanitizeModeOverrides(themeOverrides.light)) +
    buildBlock(":root.dark", sanitizeModeOverrides(themeOverrides.dark));

  let element = document.getElementById(STYLE_ELEMENT_ID);
  if (!element) {
    if (!css) return;
    element = document.createElement("style");
    element.id = STYLE_ELEMENT_ID;
    document.head.append(element);
  } else if (element.parentElement === document.head) {
    // Keep the tag last in <head> so it stays after any styles injected since.
    document.head.append(element);
  }
  element.textContent = css;
  onAppliedCallback?.();
}

/**
 * Resolves what a token currently renders as (override or theme default),
 * as #rrggbb for seeding a color input. Alpha is discarded.
 */
export function resolveTokenHex(token: CustomColorToken): string {
  if (typeof document === "undefined") return "#000000";
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${token.cssVars[0]})`;
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(computed);
  if (!match) return "#000000";
  const toHex = (part: string) => Number(part).toString(16).padStart(2, "0");
  return `#${toHex(match[1] ?? "0")}${toHex(match[2] ?? "0")}${toHex(match[3] ?? "0")}`;
}

export function useCustomThemeColors(theme: ColorTheme, mode: ThemeMode) {
  const [overrides, setOverridesState] = useState<ModeOverrides>(() =>
    getCustomColorOverrides(theme, mode),
  );

  useEffect(() => {
    setOverridesState(getCustomColorOverrides(theme, mode));
  }, [theme, mode]);

  const setColor = useCallback(
    (key: string, hex: string) => {
      if (!HEX_COLOR_PATTERN.test(hex)) return;
      const all = readAllOverrides();
      const themeOverrides: ThemeOverrides = all[theme] ?? {};
      const modeOverrides = sanitizeModeOverrides(themeOverrides[mode]);
      modeOverrides[key] = hex.toLowerCase();
      themeOverrides[mode] = modeOverrides;
      all[theme] = themeOverrides;
      writeAllOverrides(all);
      applyCustomThemeColors(theme);
      setOverridesState({ ...modeOverrides });
    },
    [theme, mode],
  );

  const resetColor = useCallback(
    (key: string) => {
      const all = readAllOverrides();
      const modeOverrides = sanitizeModeOverrides(all[theme]?.[mode]);
      delete modeOverrides[key];
      if (all[theme]) {
        all[theme][mode] = modeOverrides;
      }
      writeAllOverrides(all);
      applyCustomThemeColors(theme);
      setOverridesState({ ...modeOverrides });
    },
    [theme, mode],
  );

  const resetAll = useCallback(() => {
    const all = readAllOverrides();
    if (all[theme]) {
      all[theme][mode] = {};
    }
    writeAllOverrides(all);
    applyCustomThemeColors(theme);
    setOverridesState({});
  }, [theme, mode]);

  return { overrides, setColor, resetColor, resetAll } as const;
}
