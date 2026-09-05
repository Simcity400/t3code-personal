# My personal T3 Code

This is a private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with
personal customizations, backed up at
[Simcity400/t3code-personal](https://github.com/Simcity400/t3code-personal).

## Using it

- **Start the app**: use the "T3 Code (Nightly)" Start Menu shortcut. It points
  directly to `%LOCALAPPDATA%\Programs\t3code\T3 Code (Nightly).exe`.
- **Get updates**: pushes to main publish the personal Windows installer and iPhone update.
  Official published nightlies are checked every 15 minutes. The sync merges the exact
  release tag, records it in fork-upstream.json, and calls the desktop and mobile pipelines.
  Failed desktop publication is retried even if that nightly was already integrated.
  Both Windows x64 and ARM64 builds must pass before a release appears in the installed app.
  The updater selects the installed architecture and refuses a mismatched installer.
  Real merge conflicts stop publication and appear in the Fork Sync run; they require a
  reviewed resolution that preserves the personal features. There is no source-checkout
  updater or separate merge-help pill. See [the update architecture](docs/internals/personal-fork-updates.md).
  For the private feed, the updater reads the existing `gh` login directly; it does not
  put the GitHub token in the app or agent environment.
  Two Actions-minute savers (owner, 2026-09-04): pushes that only touch
  `*.md` files do not start a release, and the Linux "Build WSL node-pty" job is off
  unless the repository variable `FORK_WSL_PTY` is `true` — the Windows build then ships
  without the WSL terminal backend. Turn it back on with
  `gh variable set FORK_WSL_PTY --body true -R Simcity400/t3code-personal` (no commit
  needed); `gh variable delete FORK_WSL_PTY -R Simcity400/t3code-personal` turns it off.
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
`fork-release.yml` packages that exact commit.
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
  spawn CTA row, the "Waiting on …" thread state (below; the liveness registry itself,
  `ThreadBackgroundLiveness.ts`, is upstream's — the fork adds the wait view on top), and the
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
  Since the 2026-09-04 sync the mobile `/side` entry lives _inside_ upstream's
  `buildComposerSlashCommandItems`, which upstream extracted in #9348 — so an upstream
  rewrite of that builder can drop it without a conflict. `use-composer-command-menu.test.ts`
  pins the two properties that make it a fork command rather than an upstream one: it is
  listed whether or not the provider offers interaction modes, and it is not position-gated
  the way provider commands are. On the server, the fork's fork-from-parent validation in
  `ProviderService.startSession` now sits directly below upstream's instance-switch
  continuation-key check; both must survive, and only the fork's block reads
  `forkFromThreadId`.
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
  derivations the main chat uses; the parent's context meter and its server-side
  plan progress skip agent-attributed rows instead of reading a child's value as
  their own. The Agents
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
  and stamped with its agent id, never to the parent's handler); OpenCode reports a
  message's own occupancy per session, so a child's figure never reaches the parent
  either; Grok reports no token usage at all, so it has no meter to corrupt. Three upstream tests
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
  machine).
- **Local publisher and launcher scripts**: retired 2026-09-04 — GitHub builds every
  release, and the Start Menu shortcut points straight at the installed app, so
  `scripts/publish-personal-update.ts` (+ test), `Publish T3 Code Update (My Version).cmd`,
  `Launch T3 Code (My Version).cmd`/`.vbs` and `Update T3 Code (My Version).cmd` were
  deleted. `Setup T3 Code (My Version).cmd` stays: a new machine still needs it once.
  `scripts/lib/personal-*.ts` stay: `apps/mobile/app.config.ts` and
  `fork-mobile-preview.yml` read them.
- **Only the fork's own workflows**: the fork keeps fork-sync.yml, fork-release.yml
  and fork-mobile-preview.yml. Upstream-only workflows require its runners and secrets,
  so sync removes them inside the merge commit. A collision with a fork-owned workflow
  stops the run for review. The packaged updater offers complete releases; sync errors
  are reported in GitHub Actions, not through a separate source-updater pill.

- **One-line composer (web)**: retired 2026-09-03 — upstream's "collapse the resting
  composer" (#7855) collapses the desktop composer to a single line at rest and expands
  it on focus, replacing the fork's `min-h-[1lh]` on the composer `ContentEditable` in
  `apps/web/src/components/ComposerPromptEditor.tsx`. The composer is now one line only
  while unfocused on an existing thread; focused and new-thread composers use upstream's
  taller box. The mobile one-line composer (`composerEditorHeight.ts`) is unaffected and
  still ships.
- **Background tasks & "waiting on" in the Agents panel** (2026-09-03): the Agents
  right panel gained a **Waiting on** strip and a **Tasks** section beside the subagent
  roster, so a thread's background work is visible instead of buried. Tasks covers the
  work the subagent roster leaves out — background shells (`run_in_background`), Monitor
  watch loops, plan-mode bookkeeping, and a subagent's own internal shells — each with
  its command, live-ticking elapsed time, latest progress line, and result. Live work,
  failures and interrupted work stay on screen; completed and stopped tasks collapse
  behind a **Finished** disclosure that keeps their owner's name. Waiting on prints one
  line per blocked agent (`Main ← Reviewer + 1 more agent · 42m 13s`), tinted only when
  the user is the one holding it up (a pending approval or an unanswered question); an
  agent with nothing blocking it gets no line at all. Everything derives from
  the same durable thread activities as the roster, so it survives reload, resume, and
  reconnect. Web, desktop, and mobile all render it from one shared model
  (`packages/client-runtime/src/state/backgroundTasks.ts`). Two provider-side fixes came
  with it: the Claude SDK's `skip_transcript` flag now rides every task row (including a
  terminal notification that arrives with no remembered start) so ambient housekeeping
  leaves the chat transcript, and Codex's `waitingOnApproval` / `waitingOnUserInput`
  flags are no longer flattened into a bare "waiting", so a blocked child agent says
  what it is blocked on. A wait is only claimed on evidence — an open approval or
  question, a provider-named wait flag, or non-detached work while the turn is actually
  running — because Claude backgrounding and Codex's asynchronous `spawnAgent` both mean
  running work frequently blocks nobody. Detachment is read from `task_started` as well
  as the later patch: backgrounded shells and agents, and every resumed subagent, are
  registered in the background at start and never send a patch, so reading only the
  patch reported a fleet of background lanes as blocking an agent that was free.
  Workflow members are attributed to their coordinator rather than to main. Codex requests now carry the child thread that
  raised them, so a child's approval is attributed to that child instead of reading as
  the main agent being stuck. Coverage is per provider: Claude has the full task
  lifecycle; Codex is agent-level only (its protocol exposes child agents but no shells,
  monitors or workflows); Grok and OpenCode get wait states only — ACP has no task
  concept at all, and OpenCode's tool parts are foreground calls the work log already
  shows, with its `subtask` part carrying identity but no status or timestamps. The three
  gaps this shipped with were closed on 2026-09-04.

  **Task detail.** Rows now carry a shell's command line and a monitor's MCP
  `server · tool`, sourced from the call that launched the task: a background shell's
  Bash input, an `mcp__<server>__<tool>` tool name, or an `mcp_task`'s description
  (which the CLI composes as `server/tool`). The command is the shell row's label — a
  provider description humanizes the call, and a panel showing five "Running tests"
  rows names none of them. Closing this exposed a defect underneath: the
  `background_tasks_changed` reader was written against the SDK's documented
  `BackgroundTaskSummary` (`{id, type, status, command, …}`), but the CLI sends
  `{task_id, task_type, description, ambient?}` with REPLACE semantics, so every
  snapshot was discarded on a missing `summary.id` and the identity rehydration this
  feature relies on had never once run. It reads both shapes now, merges fill-if-absent
  into live entries instead of skipping them, raises the CLI's `ambient` flag (a
  superset of `skip_transcript` covering its own live-update watchers), and emits a
  status-less `task.updated` per repaired task so recovered identity reaches the client
  instead of waiting for a lifecycle row that, for a watch loop, may be hours away.
  The snapshot's REPLACE semantics also settle work whose terminal row was
  lost: a task it should have listed and did not is no longer running, and if
  its `task_notification` died with the process nothing else ever says so. Two
  guards make that safe, both forced by the CLI's own filter on this message
  (`em`/`Td` in the shipped binary), which admits only tasks that are
  `running`/`pending`, not explicitly foreground, and not observer
  `local_agent`s. Absence therefore proves nothing about a foreground task, a
  paused one (the CLI's `paused`, reported here as `idle`), or an observer —
  so reaping is confined to tasks that are background work by classification
  (which excludes every `local_agent`, observers included, since `isObserver`
  never reaches the stream) and whose last reported status was running or
  pending. And it takes TWO consecutive absences: the snapshot fires on the
  same state change that settles a task, the order of the two messages is
  specified nowhere, and one absence would otherwise mark every completing
  shell `interrupted` — a status the client's first-terminal-write-wins rule
  would then never let the real completion correct. Tasks whose `task_started`
  this session never saw are never reaped at all, which is also what keeps a
  snapshot that races ahead of a starting task harmless.

  Same round: `mcp_task`, `monitor_ws` and `auto_mode_scan` joined
  `MONITOR_TASK_TYPES` — the CLI's own background set is
  `{local_bash, monitor_mcp, monitor_ws, mcp_task}`, so all three were falling through
  the agent default and landing watch loops in the subagent roster.

  **The compacting wait.** `compacting` is a runtime session state end to end. Claude
  names compaction only on `system/status` (`session_state_changed` is
  `idle | running | requires_action` and never mentions it, verified in the shipped
  binary), and the adapter used to flatten that to a bare `waiting`. Ingestion maps the
  state to session status `running` — a compacting session is busy, not resting, and
  the composer reads that status — and persists one durable row per thread, rewritten
  on each of the two transition edges the adapter marks. Edge-marking is the point:
  `running` is republished on every heartbeat, so an unedged signal would write a row
  per heartbeat. The panel prints `Main ← Compacting context`, untinted, since no user
  action shortens it; the boundary closes the wait if a compaction ends without a
  closing status.

  **The double listing.** Task membership is one decision, taken per task id in
  `packages/client-runtime/src/state/taskSurface.ts` from the evidence on all of that
  id's rows, and read by both folds. Judging each row on its own stamp is what let a
  resumed session double-list: the thin terminal row that follows a lost identity
  carries only `taskId` + `status`, ingestion's classifier defaults a type-less row to
  `agent`, and the roster built a phantom agent beside the real background row.

  Still not possible: the SDK's richer `BackgroundTaskSummary` (its `command`,
  `server`, `tool`, `agent_type`, `name`) and `SessionCronSummary` (scheduled
  `CronCreate` / `ScheduleWakeup` / `/loop` wakeups) exist **only** in the
  `Stop` / `SubagentStop` hook payloads. There is no stream message and no control
  request that lists them — `SDKControlBackgroundTasksRequest` /
  `query.backgroundTasks()` is a mutation that backgrounds in-flight foreground tasks
  (Ctrl+B semantics), not a listing. Surfacing scheduled crons would mean registering an
  SDK `Stop` hook purely to harvest a snapshot at turn end, which puts a callback in the
  turn-end path and emits `hook_started` / `hook_response` rows into the work log for
  something the user never configured; not worth it for data that arrives only once the
  turn is already over. Cron rows are therefore not shown.

