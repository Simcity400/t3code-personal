#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off -- This standalone scheduled sync must run before workspace dependencies are installed.

// Local replacement for .github/workflows/fork-sync.yml, which cannot run while
// Actions billing is blocked on the fork account. Windows Task Scheduler calls
// this every two hours (see scripts/register-local-fork-sync.cmd); it compares
// the npm `t3` nightly dist-tag with the version pinned on origin/main, merges
// upstream/main when they differ (auto-resolving the four version-pinned
// manifests exactly like the workflow did), re-pins, pushes, and then runs the
// local publisher.
//
// Non-negotiable safety property: this script never discards work. It only ever
// runs additive git commands (fetch/merge/commit/push) plus `git merge --abort`
// on its own failed merge. It never resets, stashes, cleans, or force-checks-out
// the working tree, and it refuses to do anything at all unless the tracked tree
// is clean, the branch is main, and main is either equal to origin/main, strictly
// behind it (fast-forward only), or ahead by exactly the unpushed commits a
// previous run of this script recorded.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const MARKER_BRANCH = "needs-merge-help";
export const NPM_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/t3/dist-tags";
export const UPSTREAM_REMOTE = "upstream";
export const ORIGIN_REMOTE = "origin";

/** The four manifests the fork pins to the published npm nightly. */
export const PINNED_PACKAGE_FILES = [
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

/** Gitignored (`.logs/`) so the sync never dirties the tracked tree it guards. */
export const LOG_RELATIVE_PATH = NodePath.join(".logs", "local-fork-sync.log");
export const LOCK_DIR_RELATIVE_PATH = NodePath.join(".logs", "local-fork-sync.lock.d");
export const PENDING_PUSH_RELATIVE_PATH = NodePath.join(".logs", "local-fork-sync-pending-push");
export const RUN_HEADER_PREFIX = "=== local-fork-sync run";

const MAX_LOGGED_RUNS = 20;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
/**
 * Only a recycled pid or a wedged process can reach this; an honest run is
 * minutes long, and git/publisher calls carry their own timeouts below.
 */
const STALE_LOCK_MS = 7 * 24 * 60 * 60 * 1000;
/** An unreadable entry is assumed to be a half-written one this recently. */
const LOCK_ENTRY_GRACE_MS = 60_000;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const PUBLISH_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const NIGHTLY_FETCH_TIMEOUT_MS = 20_000;
const NIGHTLY_FETCH_ATTEMPTS = 2;

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ForkSyncDependencies {
  /** Runs git and reports the result instead of throwing, so every branch is explicit. */
  readonly git: (args: ReadonlyArray<string>) => CommandResult;
  readonly readPinnedManifest: (relativePath: string) => string;
  readonly writePinnedManifest: (relativePath: string, contents: string) => void;
  readonly fetchNightlyVersion: () => Promise<string | undefined>;
  readonly log: (message: string) => void;
  /** Runs the local publisher; resolves with its exit code. */
  readonly publish: () => Promise<number>;
  /** HEAD this script committed but could not push last time, if any. */
  readonly readPendingPushSha: () => string | undefined;
  readonly writePendingPushSha: (sha: string | undefined) => void;
}

export type ForkSyncOutcome = "up-to-date" | "blocked" | "conflict" | "failed" | "published";

export interface ForkSyncResult {
  readonly outcome: ForkSyncOutcome;
  readonly exitCode: number;
}

export interface ForkSyncGateDecision {
  readonly proceed: boolean;
  readonly resolved: boolean;
  readonly reason: string;
}

export type LocalMainState = "in-sync" | "behind" | "resumable-ahead" | "diverged";

export interface LockRecord {
  readonly host: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
  /**
   * Set when a run could not prove it terminated everything it started. A
   * sticky entry is never retired on the strength of a dead pid, because the
   * thing still running is not that pid.
   */
  readonly sticky: boolean;
}

export interface LockCheckInput {
  readonly host: string;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly maxAgeMs?: number | undefined;
  readonly now: number;
}

export interface LockAcquisition {
  readonly acquired: boolean;
  readonly blockedBy: string | undefined;
  /**
   * "held" is an ordinary overlap and a fine no-op; "error" means the lock
   * directory could not be inspected or cleaned, which must not be reported to
   * Task Scheduler as a successful run.
   */
  readonly blockedReason: "held" | "error" | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseNightlyDistTag(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const nightly = (payload as Record<string, unknown>).nightly;
  if (typeof nightly !== "string") return undefined;
  const trimmed = nightly.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readManifestVersion(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string") return undefined;
  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Mirrors the workflow gate: sync when the published nightly moved past the
 * pinned version, or whenever a conflict marker is still waiting to be cleared.
 */
export function decideForkSyncGate(input: {
  readonly markerPresent: boolean;
  readonly nightly: string | undefined;
  readonly pinned: string | undefined;
}): ForkSyncGateDecision {
  const summary = `npm nightly: ${input.nightly ?? "unknown"} | pinned: ${
    input.pinned ?? "unknown"
  } | conflict marker: ${input.markerPresent ? MARKER_BRANCH : "none"}`;
  // The workflow's gate is "version differs OR marker present", and it skips the
  // pin when no nightly resolved. A marker therefore has to open the gate on its
  // own, or an npm outage would keep the in-app pill up after the merge is done.
  if (input.markerPresent) {
    return { proceed: true, resolved: true, reason: `${summary} - clearing the conflict marker.` };
  }
  if (input.nightly === undefined) {
    return {
      proceed: false,
      resolved: false,
      reason: `${summary} - could not resolve the npm nightly dist-tag for t3.`,
    };
  }
  if (input.pinned === undefined) {
    return {
      proceed: false,
      resolved: false,
      reason: `${summary} - could not read the pinned version from ${ORIGIN_REMOTE}/main:${PINNED_PACKAGE_FILES[0]}.`,
    };
  }
  if (input.nightly !== input.pinned) {
    return { proceed: true, resolved: true, reason: `${summary} - a new official nightly is out.` };
  }
  return { proceed: false, resolved: true, reason: `${summary} - nothing to do.` };
}

/**
 * `git log --first-parent origin/main..HEAD` subjects that this script itself
 * can produce. Anything else means the checkout carries work we must not push.
 */
export function isForkSyncCommitSubject(subject: string): boolean {
  return (
    /^Merge remote-tracking branch '[^']+' into main$/u.test(subject) ||
    /^Merge remote-tracking branch '[^']+'$/u.test(subject) ||
    /^Merge branch '[^']+' into main$/u.test(subject) ||
    /^chore\(fork\): pin nightly \S+$/u.test(subject)
  );
}

/**
 * Local main may only be ahead of origin/main when THIS script made those
 * commits and failed to push them (the pending-push record is written on that
 * failure). Matching commit subjects alone is not enough: a human or another
 * agent finishing the same upstream merge by hand produces identical subjects,
 * and pushing their in-progress work would be adopting someone else's commits.
 */
export function classifyLocalMain(input: {
  readonly aheadSubjects: ReadonlyArray<string>;
  readonly headIsAncestor: boolean;
  readonly headSha: string;
  readonly originIsAncestor: boolean;
  readonly originSha: string;
  readonly pendingPushSha: string | undefined;
}): LocalMainState {
  if (input.headSha.length === 0 || input.originSha.length === 0) return "diverged";
  if (input.headSha === input.originSha) return "in-sync";
  // Another machine (or a hand-resolved merge) pushed main; this checkout only
  // needs the fast-forward GitHub used to hand out. `merge --ff-only` cannot
  // rewrite or drop anything, and the tracked tree is already known clean.
  if (input.headIsAncestor) return "behind";
  if (!input.originIsAncestor) return "diverged";
  if (input.aheadSubjects.length === 0) return "diverged";
  if (input.pendingPushSha !== input.headSha) return "diverged";
  return input.aheadSubjects.every(isForkSyncCommitSubject) ? "resumable-ahead" : "diverged";
}

export function describePreconditionFailures(input: {
  readonly branch: string;
  readonly localMain: LocalMainState;
  readonly trackedStatus: string;
}): ReadonlyArray<string> {
  const failures: Array<string> = [];
  if (input.branch !== "main") {
    failures.push(
      `Checkout is on '${input.branch || "detached HEAD"}', not main. Nothing was changed.`,
    );
  }
  if (input.trackedStatus.trim().length > 0) {
    failures.push(
      "Tracked files are modified. Commit or restore them yourself; this sync never stashes or resets. Nothing was changed.",
    );
  }
  if (input.localMain === "diverged") {
    failures.push(
      `Local main does not match ${ORIGIN_REMOTE}/main and carries commits this sync did not make. Push or reconcile them yourself. Nothing was changed.`,
    );
  }
  return failures;
}

export type MergeConflictKind = "none" | "pin-only" | "genuine";

export function classifyMergeConflicts(conflictOutput: string): MergeConflictKind {
  const conflicts = conflictOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (conflicts.length === 0) return "none";
  const pinned = new Set<string>(PINNED_PACKAGE_FILES);
  return conflicts.every((file) => pinned.has(file)) ? "pin-only" : "genuine";
}

/**
 * Re-stamps `version` and returns the new file text, or undefined when the
 * manifest is already pinned. Same 2-space pretty JSON the workflow and
 * scripts/update-release-package-versions.ts write.
 */
export function pinManifestText(text: string, version: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error instanceof Error ? error.message : ""}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Manifest is not a JSON object.");
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.version === version) return undefined;
  return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
}

