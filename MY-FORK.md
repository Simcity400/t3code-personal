# My personal T3 Code

This is a private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with
personal customizations, backed up at
[Simcity400/t3code-personal](https://github.com/Simcity400/t3code-personal).

## Using it

- **Start the app**: double-click `Launch T3 Code (My Version).vbs` (silent — no
  terminal window; the desktop "T3 Code (Nightly)" shortcut points here with the
  nightly icon). `Launch T3 Code (My Version).cmd` does the same with a visible
  terminal, useful when something fails to start.
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
- **Shared profile with the installed app**: `apps/desktop/src/main.ts` pins the
  Electron userData profile (`%APPDATA%\t3code`) synchronously at startup, so this
  from-source build uses the same Windows encryption key as the installed T3 Code and
  can read the shared logins/device connections in `~\.t3\userdata`. Without it, the
  key is loaded from the default `%APPDATA%\Electron` profile and every saved
  connection shows up as missing. **Caveat**: because both apps now share the same
  profile and data, don't run this build and the installed T3 Code at the same time.
- **Directory launch**: `apps/desktop/scripts/start-electron.mjs` launches the app
  directory instead of `dist-electron/main.cjs`. With a bare entry file Electron has no
  package.json, so the app reported Electron's own version — the stage label fell back
  to "Alpha", which among other things hides Nightly-default beta features (Sidebar v2).
- **T3 Connect build config**: source builds need a root `.env` (gitignored, see
  `.env.example`) or T3 Connect is silently compiled out — no sign-in, and relay
  connections fail with "Sign in to T3 Connect". The values are public and match the
  official app:

  ```
  T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
  T3CODE_CLERK_JWT_TEMPLATE=t3-relay
  T3CODE_RELAY_URL=https://relay.t3.codes
  ```

  If `.env` ever goes missing, recreate it with those lines and rebuild.

- **Resource-monitor sidecar**: release builds ship a Rust sidecar
  (`t3-resource-monitor.exe`) that source builds don't compile, so resource
  diagnostics were silently unavailable. A copy from the installed app lives at
  `apps/desktop/resources/resource-monitor/` (gitignored). If it goes missing, re-copy
  it from `%LOCALAPPDATA%\Programs\t3code\resources\resource-monitor\`.
- **Nightly version pin**: `version` in `apps/server`, `apps/desktop`, `apps/web`, and
  `packages/contracts` package.json is pinned to the published npm nightly so the app
  identifies as Nightly and device connections install a matching published
  `t3@<version>` CLI on remote machines. Both update paths (the in-app updater and the
  Update cmd) re-pin automatically after merging upstream. The in-app update prompt is
  release-gated: it appears when the published npm nightly moves (checked every 4
  minutes, same cadence as official installs), so machines see update prompts in the
  same window. Upstream commits not yet in a nightly don't prompt — run the Update cmd
  to apply them early. To re-pin manually:
  `node scripts/update-release-package-versions.ts $(npm view t3 dist-tags.nightly)`
  then rebuild. Upstream version bumps may conflict with this pin during merges —
  resolve by re-running that command.

## Repo layout

- `origin` → the private backup repo (push here)
- `upstream` → the official repo (pull updates from here, never push)
