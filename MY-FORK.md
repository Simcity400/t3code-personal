# My personal T3 Code

This is a private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with
personal customizations, backed up at
[Simcity400/t3code-personal](https://github.com/Simcity400/t3code-personal).

## Using it

- **Start the app**: double-click `Launch T3 Code (My Version).cmd`
- **Get official updates**: double-click `Update T3 Code (My Version).cmd` — it pulls the
  latest official release, merges it with the customizations, rebuilds, and backs up to
  the private repo. If a merge conflict appears, open Claude Code in this folder and say
  "finish the upstream merge".

## Customizations so far

- **Color themes** (Settings → Appearance): Default, High contrast, Paper, Ocean — each
  with light and dark variants. Implemented in `apps/web/src/themes.css` via a
  `data-app-theme` attribute set by `apps/web/src/hooks/useTheme.ts`.
- **Text size** (Settings → Appearance): 13–20px slider, persisted as `uiFontSize` in
  client settings, applied by `TextSizeSync` in `apps/web/src/routes/__root.tsx`.

## Repo layout

- `origin` → the private backup repo (push here)
- `upstream` → the official repo (pull updates from here, never push)
