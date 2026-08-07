// Fork feature: the color grid rendered inside Settings -> Appearance.
// Each row is one palette role; the swatch edits it live for the active
// preset theme and the current light/dark mode. The hook lives in the
// parent panel so the row-level reset can see the override state.

import { Undo2Icon } from "lucide-react";

import {
  CUSTOM_COLOR_TOKENS,
  resolveTokenHex,
  type useCustomThemeColors,
} from "../../hooks/customThemeColors";
import { Button } from "../ui/button";

export function CustomColorControls({
  colors,
}: {
  colors: ReturnType<typeof useCustomThemeColors>;
}) {
  const { overrides, setColor, resetColor } = colors;

  return (
    <div className="flex w-full flex-col gap-1.5 sm:w-64">
      {CUSTOM_COLOR_TOKENS.map((token) => {
        const overridden = token.key in overrides;
        const value = overrides[token.key] ?? resolveTokenHex(token);
        return (
          <div key={token.key} className="flex items-center gap-2">
            <label
              className="min-w-0 flex-1 truncate text-[13px] text-foreground"
              htmlFor={`custom-color-${token.key}`}
            >
              {token.label}
            </label>
            {overridden ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Reset ${token.label} to the theme default`}
                className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                onClick={() => resetColor(token.key)}
              >
                <Undo2Icon className="size-3" />
              </Button>
            ) : null}
            <input
              aria-label={`${token.label} color`}
              className="size-6 shrink-0 cursor-pointer rounded-sm border border-border bg-transparent p-0"
              id={`custom-color-${token.key}`}
              onChange={(event) => setColor(token.key, event.currentTarget.value)}
              type="color"
              value={value}
            />
          </div>
        );
      })}
    </div>
  );
}