export function formatLogLine(timestamp: string, message: string): string {
  return `[${timestamp}] ${message}`;
}

/**
 * Keeps the log bounded to the last `maxRuns` run blocks AND `maxBytes` bytes.
 * Run blocks start with RUN_HEADER_PREFIX; anything before the first header is
 * pre-rotation noise and is dropped with the oldest block. A single run whose
 * own output blows the byte budget (the publisher redirects a verbose Electron
 * build into this file) is truncated to its tail, so the ceiling really holds.
 */
export function trimLogRuns(content: string, maxRuns: number, maxBytes: number): string {
  if (content.length === 0) return content;
  const lines = content.split("\n");
  const headerIndexes: Array<number> = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith(RUN_HEADER_PREFIX)) headerIndexes.push(index);
  }
  let trimmed = content;
  if (headerIndexes.length > 0) {
    let start = headerIndexes.length > maxRuns ? headerIndexes[headerIndexes.length - maxRuns]! : 0;
    let remaining = headerIndexes.filter((index) => index >= start);
    trimmed = lines.slice(start).join("\n");
    while (Buffer.byteLength(trimmed, "utf8") > maxBytes && remaining.length > 1) {
      remaining = remaining.slice(1);
      start = remaining[0]!;
      trimmed = lines.slice(start).join("\n");
    }
  }
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;
  const notice = `${RUN_HEADER_PREFIX} truncated: earlier output exceeded ${maxBytes} bytes ===\n`;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  const keepNotice = noticeBytes < maxBytes;
  const budget = keepNotice ? maxBytes - noticeBytes : maxBytes;
  if (budget <= 0) return "";
  const buffer = Buffer.from(trimmed, "utf8");
  // Start on a character boundary: decoding a split UTF-8 sequence yields
  // replacement characters that are LARGER than the bytes they replace, which
  // would push the result back over the ceiling this branch exists to enforce.
  let start = Math.max(0, buffer.length - budget);
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  const tail = buffer.subarray(start).toString("utf8");
  return keepNotice ? `${notice}${tail}` : tail;
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

export function parseLockRecord(text: string): LockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const { host, pid, startedAt, token, sticky } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== "string" || typeof startedAt !== "string") return undefined;
  return {
    host,
    pid,
    startedAt,
    sticky: sticky === true,
    token: typeof token === "string" ? token : "",
  };
}

/**
 * A lock entry is only retired when its owner is provably gone: a dead pid on
 * this machine, or an age no honest run can reach (a whole publish is minutes,
 * and every child process below carries a timeout). The age cap exists so a
 * recycled pid or a wedged process cannot silence the schedule forever.
 */
