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
  `fork-mobile-preview.yml` — so no machine ever merges or pins locally. When it cannot
  finish on its own — a genuine merge conflict, or a push GitHub refuses — it stops and
  pushes the `needs-merge-help` marker branch, which the in-app pill turns into "open
  Claude Code and say: finish the upstream merge". The pill only means the sync needs a
  hand; the run log says which of those it was. Only after a release run finishes
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
- **Native subagent & workflow observability** (2026-08-01 onward): the Agents panel in
  the web app (`apps/web/src/components/AgentsPanel.tsx`, opened from `ChatView`), the
  spawn CTA row, sidebar liveness beyond the turn ("Working"/"Monitoring"), and the
  client-runtime fold behind them (`packages/client-runtime/src/state/subagentRuntime.ts`,
  ~720 fork-only lines). Server side: Claude `SendMessage` is classified as a subagent
  instruction, Codex `collabAgent/*` events carry the child's prompt and `promptId`, and
  subagent-owned traffic is attributed with `agentId` so it stays out of the parent
  transcript (`agent_id` on `projection_thread_messages`, fork migration 041). See
  `docs/user/agent-transcripts.md`.
- **Side chats** (2026-08-16): `/side [prompt]` forks the current thread into a
  provider-native side conversation — `forkedFromThreadId` / `sideChatPromotedAt` on the
  thread contracts, fork migration 042, and the `/side` command in both the web composer
  (`apps/web/src/components/ChatView.tsx`) and the mobile one
  (`apps/mobile/src/features/threads/use-composer-command-menu.ts` +
  `apps/mobile/src/state/use-thread-composer-state.ts`). See `docs/user/side-chats.md`.
- **Mobile Agents screen & durable transcripts** (2026-08-15):
  `apps/mobile/src/features/agents/` renders the same roster and transcripts on the
  phone, which is why `threadActivity.ts` re-homes nested agent rows out of the chat feed
  instead of showing them there the way upstream does.
- **Mobile composer that opens at one line** (2026-08-15): `composerEditorHeight.ts`
  measures the draft and sizes the editor to it, and `markSubmitted()` /
  `composerEditorRevision.ts` keep a post-submit clear from being overwritten by native
  events still in flight. (The WEB one-line composer was retired 2026-09-03, below.)
- **Test runs ignore the root `.env`** (2026-08-12): `apps/web/vite.config.ts` skips
  `loadRepoEnv()` when vitest is running, so tests see the same empty public config
  as upstream CI. Without this, the `.env` below leaked the Clerk CLI OAuth client
  id into `import.meta.env` and permanently failed the two "not configured" cases
  in `connectCliAuth.test.ts` on every fork machine.
- **Shared profile with the installed app**: `apps/desktop/src/main.ts` pins the
  Electron userData profile synchronously at startup, so an unpackaged build uses a real
  T3 Code profile instead of the default `%APPDATA%\Electron` one, where the Windows
  encryption key differs and every saved connection shows up as missing.
  **Which profile depends on how you launch it**: the pin keys off `VITE_DEV_SERVER_URL`,
  which `scripts/dev-runner.ts` sets, so ordinary `pnpm dev:desktop` development gets its
  own `%APPDATA%\t3code-dev` (or the legacy `T3 Code (Dev)`, when that directory already
  exists) and does **not** share logins with the installed app. Only a non-development
  unpackaged launch — no `VITE_DEV_SERVER_URL` — lands on the installed app's profile:
  `%APPDATA%\T3 Code (Alpha)` when that legacy directory exists, otherwise
  `%APPDATA%\t3code`. Either way it shares the installed app's encryption key and the
  device connections in `~\.t3\userdata`. **Caveat** for that case only: two apps
  sharing one profile must not run at the same time.
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

- **Subagent transcripts match the main chat, and each subagent has its own context
  meter** (2026-09-03): a subagent transcript used to be a thinner view of the same
  screen. On the server, Claude dropped every subagent-owned text and thinking frame,
  so an agent's transcript stayed blank until its message finished and then appeared
  in one block; its `message_delta` usage was discarded, so there was no per-agent
  context window at all. Narration now streams through the same events the parent
  uses (`content.delta` + a closing `item.completed`), stamped with `agentId`, and
  per-agent usage is emitted as `thread.token-usage.updated` with `agentId` — from
  Claude's `message_delta` and assistant snapshots, and from Codex's
  `collabAgent/tokenUsage`. On the client, the transcript selector now returns every
  row the server attributed to that agent instead of tool rows only, so the agent's
  own plan, denials, nested tasks and usage all render through the identical
  derivations the main chat uses; the parent's plan chip and context meter skip
  agent-attributed rows instead of reading a child's value as their own. The Agents
  panel shows the same `ContextWindowMeter` per subagent (transcript header, plus a
  compact `NN% ctx` on each roster row), and the iPhone app shows the same reading as a
  chip on each agent card and in the agent transcript header. (Mobile still has no
  meter for the MAIN thread — it never had one — so that surface shows context for
  subagents only.) Messages now flow both ways: a report a
  subagent sends back renders in the receiving conversation as an ordinary assistant
  message with a "From <agent>" header that opens that agent's transcript, on web and
  in the mobile feed, and it recurses for sub-subagents. Four leaks were fixed
  alongside — a subagent's TodoWrite rewriting the parent turn's plan, a child's tool
  at content-block index N evicting the parent's tool at index N, a child's
  `content_block_stop` closing the parent's assistant text block, and the end-of-turn
  sweep completing unfinished subagent tools into the parent timeline. OpenCode delegates by
  creating a child SESSION (`Session.parentID`) and the adapter already subscribes to
  the server's global event stream, so its children are supported the same way:
  registered as agents, everything they emit attributed, their own user message
  recovered as the parent's instruction, and a context meter for the thread and each
  child (OpenCode reports token counts but no window size, so those meters show
  occupancy without a percentage — identically for parent and child). Grok is
  documented in its adapter as not supportable: it speaks ACP, whose eleven
  `session/update` variants carry no subagent, child-session or parent-tool
  attribution at all.
