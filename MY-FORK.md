# My personal T3 Code

This is a private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with
personal customizations, backed up at
[Simcity400/t3code-personal](https://github.com/Simcity400/t3code-personal).

## Using it

- **Start the app**: use the "T3 Code (Nightly)" Start Menu shortcut. It points
  directly to `%LOCALAPPDATA%\Programs\t3code\T3 Code (Nightly).exe`. The two
  compatibility launch scripts open that same executable; they do not run a source
  or development build.
- **Get updates**: push to `main`. The Personal iPhone Preview publishes the mobile
  update, and `fork-release.yml` publishes the Windows build. The installed app checks
  that private release feed and shows its normal update button. For the private feed,
  the updater reads the existing `gh` login directly; it does not put the GitHub token
  in the app or agent environment. `fork-sync.yml` explicitly calls the same release
  workflow after it merges official changes into `main`.
- **Develop from source**: run the repo tooling explicitly. Source Electron is not a
  second installed app and must not be pinned to the Start Menu or taskbar.

## Setting up another computer

1. Install Git and GitHub CLI, then run `gh auth login` so the private release can be
   downloaded and the installed app can check for future updates.
2. `git clone https://github.com/Simcity400/t3code-personal.git "T3 Code Personal"`
3. Double-click `Setup T3 Code (My Version).cmd` in the clone. It downloads and
   installs the latest packaged personal release; it does not build another copy from
   source.
4. Sign in to T3 Connect inside the app (encrypted credentials don't transfer between
   machines).

Machines stay in sync through the update pill: whenever GitHub's `main` moves, the
Windows release workflow packages that exact commit. After it finishes, other machines
surface it on their next update check and apply it as a plain download. Because no
machine ever merges locally, machines
cannot conflict with each other anymore; the only merge that can conflict is
GitHub's own official-changes sync, resolved once with Claude Code from any
machine.

## Customizations so far

- **Color themes & custom color picker**: retired 2026-08-08 — the official app gained
  its own theme library (built-in palettes plus a custom theme editor with per-role
  colors, Settings → Appearance), which replaced the fork's Contrast/Paper/Ocean
  themes (`data-app-theme`) and the eight-swatch custom color picker
  (`customThemeColors.ts` / `CustomColorControls.tsx`, localStorage
  `t3code:custom-colors`). Previously saved fork themes/custom colors don't carry
  over — re-create them in the official theme editor. The fork presentation tweaks
  below live on in `themes.css`, with the dark-text rule rescoped to
  `:not([data-theme-id])` so official themes keep their own palettes.
- **Full-brightness chat text** (2026-08-06): the official app dims assistant messages
  to 80% foreground; a rule at the end of `themes.css` restores 100% in every theme.
- **One-line composer + brighter dark text + readable placeholder** (2026-08-06/07):
  rules at the end of `themes.css`.
- **Text size**: retired 2026-08-05 — the official app gained its own font size
  controls (Settings → Appearance), which replaced the fork's 13–20px `uiFontSize`
  slider. A previously customized text size resets to the default once; re-set it
  in the official controls.
- **Test runs ignore the root `.env`** (2026-08-12): `apps/web/vite.config.ts` skips
  `loadRepoEnv()` when vitest is running, so tests see the same empty public config
  as upstream CI. Without this, the `.env` below leaked the Clerk CLI OAuth client
  id into `import.meta.env` and permanently failed the two "not configured" cases
  in `connectCliAuth.test.ts` on every fork machine.
- **Shared profile with the installed app**: `apps/desktop/src/main.ts` pins the
  Electron userData profile (`%APPDATA%\t3code`) synchronously at startup, so this
  from-source build uses the same Windows encryption key as the installed T3 Code and
  can read the shared logins/device connections in `~\.t3\userdata`. Without it, the
  key is loaded from the default `%APPDATA%\Electron` profile and every saved
  connection shows up as missing. **Caveat**: because both apps now share the same
  profile and data, don't run this build and the installed T3 Code at the same time.
- **One user-facing Windows app**: the installed personal Nightly build is the normal
  launcher. Direct pushes to `origin/main` run `fork-release.yml`, publish a private
  Windows release, and surface it through the packaged app's update button. Source
  development commands must not be installed as Start Menu shortcuts. Because the
  release repository is private, GitHub CLI must be signed in. Only electron-updater
  receives that token; app backends and agents do not.
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
  `t3@<version>` CLI on remote machines. The scheduled sync re-pins automatically after
  merging upstream, then publishes the same packaged app. To re-pin manually:
  `node scripts/update-release-package-versions.ts $(npm view t3 dist-tags.nightly)`
  then rebuild. Upstream version bumps conflict with this pin on every sync by
  construction; since 2026-08-08 `fork-sync.yml` resolves that class automatically
  (upstream's side wins, then the pin re-stamps), so the `needs-merge-help` pill
  only appears for genuine code conflicts.

## Repo layout

- `origin` → the private backup repo (push here)
- `upstream` → the official repo (pull updates from here, never push)