export function isLockStale(record: LockRecord | undefined, input: LockCheckInput): boolean {
  if (record === undefined) return true;
  const startedAt = Date.parse(record.startedAt);
  if (Number.isNaN(startedAt)) return true;
  // A sticky entry stands for something whose pid we cannot follow, so only the
  // age cap (or a human deleting the file) can retire it.
  if (!record.sticky && record.host === input.host && !input.isProcessAlive(record.pid))
    return true;
  return input.now - startedAt > (input.maxAgeMs ?? STALE_LOCK_MS);
}

/**
 * Every run writes its OWN uniquely named entry into the lock directory and
 * then looks around. That name uniqueness is what makes retiring a dead entry
 * safe: names are never reused, so a delete can never land on a live run's lock
 * the way it could with one shared lockfile. A run that sees any other live
 * entry removes its own and backs off; if two runs see each other, both back off
 * and the next tick does the work - never two syncs in one checkout.
 */
export function acquireLock(
  lockDir: string,
  input: LockCheckInput & { readonly pid: number; readonly token: string },
): LockAcquisition {
  NodeFS.mkdirSync(lockDir, { recursive: true });
  const entryName = `${input.token}.json`;
  const record: LockRecord = {
    host: input.host,
    pid: input.pid,
    startedAt: new Date(input.now).toISOString(),
    sticky: false,
    token: input.token,
  };
  NodeFS.writeFileSync(NodePath.join(lockDir, entryName), `${JSON.stringify(record)}\n`, {
    flag: "wx",
  });
  // Every uncertainty below resolves to "assume it is live and back off": a
  // missed sync costs two hours, a second concurrent sync costs a wedged
  // checkout. Inspection failures are reported separately so the run can exit
  // non-zero instead of looking like a healthy no-op forever.
  let blockedBy: string | undefined;
  let blockedReason: "held" | "error" | undefined;
  const block = (reason: "held" | "error", description: string): void => {
    blockedBy = description;
    blockedReason = reason;
  };
  for (const name of NodeFS.readdirSync(lockDir)) {
    if (name === entryName || !name.endsWith(".json")) continue;
    const entryPath = NodePath.join(lockDir, name);
    let contents: string;
    try {
      contents = NodeFS.readFileSync(entryPath, "utf8");
    } catch (error) {
      // Vanished means its owner released it; anything else (sharing violation,
      // permissions) is not evidence that the owner is gone.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      block("error", `an unreadable lock entry (${name}: ${(error as Error).message})`);
      break;
    }
    const other = parseLockRecord(contents);
    if (other === undefined) {
      // Possibly another run's entry caught mid-write; only treat it as junk
      // once it is far too old to be one.
      let modifiedAt: number;
      try {
        modifiedAt = NodeFS.statSync(entryPath).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        block("error", `an unstattable lock entry (${name}: ${(error as Error).message})`);
        break;
      }
      if (input.now - modifiedAt <= LOCK_ENTRY_GRACE_MS) {
        block("held", describeLockRecord(undefined, name));
        break;
      }
    } else if (!isLockStale(other, input)) {
      // A sticky blocker means an earlier run could not prove it cleaned up, so
      // it must be loud rather than look like an ordinary overlap.
      block(other.sticky ? "error" : "held", describeLockRecord(other, name));
      break;
    }
    try {
      NodeFS.rmSync(entryPath);
    } catch (error) {
      // If a dead entry cannot be removed, treat the lock as held rather than
      // running beside whatever is holding the file open.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        block(
          "error",
          `a lock entry that could not be retired (${name}: ${(error as Error).message})`,
        );
        break;
      }
    }
  }
  if (blockedBy !== undefined) {
    const releaseError = releaseLock(lockDir, input.token);
    if (releaseError !== undefined) {
      // Backing off while leaving our own entry behind would block every later
      // run, so that is an error, not an ordinary overlap.
      return {
        acquired: false,
        blockedBy: `${blockedBy}; this run could not remove its own entry either (${releaseError})`,
        blockedReason: "error",
      };
    }
    return { acquired: false, blockedBy, blockedReason };
  }
  return { acquired: true, blockedBy: undefined, blockedReason: undefined };
}

/**
 * Returns the error that prevented the release, if any. A lock entry that
 * cannot be removed is a ghost that blocks later runs, so callers report it
 * instead of assuming cleanup worked.
 */
export function releaseLock(lockDir: string, token: string): string | undefined {
  try {
    NodeFS.rmSync(NodePath.join(lockDir, `${token}.json`));
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return (error as Error).message;
  }
}

/**
 * Hands this run's lock entry to a process it could not kill, so the liveness
 * check keeps every later run out while that orphan is still alive - our own
 * pid would be dead the moment this process exits, which would retire the entry
 * immediately.
 */
export function adoptLockEntry(
  lockDir: string,
  token: string,
  pid: number,
  now: number,
  sticky = false,
): string | undefined {
  const record: LockRecord = {
    host: NodeOS.hostname(),
    pid,
    startedAt: new Date(now).toISOString(),
    sticky,
    token,
  };
  const target = NodePath.join(lockDir, `${token}.json`);
  // Write beside the entry and rename over it: a scanning run can then only ever
  // see the old entry or the new one, never a half-written record it would
  // mistake for junk. The temp name deliberately does not end in .json so the
  // scan ignores it.
  const temp = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temp, `${JSON.stringify(record)}\n`);
    NodeFS.renameSync(temp, target);
  } catch (error) {
    try {
      NodeFS.rmSync(temp, { force: true });
    } catch {
      // The temp file is inert either way.
    }
    return (error as Error).message;
  }
  // Prove the entry a later run will read really carries this pid and flag.
  try {
    const written = parseLockRecord(NodeFS.readFileSync(target, "utf8"));
    if (written === undefined || written.pid !== pid || written.sticky !== sticky) {
      return `the lock entry does not read back as pid ${pid}${sticky ? " (sticky)" : ""}`;
    }
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

export function describeLockRecord(record: LockRecord | undefined, entryName: string): string {
  if (record === undefined) return `an unreadable lock entry (${entryName})`;
  const held = `pid ${record.pid} on ${record.host} (started ${record.startedAt})`;
  return record.sticky
    ? `${held}, whose cleanup was never confirmed - delete ${entryName} once you are sure nothing of it is still running`
    : held;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** First object id from `git ls-remote` output, or undefined when the ref is gone. */
export function parseMarkerSha(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const sha = line.trim().split(/\s+/u)[0];
    if (sha !== undefined && /^[0-9a-f]{40}$/u.test(sha)) return sha;
  }
  return undefined;
}

function describeFailure(result: CommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()].find((part) => part.length > 0);
  return `exit ${result.status}${detail ? `: ${detail}` : ""}`;
}

