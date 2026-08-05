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

// fork-sync.yml pushes this marker branch when the official changes conflict
// with fork customizations, and deletes it once a resolved main is pushed.
const SYNC_CONFLICT_REF = "origin/needs-merge-help";

const CONFLICT_MESSAGE =
  "An official change overlaps one of your customizations, so GitHub needs a hand. " +
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
  personalCommitsBehind: 0,
  latestSummary: null,
  step: null,
  message: null,
  checkedAt: null,
};

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const repoRoot = environment.rootDir;
  const stateRef = yield* Ref.make<ForkUpdateState>(INITIAL_STATE);

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.FORK_UPDATE_STATE_CHANNEL, state)),
  );

  const updateState = (
    f: (state: ForkUpdateState) => ForkUpdateState,
  ): Effect.Effect<ForkUpdateState> =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return Ref.set(stateRef, nextState).pipe(Effect.andThen(emitState), Effect.as(nextState));
      }),
    );

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
    if (
      !state.supported ||
      (state.status !== "idle" &&
        state.status !== "update-available" &&
        state.status !== "conflict")
    ) {
      return state;
    }
    yield* updateState((s) => ({ ...s, status: "checking" }));

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
      return yield* updateState((s) => ({ ...s, status: "idle", checkedAt }));
    }

    const { commitsBehind, syncConflict, summary, updateAvailable } = outcome.value;
    if (syncConflict) {
      // GitHub's sync hit an upstream conflict; surface it until the marker
      // branch disappears (fork-sync.yml deletes it after a resolved push).
      yield* logForkWarning("fork sync conflict marker present on origin");
      return yield* updateState((s) => ({
        ...s,
        status: "conflict",
        commitsBehind,
        personalCommitsBehind: 0,
        latestSummary: summary,
        checkedAt,
        message: CONFLICT_MESSAGE,
      }));
    }
    if (updateAvailable) {
      yield* logForkInfo("update available", { commitsBehind, summary });
    }
    return yield* updateState((s) => ({
      ...s,
      status: updateAvailable ? "update-available" : "idle",
      commitsBehind,
      personalCommitsBehind: 0,
      latestSummary: summary,
      checkedAt,
      message: null,
    }));
  }).pipe(Effect.withSpan("desktop.forkUpdates.check"));

  const beginApply: Effect.Effect<boolean> = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (!state.supported || state.status !== "update-available") return false;
    yield* updateState((s) => ({
      ...s,
      status: "updating",
      step: "Preparing update…",
      message: null,
    }));
    return true;
  });

  const setStep = (step: string) => updateState((s) => ({ ...s, step }));

  const failApply = (message: string) =>
    updateState((s) => ({ ...s, status: "error", step: null, message })).pipe(Effect.as(false));

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
    // never merges them: they're preserved on an origin backup branch (and a
    // local branch as a fallback), then the machine snaps to origin/main.
    const dirty =
      (yield* runCapture("git", ["status", "--porcelain"]).pipe(
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
        yield* timedExit("git", ["add", "-A"]).pipe(Effect.ignore);
        yield* timedExit("git", [
          "commit",
          "-m",
          "backup: local changes before matching GitHub",
        ]).pipe(Effect.ignore);
      }
      // Local branch first so the work survives even when the push fails.
      yield* timedExit("git", ["branch", "--force", backupName]).pipe(Effect.ignore);
      yield* timedExit("git", ["push", "origin", `HEAD:refs/heads/${backupName}`]).pipe(
        Effect.ignore,
      );
      yield* logForkInfo("backed up local changes before reset", { backupName, commitsAhead });
      if ((yield* timedExit("git", ["reset", "--hard", "origin/main"])) !== 0) {
        return yield* failApply(
          "Couldn't match this machine to GitHub. Run the Update file in the project folder to see details.",
        );
      }
    } else if ((yield* timedExit("git", ["merge", "--ff-only", "origin/main"])) !== 0) {
      return yield* failApply(
        "Couldn't match this machine to GitHub. Run the Update file in the project folder to see details.",
      );
    }

    yield* setStep("Installing dependencies…");
    const install = yield* resolveSpawnCommand("pnpm", ["install"]);
    const installExit = yield* timedExit(install.command, install.args, {
      shell: install.shell,
    });
    if (installExit !== 0) {
      return yield* failApply(
        "Installing dependencies failed. Run the Update file in the project folder to see details.",
      );
    }

    yield* setStep("Rebuilding the app…");
    const build = yield* resolveSpawnCommand("pnpm", ["run", "build:desktop"]);
    const buildExit = yield* timedExit(build.command, build.args, { shell: build.shell });
    if (buildExit !== 0) {
      return yield* failApply(
        "Rebuilding the app failed. Run the Update file in the project folder to see details.",
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
          failApply("The update hit an unexpected error. Your current version keeps working."),
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
    runApply,
  });
});

export const layer = Layer.effect(ForkUpdates, make);
