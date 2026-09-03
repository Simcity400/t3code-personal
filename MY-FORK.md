# My personal T3 Code

This is a private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with
personal customizations, backed up at
[Simcity400/t3code-personal](https://github.com/Simcity400/t3code-personal).

## Using it

- **Start the app**: use the "T3 Code (Nightly)" Start Menu shortcut. It points
  directly to `%LOCALAPPDATA%\Programs\t3code\T3 Code (Nightly).exe`. The two
  compatibility launch scripts open that same executable; they do not run a source
  or development build.
- **Get updates**: just push to `main`. GitHub Actions runs again on this account
  (the 2026-08-17 → 2026-09-03 billing block is over), so every push to `main`
  starts `fork-release.yml`, which packages that exact commit and publishes it as a
  private prerelease; `fork-mobile-preview.yml` publishes the matching iPhone OTA
  update. Official changes arrive on their own: `fork-sync.yml` runs every two hours,
  merges `upstream/main` when npm's `t3` nightly moves, re-pins the four package
  versions, pushes `main`, and then calls both `fork-release.yml` and
  `fork-mobile-preview.yml` — so no machine ever merges or pins locally. Only when the merge hits a genuine conflict does it stop and
  push the `needs-merge-help` marker branch, which the in-app pill turns into "open
  Claude Code and say: finish the upstream merge". Only after a release run finishes
  does the installed app have a newer version to offer: the updater compares against
  the newest release on the private feed, so while `main` is ahead of the last
  published release no update pill appears — correctly, because no newer release
  exists yet.
  **Manual fallback** (Actions down, or a release run that failed and you do not want
  to re-run from the Actions tab): double-click
  `Publish T3 Code Update (My Version).cmd` in the project folder. It packages the
  exact `origin/main` commit, publishes the private prerelease, and pushes the iPhone
  OTA update, and refuses to run unless every tracked file is clean (untracked files
  are ignored) and local `main` already equals `origin/main`. For one of the two only,
  run it from a terminal: `node scripts\publish-personal-update.ts --desktop-only`
  (or `--iphone-only`).
  For the private feed, the updater reads the existing `gh` login directly; it does not
  put the GitHub token in the app or agent environment.
- **iPhone agent alerts**: the personal preview registers an Expo Push token with each
  connected T3 Code environment, so approval, input, completion, and failure alerts do
  not depend on the official app's APNs identity. Remote Live Activity updates remain
  unavailable in the personal build because they require a separately operated APNs
  relay whose signing team matches this app.
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

Machines stay in sync through the update pill: whenever GitHub's `main` moves,
`fork-release.yml` packages that exact commit (or
`Publish T3 Code Update (My Version).cmd` on this machine, as a fallback).
After it finishes, other machines surface it on their next update check and apply it as
a plain download. Because no machine ever merges locally, machines
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
- **Brighter dark text** (2026-08-06/07): a rule at the end of `themes.css` raises the
  default dark palette one step (`:root.dark:not([data-theme-id])`), so official themes
  keep their own values.
- **Readable composer placeholder**: retired 2026-09-03 — the rule keyed off
  `.composer-editor-surface`, a class upstream had already removed, so it had stopped
  matching anything; upstream now owns placeholder contrast itself through the
  `--placeholder` token and `text-placeholder` (#9104, #9113). The dead rule was deleted
  from `themes.css`.
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
  launcher. A publish run after each push to `origin/main` builds a private Windows
  release and surfaces it through the packaged app's update button — see **Get updates**
  above for which publisher runs it. Source
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
- **Automatic upstream sync without Actions**: retired 2026-09-03 — GitHub Actions bills
  again, so `fork-sync.yml` runs on its own schedule and the local Task Scheduler
  stand-in is gone. Deleted: `scripts/local-fork-sync.ts`, `scripts/local-fork-sync.test.ts`,
  `scripts/register-local-fork-sync.cmd`, and the "T3 Personal Fork Sync" scheduled task
  (`schtasks /delete /tn "T3 Personal Fork Sync" /f` if it ever comes back on another
  machine). `scripts/publish-personal-update.ts` stays as the manual publisher.
- **Only the fork's own workflows** (2026-09-03): `.github/workflows` keeps exactly
  `fork-sync.yml`, `fork-release.yml` and `fork-mobile-preview.yml`. Every upstream
  workflow (`ci.yml`, `release.yml`, `deploy-relay.yml`, `pr-size.yml`, `pr-vouch.yml`,
  `issue-labels.yml`, `publish-aur.yml`, `web-preview.yml`, `thread-transfer-report.yml`,
  `desktop-macos-preview.yml`, and the four `mobile-*` ones) is deleted here: they need
  T3's Blacksmith runners, secrets or PR bots, so on this fork they only ever queue runs
  that cannot succeed. It is not just tidiness — `GITHUB_TOKEN` has no `workflows`
  permission, so any Actions push that adds or modifies a `.github/workflows/*` file is
  rejected, which silently broke the sync whenever upstream touched a workflow (in the
  fork's whole history every merge that touched `.github/workflows` was pushed by hand;
  the 37 bot merges never did). `fork-sync.yml` now keeps them deleted by itself: a
  conflict in a non-allowlisted workflow resolves to "delete it", a newly added one is
  removed in a follow-up `chore(fork): drop upstream-only workflows` commit, and a guard
  aborts the run before any push if the branch would still carry a workflow change.
  Upstream's `infra/relay/scripts/deploy.test.ts` guard over `release.yml` was dropped
  with it. `fork-release.yml`'s old `sync_upstream` job — a second, weaker copy of the
  same merge — was deleted; `fork-sync.yml` is the only place that merges upstream.
  Same round: `fork-mobile-preview.yml` gained a `workflow_call` trigger and
  `fork-sync.yml` now calls it beside `fork-release.yml`. GitHub never fires a `push`
  workflow for a push made with `GITHUB_TOKEN`, so before this the iPhone OTA silently
  stopped following `main` whenever the scheduled sync — rather than a person — was what
  moved it; only the desktop release was being called explicitly.
- **One-line composer (web)**: retired 2026-09-03 — upstream's "collapse the resting
  composer" (#7855) collapses the desktop composer to a single line at rest and expands
  it on focus, replacing the fork's `min-h-[1lh]` on the composer `ContentEditable` in
  `apps/web/src/components/ComposerPromptEditor.tsx`. The composer is now one line only
  while unfocused on an existing thread; focused and new-thread composers use upstream's
  taller box. The mobile one-line composer (`composerEditorHeight.ts`) is unaffected and
  still ships.
- **Nightly version pin**: `version` in `apps/server`, `apps/desktop`, `apps/web`, and
  `packages/contracts` package.json is pinned to the published npm nightly so the app
  identifies as Nightly and device connections install a matching published
  `t3@<version>` CLI on remote machines. The scheduled `fork-sync.yml` re-pins
  automatically after merging upstream, then publishes the same packaged app. To re-pin
  manually:
  `node scripts/update-release-package-versions.ts $(npm view t3 dist-tags.nightly)`
  then rebuild. Upstream version bumps conflict with this pin on every sync by
  construction; since 2026-08-08 `fork-sync.yml` resolves that class automatically
  (upstream's side wins, then the pin re-stamps), so the `needs-merge-help` pill
  only appears for genuine code conflicts.

## Repo layout

- `origin` → the private backup repo (push here)
- `upstream` → the official repo (pull updates from here, never push)