- **Working, waiting, or idle — one thread state, and you can talk to it while it
  waits** (2026-09-04): a thread used to say "Working" both while the agent was
  generating and while it was merely sitting on top of background work it had
  started, and "Monitoring" for the watch-loop case — so the one thing worth
  knowing at a glance, whether the agent is actually doing something or just
  waiting, was the thing the app would not tell you. There are now three states,
  derived in one place (`packages/shared/src/threadWorkState.ts`,
  `resolveThreadWorkState`) from durable projections, so every surface agrees and
  the answer survives reload, resume and reconnect:

  - **working** — the thread's own turn is in flight. The agent is generating or
    running a foreground tool call; a message sent now steers that turn.
  - **waiting** — the agent is producing nothing of its own. Either work it
    started is still alive (background shells, watch loops, workflows, subagents,
    anything the provider reports as a task) or the provider is compacting its
    own context. The row reads **"Waiting on _what_ · _elapsed_"**, where _what_
    is whatever the provider called the work — an agent's title, a shell's
    command line, a monitor's or workflow's name — degrading to a neutral count
    ("3 tasks", "Reviewer + 2 more agents") when there are several or the provider
    named none, and reading "context compaction" for the compaction case. No dot
    pulses: nothing of the agent's own is moving.
  - **idle** — nothing live, and the row says nothing at all.

  **You can talk to it while it waits.** With background work alive the composer
  is fully live and a message starts a real turn immediately — it is never queued
  behind background work. (Compaction is the one wait that still refuses a fresh
  turn: it reports itself as a running session precisely so the composer keeps
  steering into the turn in flight, and the message is answered when compaction
  ends. It reads as waiting because the agent is generating nothing, which is the
  question the label answers — the panel's `Main ← Compacting context` line is the
  same fact, from the same edges.) When a background result wakes the agent and it starts
  answering, that opens a turn and the thread reads `working` again; a task
  notification the agent merely _receives_ never does, so a lane reporting in
  cannot make the thread look busy. If the user sends a message while the agent is
  mid-answer to a background result, that synthetic turn is closed out and a real
  one opens rather than the message being swallowed.

  **No false "Done".** The completion alert (iPhone push and the relay card) no
  longer fires when a turn ends with work still running: the awareness ladder
  reports the run as still in flight, with the same "Waiting on …" wording, and
  fires exactly one completion when everything finally settles. The one exception
  is watch loops: a monitor can outlive every turn a thread will ever run, so
  monitor-only liveness counts as settled _for the alert_ while the UI still shows
  the thread as waiting — otherwise "Done" would be suppressed forever rather than
  delayed. Dedupe is unchanged (the relay's per-thread publish identity).

  Surfaces: the sidebar row and the in-thread banner on web/desktop, and on the
  phone both the thread list row and the floating pill above the composer. Per
  provider: Claude drives the full task lifecycle; Codex child agents
  (`collabAgent/*`) and OpenCode child sessions register as tasks and so read as
  `waiting` when only async children are alive; Grok and Antigravity report no
  tasks, so they simply never reach `waiting` — the correct reading of "nothing is
  known to be alive" rather than a special case. Server side the existing
  `ThreadBackgroundLiveness` registry (upstream's, two-valued, read by
  auto-settlement and the session reaper) keeps its shape and answers a second,
  richer question alongside it — `getThreadBackgroundWait`, surfaced as the
  fork-only `backgroundWait` field on the thread shell. One live set, two views, so
  a surface that names the wait and one that only asks "is anything alive?" cannot
  disagree. Compaction rides the same registry (`getCompactingSince` →
  `compactingSince` on the shell), fed by the same ingestion edges that persist the
  durable `session.compacting` row the panel reads, and deliberately kept out of
  the two-value field so auto-settlement and the reaper keep meaning "background
  TASKS are alive".

- **Nightly integration marker**: fork-upstream.json records the last integrated official
  release tag and its commit. Source package versions remain upstream-owned. The release
  pipeline stamps the personal nightly version only while building, avoiding four permanent
  package-version conflicts on every upstream sync.

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
