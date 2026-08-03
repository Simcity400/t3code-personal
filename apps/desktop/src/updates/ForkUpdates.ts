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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

// Personal-fork source updater. Only active when the app runs from a git
// checkout that has an `upstream` remote (see MY-FORK.md): polls upstream for
// new official commits, and applies them by merging + reinstalling +
// rebuilding in place, then asks DesktopLifecycle to relaunch. The packaged
// electron-updater flow (DesktopUpdates.ts) is untouched and mutually
// exclusive with this one — it requires isPackaged, this requires !isPackaged.

const FORK_CHECK_STARTUP_DELAY = "20 seconds";
// Matches DesktopUpdates' AUTO_UPDATE_POLL_INTERVAL so this machine surfaces a
// new nightly in the same window as officially installed apps elsewhere.
const FORK_CHECK_POLL_INTERVAL = "4 minutes";
const FORK_CHECK_TIMEOUT = Duration.minutes(3);
const FORK_APPLY_STEP_TIMEOUT = Duration.minutes(20);

const CONFLICT_MESSAGE =
  "An official change overlaps one of your customizations, so this update needs a hand. " +
  'Open Claude Code in the project folder and say "finish the upstream merge".';

const NIGHTLY_VERSION_PATTERN = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const NPM_NIGHTLY_PROBE_SCRIPT =
  "fetch('https://registry.npmjs.org/-/package/t3/dist-tags').then(function(r){return r.json()}).then(function(d){console.log(d.nightly)})";

interface ForkCheckOutcome {
  readonly commitsBehind: number;
  readonly personalCommitsBehind: number;
  readonly summary: string | null;
  readonly updateAvailable: boolean;
}

const PERSONAL_CONFLICT_MESSAGE =
  "Changes pushed from your other computer overlap this machine's edits, so this " +
  'update needs a hand. Open Claude Code in the project folder and say "finish the ' +
  'personal-changes merge".';

