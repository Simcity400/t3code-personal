import { type ForkUpdateState } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

// Personal-fork source updater. Only active when the app runs from a git
// checkout that has an `upstream` remote (see MY-FORK.md). GitHub is the
// single source of truth: a scheduled workflow (fork-sync.yml) merges
// official changes and pins versions on origin/main, and this updater only
// ever downloads that branch — it never merges or pins locally, so two
// machines can never invent conflicting history. Stray local commits are
// backed up to an origin `backup/…` branch, then the machine snaps to match
// origin/main. The packaged electron-updater flow (DesktopUpdates.ts) is
// untouched and mutually exclusive with this one — it requires isPackaged,
// this requires !isPackaged.

const FORK_CHECK_STARTUP_DELAY = "20 seconds";
// Matches DesktopUpdates' AUTO_UPDATE_POLL_INTERVAL so this machine surfaces a
// new nightly in the same window as officially installed apps elsewhere.
// origin/main moves within ~2 hours of a nightly (fork-sync.yml's cadence).
const FORK_CHECK_POLL_INTERVAL = "4 minutes";
const FORK_CHECK_TIMEOUT = Duration.minutes(3);
const FORK_APPLY_STEP_TIMEOUT = Duration.minutes(20);

// fork-sync.yml pushes this marker branch whenever a sync stops and needs a
// human — an upstream change that conflicts with a fork customization, or a
// push GitHub refuses — and deletes it once a resolved main is pushed. The
// branch carries no reason, so the message below must not claim one.
const SYNC_CONFLICT_REF = "origin/needs-merge-help";

const CONFLICT_MESSAGE =
  "Syncing the official changes stopped and needs a hand. " +
  'Open Claude Code in the project folder on any computer and say "finish the upstream merge".';

interface ForkCheckOutcome {
  readonly commitsBehind: number;
  readonly syncConflict: boolean;
  readonly summary: string | null;
  readonly updateAvailable: boolean;
}