export async function runForkSync(deps: ForkSyncDependencies): Promise<ForkSyncResult> {
  const fail = (message: string, outcome: ForkSyncOutcome = "failed"): ForkSyncResult => {
    deps.log(`FAILED: ${message}`);
    return { outcome, exitCode: 1 };
  };

  // --- Gate (read-only) ---------------------------------------------------
  const fetchOrigin = deps.git([
    "fetch",
    ORIGIN_REMOTE,
    `+refs/heads/main:refs/remotes/${ORIGIN_REMOTE}/main`,
  ]);
  if (fetchOrigin.status !== 0) {
    return fail(`Could not fetch ${ORIGIN_REMOTE}/main (${describeFailure(fetchOrigin)}).`);
  }
  const markerRefs = deps.git([
    "ls-remote",
    "--heads",
    ORIGIN_REMOTE,
    `refs/heads/${MARKER_BRANCH}`,
  ]);
  if (markerRefs.status !== 0) {
    return fail(`Could not list ${ORIGIN_REMOTE} branches (${describeFailure(markerRefs)}).`);
  }
  const markerSha = parseMarkerSha(markerRefs.stdout);
  const pinnedManifest = deps.git(["show", `${ORIGIN_REMOTE}/main:${PINNED_PACKAGE_FILES[0]}`]);
  const pinned =
    pinnedManifest.status === 0 ? readManifestVersion(pinnedManifest.stdout) : undefined;
  const nightlyVersion = await deps.fetchNightlyVersion();
  const gate = decideForkSyncGate({
    markerPresent: markerSha !== undefined,
    nightly: nightlyVersion,
    pinned,
  });
  deps.log(gate.reason);
  if (!gate.proceed) {
    return gate.resolved ? { outcome: "up-to-date", exitCode: 0 } : fail(gate.reason);
  }

  // --- Preconditions (still read-only) ------------------------------------
  const branch = deps.git(["branch", "--show-current"]);
  if (branch.status !== 0)
    return fail(`Could not read the current branch (${describeFailure(branch)}).`);
  const trackedStatus = deps.git(["status", "--porcelain", "--untracked-files=no"]);
  if (trackedStatus.status !== 0) {
    return fail(`Could not read the working tree status (${describeFailure(trackedStatus)}).`);
  }
  const headRev = deps.git(["rev-parse", "HEAD"]);
  const originRev = deps.git(["rev-parse", `${ORIGIN_REMOTE}/main`]);
  if (headRev.status !== 0 || originRev.status !== 0) {
    return fail("Could not resolve HEAD and origin/main.");
  }
  const headSha = headRev.stdout.trim();
  const originSha = originRev.stdout.trim();
  let aheadSubjects: ReadonlyArray<string> = [];
  let originIsAncestor = false;
  let headIsAncestor = false;
  if (headSha !== originSha) {
    headIsAncestor =
      deps.git(["merge-base", "--is-ancestor", "HEAD", `${ORIGIN_REMOTE}/main`]).status === 0;
    originIsAncestor =
      !headIsAncestor &&
      deps.git(["merge-base", "--is-ancestor", `${ORIGIN_REMOTE}/main`, "HEAD"]).status === 0;
    if (originIsAncestor) {
      const log = deps.git(["log", "--first-parent", "--format=%s", `${ORIGIN_REMOTE}/main..HEAD`]);
      if (log.status !== 0) return fail(`Could not read local commits (${describeFailure(log)}).`);
      aheadSubjects = log.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  }
  const pendingPushSha = deps.readPendingPushSha();
  const localMain = classifyLocalMain({
    aheadSubjects,
    headIsAncestor,
    headSha,
    originIsAncestor,
    originSha,
    pendingPushSha,
  });
  const failures = describePreconditionFailures({
    branch: branch.stdout.trim(),
    localMain,
    trackedStatus: trackedStatus.stdout,
  });
  if (failures.length > 0) {
    for (const failure of failures) deps.log(`REFUSED: ${failure}`);
    return { outcome: "blocked", exitCode: 1 };
  }
  if (localMain === "resumable-ahead") {
    deps.log(
      `Local main is ahead of ${ORIGIN_REMOTE}/main by ${aheadSubjects.length} commit(s) this sync made and could not push; resuming that push.`,
    );
  } else if (pendingPushSha !== undefined) {
    deps.log("The previously unpushed sync commit is gone; forgetting it.");
    deps.writePendingPushSha(undefined);
  }
  if (localMain === "behind") {
    // Fast-forward only: refuses outright rather than rewriting anything.
    const fastForward = deps.git([
      "merge",
      ...GIT_MERGE_SAFETY_FLAGS,
      "--ff-only",
      `${ORIGIN_REMOTE}/main`,
    ]);
    if (fastForward.status !== 0) {
      return fail(
        `Could not fast-forward main to ${ORIGIN_REMOTE}/main (${describeFailure(fastForward)}). Nothing else was changed.`,
      );
    }
    deps.log(
      `Fast-forwarded main ${headSha.slice(0, 12)} -> ${originSha.slice(0, 12)} (${ORIGIN_REMOTE} moved ahead).`,
    );
  }

  // --- Merge upstream -----------------------------------------------------
  const upstreamUrl = deps.git(["remote", "get-url", UPSTREAM_REMOTE]);
  if (upstreamUrl.status !== 0) {
    return fail(
      `No '${UPSTREAM_REMOTE}' remote. Add it with: git remote add ${UPSTREAM_REMOTE} https://github.com/pingdotgg/t3code.git`,
    );
  }
  deps.log(`Fetching ${UPSTREAM_REMOTE} (${upstreamUrl.stdout.trim()}).`);
  const fetchUpstream = deps.git([
    "fetch",
    UPSTREAM_REMOTE,
    `+refs/heads/main:refs/remotes/${UPSTREAM_REMOTE}/main`,
  ]);
  if (fetchUpstream.status !== 0) {
    return fail(`Could not fetch ${UPSTREAM_REMOTE}/main (${describeFailure(fetchUpstream)}).`);
  }

  // Tracks the commit this run is responsible for, so the push at the end can
  // prove it is pushing its own work and nothing that landed in between. It
  // starts at the HEAD the preconditions validated (origin/main itself, the
  // fast-forwarded target, or this script's own unpushed commit).
  let expectedHead = localMain === "behind" ? originSha : headSha;
  const rememberHead = (label: string): boolean => {
    const head = deps.git(["rev-parse", "HEAD"]);
    if (head.status !== 0) return false;
    expectedHead = head.stdout.trim();
    deps.log(`${label}: main is now ${expectedHead.slice(0, 12)}.`);
    return true;
  };

  // The fetch above can take minutes, so re-establish the ground truth right
  // against the merge: anything the developer committed or edited during it must
  // stop this run, not end up inside the merge commit.
  const preMergeHead = deps.git(["rev-parse", "HEAD"]);
  const preMergeStatus = deps.git(["status", "--porcelain", "--untracked-files=no"]);
  if (preMergeHead.status !== 0 || preMergeStatus.status !== 0) {
    return fail("Could not re-check the checkout after fetching upstream; nothing was merged.");
  }
  if (preMergeHead.stdout.trim() !== expectedHead) {
    return fail(
      `HEAD moved to ${preMergeHead.stdout.trim().slice(0, 12)} while upstream was fetching; nothing was merged, committed, or pushed.`,
    );
  }
  if (preMergeStatus.stdout.trim().length > 0) {
    return fail(
      "Tracked files changed while upstream was fetching; nothing was merged, committed, or pushed.",
    );
  }

  const merge = deps.git([
    "merge",
    ...GIT_MERGE_SAFETY_FLAGS,
    "--no-edit",
    `${UPSTREAM_REMOTE}/main`,
  ]);
  if (merge.status !== 0) {
    const conflictList = deps.git(["diff", "--name-only", "--diff-filter=U"]);
    const kind =
      conflictList.status === 0 ? classifyMergeConflicts(conflictList.stdout) : "genuine";
    let resolved = false;
    if (kind === "pin-only") {
      // The four pinned manifests conflict on every sync by construction
      // (upstream bumps the same version line the fork re-stamps below), so
      // take upstream's side and finish the merge. Everything else is a real
      // conflict and gets the marker branch.
      deps.log("Only version-pin conflicts; taking upstream's side (the pin step re-stamps them).");
      resolved = true;
      for (const file of PINNED_PACKAGE_FILES) {
        if (!conflictList.stdout.split("\n").some((line) => line.trim() === file)) continue;
        const checkout = deps.git(["checkout", "--theirs", "--", file]);
        const add = checkout.status === 0 ? deps.git(["add", "--", file]) : checkout;
        if (add.status !== 0) {
          deps.log(`Auto-resolution failed for ${file} (${describeFailure(add)}).`);
          resolved = false;
          break;
        }
      }
      if (resolved) {
        // Never commit a merge that still has unmerged paths, whatever the
        // earlier listing said.
        const remaining = deps.git(["diff", "--name-only", "--diff-filter=U"]);
        if (remaining.status !== 0 || remaining.stdout.trim().length > 0) {
          deps.log(
            `Conflicts remain after the auto-resolution (${remaining.stdout.trim() || describeFailure(remaining)}).`,
          );
          resolved = false;
        }
      }
      if (resolved) {
        const commit = deps.git(["commit", "--no-edit"]);
        if (commit.status !== 0) {
          deps.log(`Could not commit the auto-resolved merge (${describeFailure(commit)}).`);
          resolved = false;
        }
      }
    }
    if (!resolved) {
      deps.log(`The upstream merge failed (${describeFailure(merge)}).`);
      let abort = deps.git(["merge", "--abort"]);
      if (abort.status !== 0) abort = deps.git(["merge", "--abort"]);
      const afterAbort = deps.git(["status", "--porcelain", "--untracked-files=no"]);
      if (abort.status !== 0 || afterAbort.status !== 0 || afterAbort.stdout.trim().length > 0) {
        return fail(
          "The upstream merge conflicted and could not be aborted cleanly. The checkout is mid-merge - resolve it by hand (git merge --abort or finish the merge). No marker branch was pushed.",
        );
      }
      const marker = deps.git([
        "push",
        ORIGIN_REMOTE,
        `HEAD:refs/heads/${MARKER_BRANCH}`,
        "--force",
      ]);
      if (marker.status !== 0) {
        return fail(
          `Official changes conflict with fork customizations and the ${MARKER_BRANCH} marker could not be pushed (${describeFailure(marker)}). The merge was aborted; the checkout is unchanged.`,
        );
      }
      deps.log(
        `FAILED: Official changes conflict with fork customizations. Open Claude Code in the T3 Code folder and say: finish the upstream merge. The merge was aborted and the ${MARKER_BRANCH} marker was pushed; once the resolved merge is on main this sync clears it.`,
      );
      return { outcome: "conflict", exitCode: 1 };
    }
  }
  if (!rememberHead("Merged upstream/main")) return fail("Could not resolve HEAD after the merge.");

  // --- Pin the four manifests --------------------------------------------
  if (nightlyVersion === undefined) {
    // Same as the workflow: no nightly resolved means no pin, but the marker
    // cleanup and release below still run.
    deps.log("No npm nightly resolved; skipping the version pin for this run.");
  } else {
    // Every check happens before the first write, so a refusal here really does
    // leave the checkout untouched. This runs unattended in a live checkout, so
    // a manifest the developer started editing since the precondition snapshot
    // must never be overwritten or committed by this script.
    for (const file of PINNED_PACKAGE_FILES) {
      const fileStatus = deps.git(["status", "--porcelain", "--untracked-files=no", "--", file]);
      if (fileStatus.status !== 0 || fileStatus.stdout.trim().length > 0) {
        return fail(
          `${file} changed underneath this run (${fileStatus.stdout.trim() || describeFailure(fileStatus)}). Nothing was written, committed, or pushed.`,
        );
      }
    }
    const updates = new Map<string, { readonly basis: string; readonly pinned: string }>();
    for (const file of PINNED_PACKAGE_FILES) {
      try {
        const basis = deps.readPinnedManifest(file);
        const pinned = pinManifestText(basis, nightlyVersion);
        if (pinned !== undefined) updates.set(file, { basis, pinned });
      } catch (error) {
        return fail(
          `Could not pin ${file}: ${error instanceof Error ? error.message : String(error)}. Nothing was written, committed, or pushed.`,
        );
      }
    }
    for (const [file, { basis, pinned }] of updates) {
      // Re-read right against the write: the only remaining window in which a
      // developer save could be overwritten is this single call gap.
      if (deps.readPinnedManifest(file) !== basis) {
        return fail(`${file} changed while this run was pinning it; nothing was written to it.`);
      }
      deps.writePinnedManifest(file, pinned);
    }
    if (updates.size > 0) {
      for (const [file, { pinned }] of updates) {
        // If anything replaced our content in between, that content belongs to
        // the developer: leave it alone and commit nothing.
        if (deps.readPinnedManifest(file) !== pinned) {
          return fail(`${file} changed after this run pinned it; nothing was committed or pushed.`);
        }
      }
      // Pathspec form: git commits ONLY these paths from the working tree, so
      // nothing the developer may have staged in the meantime can ride along.
      const commit = deps.git([
        "commit",
        "-m",
        `chore(fork): pin nightly ${nightlyVersion}`,
        "--",
        ...updates.keys(),
      ]);
      if (commit.status !== 0) {
        return fail(`Could not commit the nightly pin (${describeFailure(commit)}).`);
      }
      deps.log(`Pinned ${updates.size} manifest(s) to nightly ${nightlyVersion}.`);
      if (!rememberHead("Committed the nightly pin")) {
        return fail("Could not resolve HEAD after the pin commit.");
      }
    }
  }

  // --- Push and clear the marker -----------------------------------------
  const finalStatus = deps.git(["status", "--porcelain", "--untracked-files=no"]);
  if (finalStatus.status !== 0 || finalStatus.stdout.trim().length > 0) {
    return fail(
      "The merge left tracked changes behind. Nothing was pushed or published; inspect the checkout by hand.",
    );
  }
  const finalHead = deps.git(["rev-parse", "HEAD"]);
  if (finalHead.status !== 0) return fail("Could not resolve HEAD after the merge.");
  const finalSha = finalHead.stdout.trim();
  // Only a commit this run made may be pushed. If HEAD is anything else, the
  // developer committed underneath the run: leave their commit local and stop.
  if (finalSha !== expectedHead) {
    return fail(
      `HEAD is ${finalSha.slice(0, 12)}, not the ${expectedHead.slice(0, 12)} this run created. Someone committed underneath the sync; nothing was pushed or published.`,
    );
  }
  if (finalSha === originSha) {
    // Nothing new to push, but the workflow still ran its release job here (this
    // is the "someone else pushed the resolved merge" case), and the publisher
    // skips a desktop build it already published, so publishing stays correct
    // and cheap.
    deps.log(
      `main already matches ${ORIGIN_REMOTE}/main (${finalSha.slice(0, 12)}); nothing to push.`,
    );
  } else {
    // Push the exact object this run verified, never the moving `main` ref: a
    // commit the developer lands between the check and the push must not be
    // swept along.
    const push = deps.git(["push", ORIGIN_REMOTE, `${finalSha}:refs/heads/main`]);
    if (push.status !== 0) {
      // Remember the commit so the next run may retry this exact push, and only
      // this one — see classifyLocalMain.
      deps.writePendingPushSha(finalSha);
      return fail(
        `Could not push main (${describeFailure(push)}). The merge and pin commits are safe in the local checkout; the next run retries the push.`,
      );
    }
    deps.writePendingPushSha(undefined);
    deps.log(`Pushed main ${originSha.slice(0, 12)} -> ${finalSha.slice(0, 12)}.`);
  }
  const markerCleared = clearMarker(deps, markerSha);

  // --- Publish ------------------------------------------------------------
  deps.log("Publishing the personal desktop and iPhone updates.");
  const publishCode = await deps.publish();
  if (publishCode !== 0) {
    return fail(
      `The publisher exited with code ${publishCode}. main is pushed, so re-run the publisher when the cause is fixed.`,
    );
  }
  deps.log("Publish finished.");
  if (!markerCleared) {
    // The in-app pill keeps pointing at a merge that is already done until this
    // succeeds, so the run is not a success.
    return fail(`The sync and publish succeeded but the ${MARKER_BRANCH} marker is still up.`);
  }
  return { outcome: "published", exitCode: 0 };
}

function clearMarker(deps: ForkSyncDependencies, markerSha: string | undefined): boolean {
  if (markerSha === undefined) return true;
  // Another machine may have raised a NEWER marker for a different conflict
  // while this run worked; deleting that would silence a pill that is still
  // needed, so only the exact marker this run gated on is removed.
  const current = deps.git(["ls-remote", "--heads", ORIGIN_REMOTE, `refs/heads/${MARKER_BRANCH}`]);
  if (current.status !== 0) {
    deps.log(`Could not re-check the ${MARKER_BRANCH} marker (${describeFailure(current)}).`);
    return false;
  }
  const currentSha = parseMarkerSha(current.stdout);
  if (currentSha === undefined) {
    deps.log(`The ${MARKER_BRANCH} marker is already gone.`);
    return true;
  }
  if (currentSha !== markerSha) {
    deps.log(
      `The ${MARKER_BRANCH} marker now points at ${currentSha.slice(0, 12)}, not the ${markerSha.slice(0, 12)} this run gated on; leaving the newer conflict signal up.`,
    );
    return true;
  }
  // The lease makes the delete itself conditional on the remote still holding
  // this sha, so a marker raised between the check and the push survives.
  const remove = deps.git([
    "push",
    ORIGIN_REMOTE,
    `:refs/heads/${MARKER_BRANCH}`,
    `--force-with-lease=refs/heads/${MARKER_BRANCH}:${markerSha}`,
  ]);
  deps.log(
    remove.status === 0
      ? `Cleared the ${MARKER_BRANCH} marker.`
      : `Could not clear the ${MARKER_BRANCH} marker (${describeFailure(remove)}); the next run retries.`,
  );
  return remove.status === 0;
}

// ---------------------------------------------------------------------------
// Node entry point
// ---------------------------------------------------------------------------

/**
 * Local git configuration must not be able to change what this script does to
 * the developer's tree:
 *  - merge.autoStash / rebase.autoStash would let a merge stash their work,
 *    which is the one thing this script must never do;
 *  - push.followTags would push tags this run did not create alongside the
 *    single commit it verified.
 * Passing them per invocation overrides repo, global and system config without
 * writing to any of them.
 */
export const GIT_SAFETY_CONFIG: ReadonlyArray<string> = [
  "-c",
  "merge.autoStash=false",
  "-c",
  "rebase.autoStash=false",
  "-c",
  "push.followTags=false",
  // branch.main.mergeOptions can smuggle --autostash, --squash or --no-commit
  // into every merge, which would defeat the settings above; emptying it is the
  // only way to be sure of what `git merge` will do.
  "-c",
  "branch.main.mergeOptions=",
];

/** Flags that re-assert the same guarantees on the command line, which wins. */
export const GIT_MERGE_SAFETY_FLAGS: ReadonlyArray<string> = [
  "--no-autostash",
  "--commit",
  "--no-squash",
];

export function createGitRunner(repoRoot: string): (args: ReadonlyArray<string>) => CommandResult {
  return (args) => {
    const result = NodeChildProcess.spawnSync("git.exe", [...GIT_SAFETY_CONFIG, ...args], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      // stdin is closed and every call is bounded, so a credential prompt or a
      // hung remote fails the run instead of holding the lock forever.
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.error) {
      return { status: -1, stdout: "", stderr: result.error.message };
    }
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

export async function fetchNpmNightlyVersion(): Promise<string | undefined> {
  for (let attempt = 1; attempt <= NIGHTLY_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(NPM_DIST_TAGS_URL, {
        signal: AbortSignal.timeout(NIGHTLY_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      return parseNightlyDistTag(await response.json());
    } catch {
      // Retry once; a transient npm hiccup should not fail the whole run.
    }
  }
  return undefined;
}

/**
 * Decides what a timed-out publisher leaves behind.
 *  - `taskkill /T` reports on the whole tree, so ANY non-zero status means a
 *    descendant (electron-builder, gh, eas) may have survived. A survivor's pid
 *    is not something later runs can watch, so the lock entry must be sticky
 *    and cleared by a human - whether or not the root is still alive, because
 *    the root dying is exactly what would otherwise retire the entry.
 *  - A clean kill with the root still alive is a termination in progress: later
 *    runs can simply wait on that pid.
 */
export function classifyPublisherTermination(
  killStatus: number | null,
  rootAlive: boolean,
): { readonly orphan: boolean; readonly sticky: boolean } {
  const killFailed = killStatus !== 0;
  return { orphan: rootAlive || killFailed, sticky: killFailed };
}

/**
 * Runs the local publisher with its own timeout. The timeout is owned here, not
 * handed to spawnSync, because spawnSync only returns once the publisher itself
 * has already exited - by then its pid is gone and `taskkill /T` has nothing to
 * walk. electron-builder, gh and eas run as its children and would otherwise
 * keep using the release worktree after this run released the lock, so the tree
 * is killed while the captured pid is still alive (never by name or pattern).
 */
function runPublisher(
  repoRoot: string,
  log: (message: string) => void,
  onOrphan: (pid: number, sticky: boolean) => void,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const publisher = NodeChildProcess.spawn(
      process.execPath,
      [NodePath.join(repoRoot, "scripts", "publish-personal-update.ts")],
      { cwd: repoRoot, env: process.env, stdio: "inherit" },
    );
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      const pid = publisher.pid;
      if (typeof pid !== "number" || pid <= 0) {
        publisher.kill();
        log(`The publisher exceeded ${PUBLISH_TIMEOUT_MS} ms and was killed.`);
        finish(-1);
        return;
      }
      const killed = NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      // Do not take taskkill's word for it: while the publisher is alive its
      // children may still be driving electron-builder, gh or eas, and this run
      // must not release the lock behind them.
      let alive: boolean;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
      log(
        `The publisher exceeded ${PUBLISH_TIMEOUT_MS} ms; taskkill on pid ${pid} ${
          killed.status === 0 ? "succeeded" : killed.stderr.trim() || "failed"
        } and the process is ${alive ? "STILL ALIVE" : "gone"}.`,
      );
      const termination = classifyPublisherTermination(killed.status, alive);
      if (termination.orphan) onOrphan(pid, termination.sticky);
      finish(-1);
    }, PUBLISH_TIMEOUT_MS);
    publisher.on("error", (error) => {
      log(`Could not start the publisher: ${error.message}`);
      finish(-1);
    });
    publisher.on("close", (code, signal) => {
      if (signal !== null) log(`The publisher was terminated by ${signal}.`);
      finish(code ?? -1);
    });
  });
}

async function main(): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone scheduled sync runs before the Effect workspace is installed.
  if (process.platform !== "win32") {
    throw new Error("The personal local fork sync currently supports Windows only.");
  }
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const logPath = NodePath.join(repoRoot, LOG_RELATIVE_PATH);
  const lockDir = NodePath.join(repoRoot, LOCK_DIR_RELATIVE_PATH);
  const pendingPushPath = NodePath.join(repoRoot, PENDING_PUSH_RELATIVE_PATH);
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });

  // The scheduled task redirects stdout/stderr into this same file, so mirroring
  // would double every line; interactive runs still want console output.
  const scheduled = process.argv.slice(2).includes("--task");
  const rotate = (keptRuns: number): void => {
    try {
      // The scheduled task holds an append handle on this same file; append
      // handles always write at EOF, so truncating here is safe, and a rotation
      // hiccup must never skip or fail the sync.
      const existingLog = NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8") : "";
      const trimmedLog = trimLogRuns(existingLog, keptRuns, MAX_LOG_BYTES);
      if (trimmedLog !== existingLog) NodeFS.writeFileSync(logPath, trimmedLog);
    } catch (error) {
      console.error(`Could not rotate ${logPath}: ${error instanceof Error ? error.message : ""}`);
    }
  };
  rotate(MAX_LOGGED_RUNS - 1);
  const appendLog = (text: string): void => {
    // Logging must never throw: a deleted .logs directory or a full disk cannot
    // be allowed to skip an abort or a cleanup step further down the run.
    try {
      NodeFS.appendFileSync(logPath, text);
    } catch {
      // Console still carries the line when the file cannot.
    }
  };
  const log = (message: string): void => {
    const line = formatLogLine(new Date().toISOString(), message);
    appendLog(`${line}\n`);
    if (!scheduled) console.log(line);
  };
  appendLog(`${RUN_HEADER_PREFIX} ${new Date().toISOString()} pid ${process.pid} ===\n`);

  const host = NodeOS.hostname();
  const token = NodeCrypto.randomUUID();
  const lock = acquireLock(lockDir, {
    host,
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    now: Date.now(),
    pid: process.pid,
    token,
  });
  if (!lock.acquired) {
    if (lock.blockedReason === "error") {
      // A lock directory this run cannot inspect would otherwise silence the
      // whole pipeline while Task Scheduler kept reporting success.
      log(`FAILED: the lock directory could not be inspected (${lock.blockedBy ?? "unknown"}).`);
      process.exitCode = 1;
      return;
    }
    log(`Another fork sync holds the lock (${lock.blockedBy ?? "unknown"}); exiting.`);
    return;
  }

  let orphanedPublisher: { readonly pid: number; readonly sticky: boolean } | undefined;
  try {
    const result = await runForkSync({
      fetchNightlyVersion: fetchNpmNightlyVersion,
      git: createGitRunner(repoRoot),
      log,
      publish: () =>
        runPublisher(repoRoot, log, (pid, sticky) => {
          orphanedPublisher = { pid, sticky };
        }),
      readPendingPushSha: () => {
        try {
          const sha = NodeFS.readFileSync(pendingPushPath, "utf8").trim();
          return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
        } catch {
          return undefined;
        }
      },
      readPinnedManifest: (relativePath) =>
        NodeFS.readFileSync(NodePath.join(repoRoot, relativePath), "utf8"),
      writePendingPushSha: (sha) => {
        if (sha === undefined) {
          NodeFS.rmSync(pendingPushPath, { force: true });
          return;
        }
        NodeFS.writeFileSync(pendingPushPath, `${sha}\n`);
      },
      writePinnedManifest: (relativePath, contents) => {
        NodeFS.writeFileSync(NodePath.join(repoRoot, relativePath), contents);
      },
    });
    log(`Run finished: ${result.outcome} (exit ${result.exitCode}).`);
    process.exitCode = result.exitCode;
  } catch (error) {
    // An unexpected throw still has to land in the log, not only on stderr.
    log(`FAILED: unexpected error: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (orphanedPublisher === undefined) {
      const releaseError = releaseLock(lockDir, token);
      if (releaseError !== undefined) {
        // A lock entry left behind would block every later run, so it has to be
        // visible in the task's result, not just in the log.
        log(`FAILED: could not release the lock entry (${releaseError}).`);
        process.exitCode = 1;
      }
    } else {
      // Hand the lock to the publisher we could not prove dead, so later runs
      // stay out instead of racing a second publisher over the same worktree
      // and release. If that write fails, a fresh entry is just as good a
      // barrier, and only if that fails too is the lock genuinely lost - which
      // the log then says in as many words.
      const { pid, sticky } = orphanedPublisher;
      let handoff = adoptLockEntry(lockDir, token, pid, Date.now(), sticky);
      let entryPath = NodePath.join(lockDir, `${token}.json`);
      if (handoff !== undefined) {
        const fallbackToken = NodeCrypto.randomUUID();
        const fallback = adoptLockEntry(lockDir, fallbackToken, pid, Date.now(), sticky);
        if (fallback === undefined) {
          log(`Could not update this run's lock entry (${handoff}); wrote ${fallbackToken}.json.`);
          entryPath = NodePath.join(lockDir, `${fallbackToken}.json`);
          handoff = undefined;
        } else {
          handoff = `${handoff}; the replacement entry failed too (${fallback})`;
        }
      }
      if (handoff !== undefined) {
        log(
          `FAILED: the publisher (pid ${pid}) may still be running and this run could not leave a lock behind (${handoff}). Check for stray publisher, electron-builder, gh or eas processes before the next scheduled run.`,
        );
      } else if (sticky) {
        log(
          `FAILED: could not confirm the publisher tree (pid ${pid}) was terminated. Later runs will refuse until you check nothing of it is still running and delete ${entryPath}.`,
        );
      } else {
        log(
          `FAILED: kept the lock for the surviving publisher (pid ${pid}); later runs stay out until it exits.`,
        );
      }
      process.exitCode = 1;
    }
    // The publisher appended its whole transcript after the first rotation, so
    // bound the file again now instead of leaving it oversized until next time.
    rotate(MAX_LOGGED_RUNS);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