- **The context meter measures context, not totals** (2026-09-03): a deliberate
  divergence from upstream. Upstream's `normalizeClaudeTaskProgressTokenUsage`
  (`apps/server/src/provider/Layers/ClaudeAdapter.ts`) max-merged a subagent's
  CUMULATIVE token total into the parent thread's `usedTokens` — the numerator the
  context-window meter divides by `maxTokens`. A subagent runs in its own context
  window, so a child that burned 500k tokens pinned the parent's meter at 100% of a
  200k window while the parent's own context was nearly empty. The parent's meter now
  reports only what the parent itself last reported, and each subagent's meter reports
  only its own context. Cumulative figures are untouched and still aggregate exactly
  where upstream aggregated them — they ride along as `totalProcessedTokens`,
  `toolUses` and `durationMs` (the meter's "Total processed" line), on each roster row
  as "Σ … tok" / "Σ … tools", and in the Agents panel footer as "Σ … tok" — now
  labelled with a sigma so a total is never misread as a context reading. Codex
  already kept the two apart (a child's usage is routed to `collabAgent/tokenUsage`
  and stamped with its agent id, never to the parent's handler); Grok and OpenCode
  report no token usage at all, so they have no meter to corrupt. Three upstream tests
  that asserted the merged behaviour were rewritten; expect a conflict there on the
  next upstream sync and keep the fork's version.
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
  the 37 bot merges never did). `fork-sync.yml` now keeps them deleted by itself: it
  merges with `--no-commit`, resolves a conflict in a non-allowlisted workflow to
  "delete it", deletes any non-allowlisted workflow a clean merge brought in, and only
  then commits — so the commit it creates never touches a workflow at all, rather than
  adding one and deleting it again in a follow-up. A guard then aborts the run before
  any push if the pushed range's diff still shows **any** workflow path, the fork's own
  three included — raising the `needs-merge-help` pill as it goes, because that guard
  firing is a case only a human can clear, and every later run would stop at it too.
  Still unknown, and unknowable without attempting a push: whether GitHub judges a push
  by its net diff or by each commit in it — the fork's own history never exercised
  either, since no bot merge has ever had a workflow-touching commit in its range. So
  the job is written to be correct under both readings rather than betting on one, and
  when a push is refused anyway it raises the marker from the commit `origin/main`
  already holds — a ref create that introduces no new commit, the weakest push there
  is. Local scenarios drive the shipped steps — extracted verbatim from this YAML —
  against throwaway bare repos whose `pre-receive` hook models each reading. The
  end-to-end pair is the one that matters, because it is the only reachable strict
  case: upstream touches a workflow, the merge step deletes it so the net diff is
  empty and the guard passes, yet the pushed range still introduces a
  workflow-touching commit. A per-commit remote refuses that push and the marker
  lands on the pre-push `origin/main`; a net-diff remote accepts it and no marker
  appears. Only a remote that refuses even a no-op ref create leaves no pill, and
  the run says so explicitly.

  Both steps also carry an `EXIT` trap, because the guarantee has to hold for
  failures nobody predicted, not just the ones with a handler. Under `set -e` a
  single unexpected error used to end the run with main unpushed, no marker and
  nothing but a red check — the exact silence this pipeline exists to remove.
  Review found one: a submodule gitlink committed at
  `.github/workflows/<name>.yml` checks out as a _directory_, so the `rm -f` that
  drops upstream-only workflows failed with "Is a directory" and killed the step
  before the guard. The drop now uses `rm -rf`, and the trap turns any remaining
  surprise into the same visible outcome as a conflict.

  What is **not** covered locally: a literal tab in a workflow filename. Git on
  Windows rejects one at both layers — the filesystem maps it into the private-use
  plane, and `git update-index --cacheinfo` answers `error: Invalid path` — so no
  scenario here can build that case, and an earlier claim that one did was wrong.
  Coverage does not actually depend on it: the bug being fixed is git's C-quoting of
  unusual paths in newline-delimited output, and a non-ASCII byte is C-quoted by the
  same mechanism, which the `déploiement.yml` scenarios do exercise.
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
  never appears for that class. It still covers everything else that stops the sync:
  a genuine code conflict, or a push GitHub refuses.

## Notes on upstream files kept as-is

`docs/` (notably `docs/internals/ci.md` and `docs/operations/release.md`),
`infra/relay/README.md` and `packaging/aur/README.md` still describe upstream's CI and
point at `.github/workflows/ci.yml`, `release.yml`, `deploy-relay.yml` and
`publish-aur.yml`. Those workflows do not exist on this fork (see the allowlist above).
They are left untouched on purpose: they document the official project, and editing them
would put a permanent merge conflict in the path of every upstream docs change. Read them
as upstream's documentation, not as a description of this fork.

## Repo layout

- `origin` → the private backup repo (push here)
- `upstream` → the official repo (pull updates from here, never push)