export class ForkUpdates extends Context.Service<
  ForkUpdates,
  {
    readonly getState: Effect.Effect<ForkUpdateState>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly check: Effect.Effect<ForkUpdateState>;
    readonly beginApply: Effect.Effect<boolean>;
    readonly runApply: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/updates/ForkUpdates") {}

const {
  logInfo: logForkInfo,
  logWarning: logForkWarning,
  logError: logForkError,
} = DesktopObservability.makeComponentLogger("fork-updater");

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const INITIAL_STATE: ForkUpdateState = {
  supported: false,
  status: "idle",
  commitsBehind: 0,
  latestSummary: null,
  step: null,
  message: null,
  checkedAt: null,
};

const STATUSES: ReadonlyArray<ForkUpdateState["status"]> = [
  "idle",
  "checking",
  "update-available",
  "updating",
  "restarting",
  "conflict",
  "error",
];

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const repoRoot = environment.rootDir;
  const stateRef = yield* Ref.make<ForkUpdateState>(INITIAL_STATE);

  const sendState = (state: ForkUpdateState) =>
    electronWindow.sendAll(IpcChannels.FORK_UPDATE_STATE_CHANNEL, state);

  // Compare-and-set state transition: writes only when the current status is
  // one of `expected`, reports whether it wrote, and emits exactly the state
  // this call touched — never a newer one read back after the fact. Without
  // the CAS, a check that passed its guard before an apply started would
  // clobber "updating" on its way out and admit a second apply.
  const transitionState = (
    expected: ReadonlyArray<ForkUpdateState["status"]>,
    patch: (state: ForkUpdateState) => ForkUpdateState,
  ): Effect.Effect<{ readonly written: boolean; readonly state: ForkUpdateState }> =>
    Ref.modify(
      stateRef,
      (
        current,
      ): readonly [
        { readonly written: boolean; readonly state: ForkUpdateState },
        ForkUpdateState,
      ] => {
        if (!expected.includes(current.status)) {
          return [{ written: false, state: current }, current];
        }
        const next = patch(current);
        return [{ written: true, state: next }, next];
      },
    ).pipe(Effect.tap((result) => sendState(result.state)));

  // Unconditional write for fibers that already hold the apply mutex.
  const updateState = (
    f: (state: ForkUpdateState) => ForkUpdateState,
  ): Effect.Effect<ForkUpdateState> =>
    transitionState([...STATUSES], f).pipe(Effect.map((result) => result.state));

  // Exit code of a command run at the repo root. Output is discarded — the
  // repo working tree is the source of truth, not the command output.
  const runExit = (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly shell?: boolean | string },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd: repoRoot,
            shell: options?.shell ?? false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            killSignal: "SIGTERM",
            forceKillAfter: Duration.seconds(5),
          }),
        );
        return yield* handle.exitCode;
      }),
    );

  const runCapture = (command: string, args: ReadonlyArray<string>) =>
    spawner.string(
      ChildProcess.make(command, args, {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(5),
      }),
    );

  const performCheck: Effect.Effect<ForkUpdateState> = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    // Deliberately NOT re-checkable from "error": a post-reset failure has
    // HEAD at origin/main, so a check would see zero commits behind and
    // clear the error without finishing the update. Recovery from "error" is
    // the pill's retry button, which resumes the apply itself.
    if (
      !state.supported ||
      (state.status !== "idle" &&
        state.status !== "update-available" &&
        state.status !== "conflict")
    ) {
      return state;
    }
    // CAS on the way in: if an apply flipped to "updating" after the guard
    // above read the ref, this check must not clobber it — and two checks
    // racing the same eligible state must not both proceed.
    const attempt = yield* transitionState(["idle", "update-available", "conflict"], (s) => ({
      ...s,
      status: "checking",
    }));
    if (!attempt.written) {
      return attempt.state;
    }

    const outcome = yield* Effect.gen(function* () {
      // GitHub is authoritative: the only question is whether origin/main has
      // moved past this machine. fork-sync.yml release-gates what lands on
      // origin/main, so no npm or upstream probing happens here. --prune so a
      // deleted conflict marker disappears from the local view too.
      const originFetchExit = yield* runExit("git", ["fetch", "origin", "--prune", "--quiet"]);
      if (originFetchExit !== 0) {
        return Option.none<ForkCheckOutcome>();
      }

      const countRaw = yield* runCapture("git", ["rev-list", "--count", "HEAD..origin/main"]).pipe(
        Effect.orElseSucceed(() => "0"),
      );
      const parsed = Number.parseInt(countRaw.trim(), 10);
      const commitsBehind = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

      let summary: string | null = null;
      if (commitsBehind > 0) {
        summary =
          (yield* runCapture("git", ["log", "-1", "--format=%s", "origin/main"]).pipe(
            Effect.orElseSucceed(() => ""),
          )).trim() || null;
      }

      const syncConflict =
        (yield* runExit("git", ["rev-parse", "--verify", "--quiet", SYNC_CONFLICT_REF])) === 0;

      return Option.some({
        commitsBehind,
        syncConflict,
        summary,
        updateAvailable: commitsBehind > 0,
      });
    }).pipe(
      Effect.timeoutOption(FORK_CHECK_TIMEOUT),
      Effect.map(Option.flatten),
      Effect.catchCause(() => Effect.succeed(Option.none<ForkCheckOutcome>())),
    );

    const checkedAt = yield* currentIsoTimestamp;
    if (Option.isNone(outcome)) {
      // Transient failure (offline, origin unreachable): stay quiet and let
      // the next poll retry rather than surfacing an error pill.
      yield* logForkWarning("fork update check failed; will retry on next poll");
      return yield* transitionState(["checking"], (s) => ({
        ...s,
        status: "idle",
        checkedAt,
      })).pipe(Effect.map((result) => result.state));
    }

    const { commitsBehind, syncConflict, summary, updateAvailable } = outcome.value;
    if (syncConflict) {
      // GitHub's sync hit an upstream conflict; surface it until the marker
      // branch disappears (fork-sync.yml deletes it after a resolved push).
      yield* logForkWarning("fork sync conflict marker present on origin");
      return yield* transitionState(["checking"], (s) => ({
        ...s,
        status: "conflict",
        commitsBehind,
        latestSummary: summary,
        checkedAt,
        message: CONFLICT_MESSAGE,
      })).pipe(Effect.map((result) => result.state));
    }
    if (updateAvailable) {
      yield* logForkInfo("update available", { commitsBehind, summary });
    }
    return yield* transitionState(["checking"], (s) => ({
      ...s,
      status: updateAvailable ? "update-available" : "idle",
      commitsBehind,
      latestSummary: summary,
      checkedAt,
      message: null,
    })).pipe(Effect.map((result) => result.state));
  }).pipe(Effect.withSpan("desktop.forkUpdates.check"));

  // Serializes apply pipelines: each IPC invoke detaches its own fiber, so
  // without this a double-activate would run two concurrent git/pnpm flows.
  const applyMutex = Semaphore.makeUnsafe(1);

  // Check-and-set in one atomic operation so two rapid invokes can never both
  // observe an applicable state and fork concurrent applies. "error" is
  // accepted: runApply is idempotent once the tree matches origin/main (the
  // backup is skipped when clean and the ff-only merge no-ops), so retrying a
  // failed install/build finishes the update instead of waiting for origin to
  // move again.
  const beginApply: Effect.Effect<boolean> = transitionState(
    ["update-available", "error"],
    (s) => ({ ...s, status: "updating", step: "Preparing update…", message: null }),
  ).pipe(Effect.map((result) => result.written));

  const setStep = (step: string) => updateState((s) => ({ ...s, step }));

  // Survives restarts: a failure AFTER the tree snapped to origin/main leaves
  // zero commits behind, so no check will ever re-offer the update. The
  // marker (inside .git, so it never dirties status) re-arms the error pill
  // on the next launch until a retry finishes the install/build.
  const resumeMarkerPath = path.join(repoRoot, ".git", "fork-update-resume");
  const writeResumeMarker = fileSystem
    .writeFile(resumeMarkerPath, new TextEncoder().encode("resume"))
    .pipe(Effect.ignore);
  const clearResumeMarker = fileSystem.remove(resumeMarkerPath).pipe(Effect.ignore);

  const failApply = (message: string, options?: { readonly resumable?: boolean }) =>
    // The marker is only ever cleared by a successful apply — a later failure
    // (even a fetch blip during a retry) must not un-arm recovery for a tree
    // that may already have snapped to origin/main.
    (options?.resumable ? writeResumeMarker : Effect.void).pipe(
      Effect.andThen(updateState((s) => ({ ...s, status: "error", step: null, message }))),
      Effect.as(false),
    );

  const timedExit = (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly shell?: boolean | string },
  ) =>
    runExit(command, args, options).pipe(
      Effect.timeoutOption(FORK_APPLY_STEP_TIMEOUT),
      Effect.map(Option.getOrElse(() => -1)),
    );

  const runApply: Effect.Effect<boolean> = Effect.gen(function* () {
    yield* logForkInfo("matching this machine to origin/main");

    yield* setStep("Getting the latest from GitHub…");
    if ((yield* timedExit("git", ["fetch", "origin", "--prune", "--quiet"])) !== 0) {
      return yield* failApply(
        "Couldn't reach GitHub. Check the internet connection and press update again.",
      );
    }

    // GitHub is authoritative. A machine with stray local commits or edits
    // never merges them: tracked modifications are preserved on an origin
    // backup branch (and a local branch as a fallback), then the machine
    // snaps to origin/main. Untracked files are deliberately excluded from
    // the backup — they are private to this machine, and `reset --hard`
    // leaves them in place anyway.
    const dirty =
      (yield* runCapture("git", ["status", "--porcelain", "--untracked-files=no"]).pipe(
        Effect.orElseSucceed(() => ""),
      )).trim() !== "";
    const aheadRaw = yield* runCapture("git", ["rev-list", "--count", "origin/main..HEAD"]).pipe(
      Effect.orElseSucceed(() => "0"),
    );
    const commitsAhead = Number.parseInt(aheadRaw.trim(), 10) || 0;

    if (dirty || commitsAhead > 0) {
      yield* setStep("Backing up this machine's local changes…");
      const backupName = `backup/${(yield* currentIsoTimestamp).replaceAll(":", "-")}`;
      if (dirty) {
        // Stage tracked modifications only (`-u`, never `-A`) so untracked
        // local files are never committed or uploaded.
        const addExit = yield* timedExit("git", ["add", "-u"]);
        if (addExit !== 0) {
          return yield* failApply(
            "Couldn't stage your local changes for backup, so nothing was changed. Commit or stash them manually, then press update again.",
          );
        }
        const commitExit = yield* timedExit("git", [
          "commit",
          "-m",
          "backup: local changes before matching GitHub",
        ]);
        if (commitExit !== 0) {
          return yield* failApply(
            "Couldn't commit a backup of your local changes. Your edits are untouched in the working tree. Check that git has a user name and email configured, then press update again.",
          );
        }
      }
      // Local branch first so the work survives even when the push fails.
      // Both steps must succeed before anything destructive happens: the
      // reset below is only safe once the backup ref exists locally.
      const branchExit = yield* timedExit("git", ["branch", "--force", backupName]);
      if (branchExit !== 0) {
        return yield* failApply(
          "Couldn't create the local backup branch, so the update was stopped before any files changed. Open a terminal in the project folder and run git status for details.",
        );
      }
      yield* timedExit("git", ["push", "origin", `HEAD:refs/heads/${backupName}`]).pipe(
        Effect.ignore,
      );
      yield* logForkInfo("backed up local changes before reset", { backupName, commitsAhead });
      if ((yield* timedExit("git", ["reset", "--hard", "origin/main"])) !== 0) {
        return yield* failApply(
          `Couldn't match this machine to GitHub. Your local changes are safe on the "${backupName}" branch. Try again, or open a terminal in the project folder and run git status for details.`,
        );
      }
    } else if ((yield* timedExit("git", ["merge", "--ff-only", "origin/main"])) !== 0) {
      return yield* failApply(
        "Couldn't fast-forward to GitHub's latest. Try again, or open a terminal in the project folder and run git status for details.",
      );
    }

    yield* setStep("Installing dependencies…");
    const install = yield* resolveSpawnCommand("pnpm", ["install"]);
    const installExit = yield* timedExit(install.command, install.args, {
      shell: install.shell,
    });
    if (installExit !== 0) {
      return yield* failApply(
        "Installing dependencies failed. The source is updated but the app wasn't rebuilt — press update to try again.",
        { resumable: true },
      );
    }

    yield* setStep("Rebuilding the app…");
    const build = yield* resolveSpawnCommand("pnpm", ["run", "build:desktop"]);
    const buildExit = yield* timedExit(build.command, build.args, { shell: build.shell });
    if (buildExit !== 0) {
      return yield* failApply(
        "Rebuilding the app failed. The source is updated but the app wasn't rebuilt — press update to try again.",
        { resumable: true },
      );
    }

    // Load the freshly built backend bundle once so Windows Defender's
    // first-open scan of the thousands of files rewritten by install+build
    // happens here, while the user is already waiting on the update, instead
    // of adding a minute-plus stall to the next app launch. Best effort.
    yield* setStep("Warming up the new build…");
    const warmup = yield* resolveSpawnCommand("node", [
      path.join(repoRoot, "apps/server/dist/bin.mjs"),
      "--help",
    ]);
    yield* timedExit(warmup.command, warmup.args, { shell: warmup.shell }).pipe(Effect.ignore);

    yield* logForkInfo("official update applied; restarting");
    yield* clearResumeMarker;
    yield* updateState((s) => ({
      ...s,
      status: "restarting",
      step: null,
      commitsBehind: 0,
      latestSummary: null,
    }));
    return true;
  }).pipe(
    Effect.catchCause((cause) =>
      logForkError("fork update apply failed", { cause: String(cause) }).pipe(
        Effect.andThen(
          failApply("The update hit an unexpected error. Your current version keeps working.", {
            resumable: true,
          }),
        ),
      ),
    ),
    Effect.withSpan("desktop.forkUpdates.apply"),
  );

  const configure: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    if (environment.isPackaged) return;
    const hasGitDir = yield* fileSystem
      .exists(path.join(repoRoot, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasGitDir) return;
    const hasUpstream = yield* runExit("git", ["remote", "get-url", "upstream"]).pipe(
      Effect.map((exit) => exit === 0),
      Effect.timeoutOption(Duration.seconds(30)),
      Effect.map(Option.getOrElse(() => false)),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!hasUpstream) return;

    yield* logForkInfo("fork updater enabled", { repoRoot });
    yield* updateState((s) => ({ ...s, supported: true }));

    // A previous session's install/build may have failed after the tree
    // snapped to origin/main; no check will ever re-offer that update, so
    // re-arm the resumable error pill from the marker.
    const hasResumeMarker = yield* fileSystem
      .exists(resumeMarkerPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (hasResumeMarker) {
      yield* logForkWarning("resuming an unfinished fork update from a previous session");
      yield* transitionState(STATUSES, (s) => ({
        ...s,
        status: "error",
        step: null,
        message:
          "The last update didn't finish installing. Press update to finish it — this is safe to retry.",
      }));
    }

    yield* Effect.sleep(FORK_CHECK_STARTUP_DELAY).pipe(
      Effect.andThen(performCheck),
      Effect.catchCause(() => logForkWarning("fork update startup check failed")),
      Effect.forkScoped,
    );
    yield* Effect.sleep(FORK_CHECK_POLL_INTERVAL).pipe(
      Effect.andThen(performCheck),
      Effect.forever,
      Effect.catchCause(() => logForkWarning("fork update poller stopped unexpectedly")),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.forkUpdates.configure"));

  return ForkUpdates.of({
    getState: Ref.get(stateRef),
    configure,
    check: performCheck,
    beginApply,
    runApply: applyMutex.withPermit(runApply),
  });
});

export const layer = Layer.effect(ForkUpdates, make);