const ManifestVersion = Schema.Struct({ version: Schema.optional(Schema.String) });
const decodeManifestVersion = Schema.decodeEffect(Schema.fromJsonString(ManifestVersion));

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

  const readPinnedVersion = Effect.gen(function* () {
    const manifestRaw = yield* fileSystem
      .readFileString(path.join(repoRoot, "apps", "desktop", "package.json"))
      .pipe(Effect.orElseSucceed(() => "{}"));
    return yield* decodeManifestVersion(manifestRaw).pipe(
      Effect.map((manifest) => manifest.version),
      Effect.orElseSucceed(() => undefined),
    );
  });

  const performCheck: Effect.Effect<ForkUpdateState> = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    if (!state.supported || (state.status !== "idle" && state.status !== "update-available")) {
      return state;
    }
    yield* updateState((s) => ({ ...s, status: "checking" }));

    const outcome = yield* Effect.gen(function* () {
      const countAgainst = (ref: string) =>
        Effect.gen(function* () {
          const countRaw = yield* runCapture("git", ["rev-list", "--count", `HEAD..${ref}`]).pipe(
            Effect.orElseSucceed(() => "0"),
          );
          const parsed = Number.parseInt(countRaw.trim(), 10);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        });

      // Personal changes pushed from another machine (private backup remote).
      // Not release-gated: they should surface on the next poll.
      let personalCommitsBehind = 0;
      let personalSummary: string | null = null;
      const originFetchExit = yield* runExit("git", ["fetch", "origin", "--quiet"]);
      if (originFetchExit === 0) {
        personalCommitsBehind = yield* countAgainst("origin/main");
        if (personalCommitsBehind > 0) {
          personalSummary =
            (yield* runCapture("git", ["log", "-1", "--format=%s", "origin/main"]).pipe(
              Effect.orElseSucceed(() => ""),
            )).trim() || null;
        }
      }

      // Official updates are release-gated: the official app prompts when the
      // npm nightly dist-tag moves (it polls every 4 minutes), so this check
      // keys off the same event at the same cadence — machines then surface
      // the update within the same few-minute window. Upstream commits that
      // are not yet in a published nightly stay quiet; the Update cmd still
      // applies them on demand.
      const nightly = (yield* runCapture("node", ["-e", NPM_NIGHTLY_PROBE_SCRIPT]).pipe(
        Effect.orElseSucceed(() => ""),
      )).trim();
      if (originFetchExit !== 0 && !NIGHTLY_VERSION_PATTERN.test(nightly)) {
        // Both probes unreachable — treat as a transient failure and retry.
        return Option.none<ForkCheckOutcome>();
      }
      let commitsBehind = 0;
      let releaseSummary: string | null = null;
      if (NIGHTLY_VERSION_PATTERN.test(nightly)) {
        const pinned = yield* readPinnedVersion;
        if (pinned !== undefined && pinned !== nightly) {
          // A new nightly is out. Fetch upstream so the pill can say how many
          // official changes ride along; the apply flow merges and re-pins.
          releaseSummary = `nightly ${nightly} released`;
          const fetchExit = yield* runExit("git", ["fetch", "upstream", "--quiet"]);
          if (fetchExit === 0) {
            commitsBehind = yield* countAgainst("upstream/main");
            if (commitsBehind > 0) {
              releaseSummary =
                (yield* runCapture("git", ["log", "-1", "--format=%s", "upstream/main"]).pipe(
                  Effect.orElseSucceed(() => ""),
                )).trim() || releaseSummary;
            }
          }
        }
      }
      return Option.some({
        commitsBehind,
        personalCommitsBehind,
        summary: releaseSummary ?? personalSummary,
        updateAvailable: releaseSummary !== null || personalCommitsBehind > 0,
      });
    }).pipe(
      Effect.timeoutOption(FORK_CHECK_TIMEOUT),
      Effect.map(Option.flatten),
      Effect.catchCause(() => Effect.succeed(Option.none<ForkCheckOutcome>())),
    );

    const checkedAt = yield* currentIsoTimestamp;
    if (Option.isNone(outcome)) {
      // Transient failure (offline, upstream unreachable): stay quiet and let
      // the next poll retry rather than surfacing an error pill.
      yield* logForkWarning("fork update check failed; will retry on next poll");
      return yield* updateState((s) => ({ ...s, status: "idle", checkedAt }));
    }

    const { commitsBehind, personalCommitsBehind, summary, updateAvailable } = outcome.value;
    if (updateAvailable) {
      yield* logForkInfo("update available", { commitsBehind, personalCommitsBehind, summary });
    }
    return yield* updateState((s) => ({
      ...s,
      status: updateAvailable ? "update-available" : "idle",
      commitsBehind,
      personalCommitsBehind,
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
    yield* logForkInfo("applying official update");

    // Personal changes pushed from another machine come in first so the
    // upstream merge below sees the same base everywhere. A failed origin
    // fetch just skips this step — official updates still apply.
    yield* setStep("Syncing changes from your other machines…");
    if ((yield* timedExit("git", ["fetch", "origin", "--quiet"])) === 0) {
      const originMergeExit = yield* timedExit("git", ["merge", "origin/main", "--no-edit"]);
      if (originMergeExit !== 0) {
        yield* runExit("git", ["merge", "--abort"]).pipe(Effect.ignore);
        yield* logForkWarning("personal-changes merge conflicted; aborted merge");
        yield* updateState((s) => ({
          ...s,
          status: "conflict",
          step: null,
          message: PERSONAL_CONFLICT_MESSAGE,
        }));
        return false;
      }
    }

    // Official changes stay release-gated here too: merge upstream and re-pin
    // the version only when a published nightly is actually ahead of the pin.
    // A personal-changes-only apply must not smuggle in unreleased commits.
    const nightly = (yield* runCapture("node", ["-e", NPM_NIGHTLY_PROBE_SCRIPT]).pipe(
      Effect.timeoutOption(Duration.minutes(2)),
      Effect.map(Option.getOrElse(() => "")),
      Effect.orElseSucceed(() => ""),
    )).trim();
    const pinned = yield* readPinnedVersion;
    const releaseDrift =
      NIGHTLY_VERSION_PATTERN.test(nightly) && pinned !== undefined && pinned !== nightly;

    if (releaseDrift) {
      yield* setStep("Merging official changes…");
      yield* timedExit("git", ["fetch", "upstream", "--quiet"]);
      const mergeExit = yield* timedExit("git", ["merge", "upstream/main", "--no-edit"]);
      if (mergeExit !== 0) {
        yield* runExit("git", ["merge", "--abort"]).pipe(Effect.ignore);
        yield* logForkWarning("fork update merge conflicted; aborted merge");
        yield* updateState((s) => ({
          ...s,
          status: "conflict",
          step: null,
          message: CONFLICT_MESSAGE,
        }));
        return false;
      }

      // Keep the version pin in sync with the published nightly so connected
      // devices don't report version drift. Best effort.
      yield* setStep("Matching the official nightly version…");
      yield* Effect.gen(function* () {
        const stampExit = yield* runExit("node", [
          path.join(repoRoot, "scripts", "update-release-package-versions.ts"),
          nightly,
        ]);
        if (stampExit !== 0) return;
        // Exits non-zero when the pin is already current; that's fine.
        yield* runExit("git", ["commit", "-am", `chore(fork): pin nightly ${nightly}`]).pipe(
          Effect.ignore,
        );
      }).pipe(Effect.timeoutOption(Duration.minutes(2)), Effect.ignore);
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

    yield* setStep("Backing up to your private repo…");
    yield* timedExit("git", ["push", "origin", "main"]).pipe(Effect.ignore);

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
