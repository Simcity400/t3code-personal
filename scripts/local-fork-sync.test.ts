// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Exercises the standalone scheduled sync, including its real lockfile.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  acquireLock,
  adoptLockEntry,
  createGitRunner,
  GIT_SAFETY_CONFIG,
  classifyLocalMain,
  classifyPublisherTermination,
  classifyMergeConflicts,
  decideForkSyncGate,
  formatLogLine,
  isForkSyncCommitSubject,
  isLockStale,
  parseLockRecord,
  parseNightlyDistTag,
  pinManifestText,
  PINNED_PACKAGE_FILES,
  readManifestVersion,
  releaseLock,
  runForkSync,
  RUN_HEADER_PREFIX,
  trimLogRuns,
  type CommandResult,
  type ForkSyncDependencies,
} from "./local-fork-sync.ts";

const ORIGIN_SHA = "1111111111111111111111111111111111111111";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const PIN_SHA = "3333333333333333333333333333333333333333";
const BEHIND_SHA = "4444444444444444444444444444444444444444";
const MARKER_SHA = "5555555555555555555555555555555555555555";
const NEWER_MARKER_SHA = "6666666666666666666666666666666666666666";
const DEVELOPER_SHA = "7777777777777777777777777777777777777777";
const PINNED_VERSION = "0.0.34-nightly.20260816.1106";
const NIGHTLY_VERSION = "0.0.34-nightly.20260825.1204";

function manifest(version: string): string {
  return `${JSON.stringify({ name: "@t3tools/desktop", version, private: true }, null, 2)}\n`;
}

interface RepoConfig {
  readonly abortFails?: boolean;
  readonly addFails?: boolean;
  readonly aheadSubjects?: ReadonlyArray<string>;
  readonly behind?: boolean;
  readonly branch?: string;
  readonly dirtyManifest?: string;
  readonly ffFails?: boolean;
  readonly markerClearFails?: boolean;
  readonly markerReplacedSha?: string;
  readonly dirtyBeforeMerge?: boolean;
  readonly headMovesAfterPin?: string;
  readonly headMovesBeforeMerge?: string;
  readonly headSha?: string;
  readonly marker?: boolean;
  readonly markerPushFails?: boolean;
  readonly merge?: "clean" | "up-to-date" | "pin-conflict" | "code-conflict" | "hook-failure";
  readonly nightly?: string | undefined;
  readonly pendingPushSha?: string;
  readonly pinnedOnOrigin?: string;
  readonly publishCode?: number;
  readonly pushFails?: boolean;
  readonly trackedStatus?: string;
  readonly upstreamMissing?: boolean;
  readonly workingVersion?: string;
}

interface Harness {
  readonly calls: ReadonlyArray<string>;
  readonly pushedRefs: ReadonlyArray<string>;
  readonly deps: ForkSyncDependencies;
  readonly logs: ReadonlyArray<string>;
  readonly manifests: Map<string, string>;
  readonly pendingPush: { sha: string | undefined };
  readonly publishRuns: { count: number };
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const bad = (stderr = "boom"): CommandResult => ({ status: 1, stdout: "", stderr });

function createHarness(config: RepoConfig = {}): Harness {
  const calls: Array<string> = [];
  const logs: Array<string> = [];
  const publishRuns = { count: 0 };
  const pushedRefs: Array<string> = [];
  const pendingPush: { sha: string | undefined } = { sha: config.pendingPushSha };
  const manifests = new Map<string, string>(
    PINNED_PACKAGE_FILES.map((file) => [file, manifest(config.workingVersion ?? PINNED_VERSION)]),
  );
  const state = {
    conflicts: [] as ReadonlyArray<string>,
    head: config.headSha ?? ORIGIN_SHA,
    headReadsAfterPin: 0,
    markerReads: 0,
    pinCommitted: false,
    tracked: config.trackedStatus ?? "",
  };
  const conflictStatus = (files: ReadonlyArray<string>): string =>
    files.map((file) => `UU ${file}`).join("\n");

  const git = (args: ReadonlyArray<string>): CommandResult => {
    const key = args.join(" ");
    calls.push(key);
    if (key.startsWith("fetch ")) {
      // The developer commits or edits while the fetch runs.
      if (key.includes("upstream")) {
        if (config.headMovesBeforeMerge !== undefined) state.head = config.headMovesBeforeMerge;
        if (config.dirtyBeforeMerge === true) state.tracked = " M apps/web/src/App.tsx";
      }
      return ok();
    }
    if (key.startsWith("ls-remote ")) {
      state.markerReads += 1;
      const sha =
        state.markerReads > 1 && config.markerReplacedSha !== undefined
          ? config.markerReplacedSha
          : MARKER_SHA;
      return ok(config.marker === true ? `${sha}\trefs/heads/needs-merge-help\n` : "");
    }
    if (key.startsWith("show origin/main:")) {
      return ok(manifest(config.pinnedOnOrigin ?? PINNED_VERSION));
    }
    if (key === "branch --show-current") return ok(`${config.branch ?? "main"}\n`);
    if (key === "status --porcelain --untracked-files=no") return ok(state.tracked);
    if (key.startsWith("status --porcelain --untracked-files=no -- ")) {
      const file = key.slice("status --porcelain --untracked-files=no -- ".length);
      return ok(config.dirtyManifest === file ? ` M ${file}\n` : "");
    }
    if (key === "rev-parse HEAD") {
      // Simulates the developer committing between this run's own commit and
      // its final HEAD check.
      state.headReadsAfterPin += state.pinCommitted ? 1 : 0;
      const sha =
        config.headMovesAfterPin !== undefined && state.headReadsAfterPin > 1
          ? config.headMovesAfterPin
          : state.head;
      return ok(`${sha}\n`);
    }
    if (key === "rev-parse origin/main") return ok(`${ORIGIN_SHA}\n`);
    if (key === "merge-base --is-ancestor HEAD origin/main") {
      return config.behind === true ? ok() : bad();
    }
    if (key === "merge-base --is-ancestor origin/main HEAD") {
      return config.aheadSubjects === undefined ? bad() : ok();
    }
    if (key === "merge --no-autostash --commit --no-squash --ff-only origin/main") {
      if (config.ffFails === true) return bad("fatal: Not possible to fast-forward");
      state.head = ORIGIN_SHA;
      return ok();
    }
    if (key.startsWith("log --first-parent")) return ok((config.aheadSubjects ?? []).join("\n"));
    if (key === "remote get-url upstream") {
      return config.upstreamMissing === true
        ? bad("No such remote 'upstream'")
        : ok("https://github.com/pingdotgg/t3code.git\n");
    }
    if (key === "merge --no-autostash --commit --no-squash --no-edit upstream/main") {
      const mode = config.merge ?? "clean";
      if (mode === "clean") {
        state.head = MERGE_SHA;
        return ok("Merge made by the 'ort' strategy.");
      }
      if (mode === "up-to-date") return ok("Already up to date.");
      if (mode === "hook-failure") {
        // A rejecting hook leaves a merge in progress with no unmerged paths.
        state.tracked = " M apps/web/src/App.tsx";
        return bad("error: pre-merge-commit hook refused the merge");
      }
      state.conflicts =
        mode === "pin-conflict"
          ? ["apps/desktop/package.json", "apps/web/package.json"]
          : ["apps/desktop/package.json", "apps/web/src/App.tsx"];
      state.tracked = conflictStatus(state.conflicts);
      return bad("CONFLICT (content): Merge conflict");
    }
    if (key === "diff --name-only --diff-filter=U") return ok(state.conflicts.join("\n"));
    if (key.startsWith("checkout --theirs -- ")) {
      state.conflicts = state.conflicts.filter(
        (file) => file !== key.slice("checkout --theirs -- ".length),
      );
      return ok();
    }
    if (key.startsWith("add -- ")) return config.addFails === true ? bad("fatal: unable") : ok();
    if (key === "commit --no-edit") {
      state.conflicts = [];
      state.tracked = "";
      state.head = MERGE_SHA;
      return ok();
    }
    if (key === "merge --abort") {
      if (config.abortFails === true) return bad("fatal: there is no merge to abort");
      state.conflicts = [];
      state.tracked = "";
      return ok();
    }
    if (key.startsWith("commit -m ")) {
      state.head = PIN_SHA;
      state.pinCommitted = true;
      state.tracked = "";
      return ok();
    }
    if (key.startsWith("push origin ") && key.endsWith(":refs/heads/main")) {
      pushedRefs.push(key.slice("push origin ".length, -":refs/heads/main".length));
      return config.pushFails === true ? bad("rejected") : ok();
    }
    if (key.startsWith("push origin HEAD:refs/heads/needs-merge-help")) {
      return config.markerPushFails === true ? bad("denied") : ok();
    }
    if (key.startsWith("push origin :refs/heads/needs-merge-help")) {
      return config.markerClearFails === true ? bad("remote rejected") : ok();
    }
    throw new Error(`Unscripted git call: ${key}`);
  };

  return {
    calls,
    logs,
    pushedRefs,
    manifests,
    pendingPush,
    publishRuns,
    deps: {
      fetchNightlyVersion: () =>
        Promise.resolve("nightly" in config ? config.nightly : NIGHTLY_VERSION),
      git,
      log: (message) => logs.push(message),
      publish: () => {
        publishRuns.count += 1;
        return Promise.resolve(config.publishCode ?? 0);
      },
      readPendingPushSha: () => pendingPush.sha,
      writePendingPushSha: (sha) => {
        pendingPush.sha = sha;
      },
      readPinnedManifest: (relativePath) => {
        const text = manifests.get(relativePath);
        if (text === undefined) throw new Error(`Unknown manifest ${relativePath}`);
        return text;
      },
      writePinnedManifest: (relativePath, contents) => {
        manifests.set(relativePath, contents);
      },
    },
  };
}

function expectNoDestructiveGit(calls: ReadonlyArray<string>): void {
  const destructive = calls.filter((call) =>
    /^(reset|stash|clean|restore|rebase|checkout (-f|--force|-B|main))\b/u.test(call),
  );
  expect(destructive).toEqual([]);
}

describe("local fork sync gate", () => {
  it("does nothing when the pinned version already matches the npm nightly", async () => {
    const harness = createHarness({ pinnedOnOrigin: NIGHTLY_VERSION });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "up-to-date", exitCode: 0 });
    expect(harness.calls.some((call) => call.startsWith("merge "))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.at(-1)).toContain("nothing to do");
    expectNoDestructiveGit(harness.calls);
  });

  it("still syncs when the versions match but a conflict marker is waiting", async () => {
    const harness = createHarness({ marker: true, pinnedOnOrigin: NIGHTLY_VERSION });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(
      harness.calls.some((call) =>
        call.startsWith("push origin :refs/heads/needs-merge-help --force-with-lease="),
      ),
    ).toBe(true);
    expect(harness.publishRuns.count).toBe(1);
  });

  it("fails loudly instead of syncing when npm cannot be reached", async () => {
    const harness = createHarness({ nightly: undefined });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("merge "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
  });

  it("compares against origin/main, not the working tree", () => {
    expect(
      decideForkSyncGate({ markerPresent: false, nightly: "1.0.0", pinned: "1.0.0" }).proceed,
    ).toBe(false);
    expect(
      decideForkSyncGate({ markerPresent: false, nightly: "1.0.1", pinned: "1.0.0" }).proceed,
    ).toBe(true);
    expect(
      decideForkSyncGate({ markerPresent: true, nightly: "1.0.0", pinned: "1.0.0" }).proceed,
    ).toBe(true);
    // A marker opens the gate on its own, exactly like the workflow's
    // "version differs OR marker" condition, even when npm is unreachable.
    expect(
      decideForkSyncGate({ markerPresent: true, nightly: undefined, pinned: "1.0.0" }).proceed,
    ).toBe(true);
    const unresolved = decideForkSyncGate({
      markerPresent: false,
      nightly: undefined,
      pinned: "1.0.0",
    });
    expect(unresolved).toMatchObject({ proceed: false, resolved: false });
    expect(unresolved.reason).toContain("could not resolve the npm nightly");
    expect(
      decideForkSyncGate({ markerPresent: false, nightly: "1.0.1", pinned: undefined }).resolved,
    ).toBe(false);
    expect(parseNightlyDistTag({ nightly: " 1.2.3 " })).toBe("1.2.3");
    expect(parseNightlyDistTag({ latest: "1.2.3" })).toBeUndefined();
    expect(parseNightlyDistTag("nope")).toBeUndefined();
    expect(readManifestVersion(manifest("9.9.9"))).toBe("9.9.9");
    expect(readManifestVersion("{oops")).toBeUndefined();
  });
});

describe("local fork sync preconditions", () => {
  it("refuses to touch a checkout with modified tracked files", async () => {
    const harness = createHarness({ trackedStatus: " M apps/web/src/App.tsx\n" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "blocked", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("merge "))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.some((line) => line.includes("never stashes or resets"))).toBe(true);
    expectNoDestructiveGit(harness.calls);
  });

  it("refuses when main carries commits this sync did not make", async () => {
    const harness = createHarness({
      aheadSubjects: ["feat(web): my own work"],
      headSha: MERGE_SHA,
    });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "blocked", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expectNoDestructiveGit(harness.calls);
  });

  it("refuses when the checkout is not on main", async () => {
    const harness = createHarness({ branch: "feature/x" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "blocked", exitCode: 1 });
    expect(harness.logs.some((line) => line.includes("not main"))).toBe(true);
  });

  it("resumes its own unpushed merge instead of stalling forever", async () => {
    const harness = createHarness({
      aheadSubjects: [
        "chore(fork): pin nightly 0.0.1",
        "Merge remote-tracking branch 'upstream/main'",
      ],
      headSha: MERGE_SHA,
      merge: "up-to-date",
      pendingPushSha: MERGE_SHA,
    });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(harness.pushedRefs.length).toBe(1);
    expect(harness.pendingPush.sha).toBeUndefined();
  });

  it("refuses to adopt someone else's merge commits that merely look like ours", async () => {
    const harness = createHarness({
      aheadSubjects: [
        "chore(fork): pin nightly 0.0.1",
        "Merge remote-tracking branch 'upstream/main'",
      ],
      headSha: MERGE_SHA,
    });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "blocked", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expectNoDestructiveGit(harness.calls);
  });

  it("forgets a pending push once main is back in sync", async () => {
    const harness = createHarness({ pendingPushSha: MERGE_SHA });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(harness.pendingPush.sha).toBeUndefined();
  });

  it("classifies local main states", () => {
    const base = {
      aheadSubjects: [] as ReadonlyArray<string>,
      headIsAncestor: false,
      headSha: MERGE_SHA,
      originIsAncestor: false,
      originSha: ORIGIN_SHA,
      pendingPushSha: undefined as string | undefined,
    };
    expect(classifyLocalMain({ ...base, headSha: ORIGIN_SHA })).toBe("in-sync");
    expect(classifyLocalMain({ ...base, headIsAncestor: true, headSha: BEHIND_SHA })).toBe(
      "behind",
    );
    expect(
      classifyLocalMain({
        ...base,
        aheadSubjects: ["chore(fork): pin nightly 1.0.0"],
        originIsAncestor: true,
        pendingPushSha: MERGE_SHA,
      }),
    ).toBe("resumable-ahead");
    expect(
      classifyLocalMain({
        ...base,
        aheadSubjects: ["chore(fork): pin nightly 1.0.0"],
        originIsAncestor: true,
      }),
    ).toBe("diverged");
    expect(
      classifyLocalMain({
        ...base,
        aheadSubjects: ["chore(fork): pin nightly 1.0.0", "fix(web): something"],
        originIsAncestor: true,
        pendingPushSha: MERGE_SHA,
      }),
    ).toBe("diverged");
    expect(classifyLocalMain({ ...base, pendingPushSha: MERGE_SHA })).toBe("diverged");
    expect(isForkSyncCommitSubject("Merge remote-tracking branch 'upstream/main' into main")).toBe(
      true,
    );
    expect(isForkSyncCommitSubject("chore(fork): pin nightly 0.0.35-nightly.1")).toBe(true);
    expect(isForkSyncCommitSubject("chore(fork): something else")).toBe(false);
  });
});

describe("local fork sync merge resolution", () => {
  it("auto-resolves conflicts confined to the four pinned manifests", async () => {
    const harness = createHarness({ merge: "pin-conflict" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(harness.calls).toContain("checkout --theirs -- apps/desktop/package.json");
    expect(harness.calls).toContain("checkout --theirs -- apps/web/package.json");
    expect(harness.calls).not.toContain("checkout --theirs -- apps/server/package.json");
    expect(harness.calls).toContain("commit --no-edit");
    expect(harness.calls.some((call) => call.startsWith("push origin HEAD:"))).toBe(false);
    expect(harness.pushedRefs.length).toBe(1);
    expect(harness.publishRuns.count).toBe(1);
    expectNoDestructiveGit(harness.calls);
  });

  it("aborts and raises the marker branch on a genuine code conflict", async () => {
    const harness = createHarness({ merge: "code-conflict" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "conflict", exitCode: 1 });
    expect(harness.calls).toContain("merge --abort");
    expect(harness.calls).toContain("push origin HEAD:refs/heads/needs-merge-help --force");
    expect(harness.calls).not.toContain("push origin main");
    expect(harness.calls.some((call) => call.startsWith("checkout "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.some((line) => line.includes("finish the upstream merge"))).toBe(true);
    expectNoDestructiveGit(harness.calls);
  });

  it("falls back to the marker when the pin auto-resolution itself fails", async () => {
    const harness = createHarness({ addFails: true, merge: "pin-conflict" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "conflict", exitCode: 1 });
    expect(harness.calls).toContain("merge --abort");
    expect(harness.calls).toContain("push origin HEAD:refs/heads/needs-merge-help --force");
    expect(harness.pushedRefs).toEqual([]);
    expect(harness.publishRuns.count).toBe(0);
    expectNoDestructiveGit(harness.calls);
  });

  it("leaves a half-merge alone rather than pushing a marker it cannot back up", async () => {
    const harness = createHarness({ abortFails: true, merge: "code-conflict" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expectNoDestructiveGit(harness.calls);
  });

  it("separates pin-only conflicts from genuine ones", () => {
    expect(classifyMergeConflicts("")).toBe("none");
    expect(classifyMergeConflicts("apps/desktop/package.json\napps/server/package.json\n")).toBe(
      "pin-only",
    );
    expect(classifyMergeConflicts("apps/desktop/package.json\napps/web/src/App.tsx\n")).toBe(
      "genuine",
    );
    expect(classifyMergeConflicts("package.json\n")).toBe("genuine");
  });
});

describe("local fork sync pin, push, and publish", () => {
  it("pins every manifest to the npm nightly and commits only those files", async () => {
    const harness = createHarness();
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    for (const file of PINNED_PACKAGE_FILES) {
      expect(readManifestVersion(harness.manifests.get(file) ?? "")).toBe(NIGHTLY_VERSION);
    }
    expect(harness.publishRuns.count).toBe(1);
  });

  it("keeps the merge commits and reports failure when the push is rejected", async () => {
    const harness = createHarness({ pushFails: true });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.some((line) => line.includes("next run retries the push"))).toBe(true);
    expect(harness.pendingPush.sha).toBe(PIN_SHA);
    expectNoDestructiveGit(harness.calls);
  });

  it("reports a failing publisher without undoing the pushed sync", async () => {
    const harness = createHarness({ publishCode: 2 });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.pushedRefs.length).toBe(1);
    expect(harness.logs.some((line) => line.includes("exited with code 2"))).toBe(true);
  });

  it("still clears the marker and publishes when someone else pushed the resolved merge", async () => {
    const harness = createHarness({
      marker: true,
      merge: "up-to-date",
      pinnedOnOrigin: NIGHTLY_VERSION,
      workingVersion: NIGHTLY_VERSION,
    });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(harness.calls).not.toContain("push origin main");
    expect(
      harness.calls.some((call) =>
        call.startsWith("push origin :refs/heads/needs-merge-help --force-with-lease="),
      ),
    ).toBe(true);
    // fork-sync.yml ran its release job here too; the publisher skips a desktop
    // build it already published, so this is cheap and keeps the surfaces level.
    expect(harness.publishRuns.count).toBe(1);
  });

  it("fast-forwards a checkout another machine left behind instead of stalling", async () => {
    const harness = createHarness({ behind: true, headSha: BEHIND_SHA, merge: "up-to-date" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(harness.calls).toContain(
      "merge --no-autostash --commit --no-squash --ff-only origin/main",
    );
    expect(
      harness.calls.indexOf("merge --no-autostash --commit --no-squash --ff-only origin/main"),
    ).toBeLessThan(
      harness.calls.indexOf("merge --no-autostash --commit --no-squash --no-edit upstream/main"),
    );
    expectNoDestructiveGit(harness.calls);
  });

  it("refuses when the fast-forward is not possible", async () => {
    const harness = createHarness({ behind: true, ffFails: true, headSha: BEHIND_SHA });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(
      harness.calls.some((call) => call.includes("upstream/main") && call.startsWith("merge ")),
    ).toBe(false);
    expectNoDestructiveGit(harness.calls);
  });

  it("writes nothing at all when any manifest is dirty, whichever one it is", async () => {
    // The last of the four is dirty: the earlier three must still be untouched,
    // which is only true because every check runs before the first write.
    const harness = createHarness({ dirtyManifest: "packages/contracts/package.json" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    for (const file of PINNED_PACKAGE_FILES) {
      expect(readManifestVersion(harness.manifests.get(file) ?? "")).toBe(PINNED_VERSION);
    }
    expect(harness.calls.some((call) => call.startsWith("commit -m "))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.some((line) => line.includes("Nothing was written"))).toBe(true);
    expectNoDestructiveGit(harness.calls);
  });

  it("commits nothing when a manifest changes between the pin and the commit", async () => {
    const harness = createHarness();
    const original = harness.deps.writePinnedManifest;
    let overwritten = false;
    const deps: ForkSyncDependencies = {
      ...harness.deps,
      writePinnedManifest: (relativePath, contents) => {
        original(relativePath, contents);
        // Simulate the developer saving over our pin right after we wrote it.
        if (!overwritten && relativePath === "apps/web/package.json") {
          overwritten = true;
          harness.manifests.set(relativePath, manifest("0.0.0-my-local-edit"));
        }
      },
    };
    const result = await runForkSync(deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("commit -m "))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.manifests.get("apps/web/package.json")).toBe(manifest("0.0.0-my-local-edit"));
  });

  it("commits only its own paths so a foreign staged change cannot ride along", async () => {
    const harness = createHarness();
    await runForkSync(harness.deps);
    const commit = harness.calls.find((call) => call.startsWith("commit -m "));
    // Pathspec form: git ignores the developer's index for everything else.
    expect(commit).toBe(
      `commit -m chore(fork): pin nightly ${NIGHTLY_VERSION} -- ${PINNED_PACKAGE_FILES.join(" ")}`,
    );
    expect(harness.calls.some((call) => call.startsWith("add -- "))).toBe(false);
  });

  it("pushes the exact verified commit, never the moving main ref", async () => {
    const harness = createHarness();
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(harness.pushedRefs).toEqual([PIN_SHA]);
    expect(harness.calls).not.toContain("push origin main");
  });

  it("merges nothing when someone commits during the upstream fetch", async () => {
    // The fetch can take minutes, so the run re-checks HEAD and the tree right
    // before merging; a commit that landed in that window stops it.
    const harness = createHarness({ headMovesBeforeMerge: DEVELOPER_SHA });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(
      harness.calls.some((call) => call.includes("upstream/main") && call.startsWith("merge")),
    ).toBe(false);
    expect(harness.pushedRefs).toEqual([]);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.some((line) => line.includes("while upstream was fetching"))).toBe(true);
    expectNoDestructiveGit(harness.calls);
  });

  it("merges nothing when the tree goes dirty during the upstream fetch", async () => {
    const harness = createHarness({ dirtyBeforeMerge: true });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(
      harness.calls.some((call) => call.includes("upstream/main") && call.startsWith("merge")),
    ).toBe(false);
    expect(harness.publishRuns.count).toBe(0);
    expectNoDestructiveGit(harness.calls);
  });

  it("pushes nothing when someone commits underneath the run", async () => {
    // HEAD moves after this run made its own commit: that commit is the
    // developer's, so it must stay local.
    const harness = createHarness({ headMovesAfterPin: DEVELOPER_SHA });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.pushedRefs).toEqual([]);
    expect(harness.publishRuns.count).toBe(0);
    expect(harness.logs.some((line) => line.includes("committed underneath the sync"))).toBe(true);
    expectNoDestructiveGit(harness.calls);
  });

  it("leaves a newer conflict marker raised by another machine alone", async () => {
    const harness = createHarness({ marker: true, markerReplacedSha: NEWER_MARKER_SHA });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    expect(
      harness.calls.some((call) => call.startsWith("push origin :refs/heads/needs-merge-help")),
    ).toBe(false);
    expect(harness.logs.some((line) => line.includes("leaving the newer conflict signal up"))).toBe(
      true,
    );
  });

  it("syncs on the marker alone when npm cannot be reached", async () => {
    const harness = createHarness({ marker: true, merge: "up-to-date", nightly: undefined });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "published", exitCode: 0 });
    // No nightly means no pin, exactly like the workflow's pin step.
    expect(harness.calls.some((call) => call.startsWith("commit -m "))).toBe(false);
    expect(
      harness.calls.some((call) =>
        call.startsWith("push origin :refs/heads/needs-merge-help --force-with-lease="),
      ),
    ).toBe(true);
    expect(harness.publishRuns.count).toBe(1);
    expect(harness.logs.some((line) => line.includes("skipping the version pin"))).toBe(true);
  });

  it("reports a failure when the marker branch cannot be cleared", async () => {
    const harness = createHarness({ marker: true, markerClearFails: true });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.pushedRefs.length).toBe(1);
    expect(harness.publishRuns.count).toBe(1);
    expect(harness.logs.some((line) => line.includes("marker is still up"))).toBe(true);
  });

  it("raises the marker for a merge that fails without conflicted files", async () => {
    const harness = createHarness({ merge: "hook-failure" });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "conflict", exitCode: 1 });
    expect(harness.calls).toContain("merge --abort");
    expect(harness.calls).toContain("push origin HEAD:refs/heads/needs-merge-help --force");
    expect(harness.logs.some((line) => line.includes("pre-merge-commit"))).toBe(true);
    expectNoDestructiveGit(harness.calls);
  });

  it("stops before pushing when the upstream remote is missing", async () => {
    const harness = createHarness({ upstreamMissing: true });
    const result = await runForkSync(harness.deps);
    expect(result).toEqual({ outcome: "failed", exitCode: 1 });
    expect(harness.calls.some((call) => call.startsWith("merge "))).toBe(false);
  });

  it("rewrites only the version field of a manifest", () => {
    const original = manifest(PINNED_VERSION);
    const updated = pinManifestText(original, NIGHTLY_VERSION);
    expect(updated).toBe(manifest(NIGHTLY_VERSION));
    expect(pinManifestText(manifest(NIGHTLY_VERSION), NIGHTLY_VERSION)).toBeUndefined();
    expect(Object.keys(JSON.parse(updated ?? "{}") as object)).toEqual([
      "name",
      "version",
      "private",
    ]);
    expect(() => pinManifestText("{oops", NIGHTLY_VERSION)).toThrow(/valid JSON/u);
  });
});

describe("local fork sync lock and log", () => {
  const tempRoot = (): string =>
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-sync-test-"));
  const host = NodeOS.hostname();

  const alive = { isProcessAlive: () => true };

  it("lets only one run hold the lock", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      expect(acquireLock(dir, { host, now, pid: 1234, token: "a", ...alive }).acquired).toBe(true);
      const blocked = acquireLock(dir, { host, now, pid: 5678, token: "b", ...alive });
      expect(blocked.acquired).toBe(false);
      expect(blocked.blockedBy).toContain("pid 1234");
      // The loser cleaned up after itself and left the winner's entry alone.
      expect(NodeFS.readdirSync(dir)).toEqual(["a.json"]);
      releaseLock(dir, "a");
      expect(NodeFS.readdirSync(dir)).toEqual([]);
      expect(acquireLock(dir, { host, now, pid: 5678, token: "b", ...alive }).acquired).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("takes over an entry whose owner died or aged out, never a live one", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      expect(acquireLock(dir, { host, now, pid: 1234, token: "a", ...alive }).acquired).toBe(true);
      expect(
        acquireLock(dir, { host, isProcessAlive: () => false, now, pid: 5678, token: "b" })
          .acquired,
      ).toBe(true);
      expect(NodeFS.readdirSync(dir)).toEqual(["b.json"]);
      // A live owner is never retired early - a publish legitimately takes a while.
      expect(
        acquireLock(dir, { host, now: now + 25 * 60 * 60 * 1000, pid: 9012, token: "c", ...alive })
          .acquired,
      ).toBe(false);
      expect(
        acquireLock(dir, {
          host,
          now: now + 8 * 24 * 60 * 60 * 1000,
          pid: 9012,
          token: "c",
          ...alive,
        }).acquired,
      ).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("never lets two runs win, whatever order they interleave in", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      // Only the pre-existing entry is dead; both contenders are live.
      const dead = { isProcessAlive: (pid: number) => pid !== 1 };
      // A stale entry both contenders will judge dead.
      NodeFS.writeFileSync(
        NodePath.join(dir, "dead.json"),
        JSON.stringify({ host, pid: 1, startedAt: new Date(now).toISOString(), token: "dead" }),
      );
      const first = acquireLock(dir, { host, now, pid: 2, token: "a", ...dead });
      const second = acquireLock(dir, { host, now, pid: 3, token: "b", ...dead });
      expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);
      expect(first.acquired).toBe(true);
      // The winner's entry survived the loser's stale sweep.
      expect(NodeFS.readdirSync(dir)).toEqual(["a.json"]);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("waits out an entry that is still being written rather than deleting it", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      NodeFS.writeFileSync(NodePath.join(dir, "half.json"), "{partial");
      const blocked = acquireLock(dir, {
        host,
        isProcessAlive: () => false,
        now,
        pid: 7,
        token: "a",
      });
      expect(blocked.acquired).toBe(false);
      expect(blocked.blockedBy).toContain("unreadable");
      expect(NodeFS.readdirSync(dir)).toEqual(["half.json"]);
      // Once it is far older than any write could take, it is junk.
      expect(
        acquireLock(dir, {
          host,
          isProcessAlive: () => false,
          now: now + 10 * 60 * 1000,
          pid: 7,
          token: "a",
        }).acquired,
      ).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports an unreadable entry as an error rather than a quiet skip", () => {
    const dir = tempRoot();
    try {
      // A directory named like an entry: readFileSync fails with EISDIR, not
      // ENOENT, which is no evidence that the owner is gone.
      NodeFS.mkdirSync(NodePath.join(dir, "locked.json"));
      NodeFS.writeFileSync(NodePath.join(dir, "locked.json", "child"), "held");
      const blocked = acquireLock(dir, {
        host,
        isProcessAlive: () => false,
        now: Date.now(),
        pid: 11,
        token: "a",
      });
      expect(blocked.acquired).toBe(false);
      // "error" is what makes main() exit non-zero instead of looking healthy.
      expect(blocked.blockedReason).toBe("error");
      expect(blocked.blockedBy).toContain("locked.json");
      expect(NodeFS.existsSync(NodePath.join(dir, "a.json"))).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports an entry it cannot release instead of leaving a silent ghost", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      expect(acquireLock(dir, { host, now, pid: 1, token: "a", ...alive }).acquired).toBe(true);
      // Replace the entry with a non-empty directory of the same name: the
      // non-recursive rmSync then fails deterministically.
      NodeFS.rmSync(NodePath.join(dir, "a.json"));
      NodeFS.mkdirSync(NodePath.join(dir, "a.json"));
      NodeFS.writeFileSync(NodePath.join(dir, "a.json", "child"), "stuck");
      expect(releaseLock(dir, "a")).toBeDefined();
      expect(releaseLock(dir, "never-existed")).toBeUndefined();
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("hands the lock to a publisher it could not kill", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      expect(acquireLock(dir, { host, now, pid: 1, token: "a", ...alive }).acquired).toBe(true);
      adoptLockEntry(dir, "a", 4242, now);
      const record = parseLockRecord(NodeFS.readFileSync(NodePath.join(dir, "a.json"), "utf8"));
      expect(record?.pid).toBe(4242);
      // The next run must stay out while that pid lives, and may take over once
      // it is gone.
      expect(
        acquireLock(dir, { host, now, pid: 2, token: "b", isProcessAlive: (pid) => pid === 4242 })
          .acquired,
      ).toBe(false);
      expect(
        acquireLock(dir, { host, now, pid: 2, token: "b", isProcessAlive: () => false }).acquired,
      ).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("treats any failed taskkill as an unwatchable survivor", () => {
    // Clean kill, root gone: nothing to guard.
    expect(classifyPublisherTermination(0, false)).toEqual({ orphan: false, sticky: false });
    // Clean kill, root still winding down: later runs can wait on that pid.
    expect(classifyPublisherTermination(0, true)).toEqual({ orphan: true, sticky: false });
    // Failed kill: a descendant may have survived, and its pid is not one we can
    // watch - so the barrier must outlive the root either way.
    expect(classifyPublisherTermination(1, false)).toEqual({ orphan: true, sticky: true });
    expect(classifyPublisherTermination(1, true)).toEqual({ orphan: true, sticky: true });
    expect(classifyPublisherTermination(null, true)).toEqual({ orphan: true, sticky: true });
  });

  it("reports a handoff it could not write instead of pretending it locked", () => {
    const dir = tempRoot();
    try {
      // A directory where the entry belongs: the rename over it fails, so the
      // caller learns the barrier was not established.
      NodeFS.mkdirSync(NodePath.join(dir, "a.json"));
      NodeFS.writeFileSync(NodePath.join(dir, "a.json", "child"), "stuck");
      expect(adoptLockEntry(dir, "a", 4242, Date.now(), true)).toBeDefined();
      // A different entry name is a perfectly good barrier and must succeed.
      expect(adoptLockEntry(dir, "b", 4242, Date.now(), true)).toBeUndefined();
      expect(
        parseLockRecord(NodeFS.readFileSync(NodePath.join(dir, "b.json"), "utf8"))?.sticky,
      ).toBe(true);
      // No temp files are left where the scan could see them.
      expect(NodeFS.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps a sticky entry until a human clears it, even though its pid is dead", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      expect(acquireLock(dir, { host, now, pid: 1, token: "a", ...alive }).acquired).toBe(true);
      // A publisher tree this run could not prove it killed: the pid tells us
      // nothing, so a dead pid must not retire the entry.
      adoptLockEntry(dir, "a", 4242, now, true);
      const blocked = acquireLock(dir, {
        host,
        now,
        pid: 2,
        token: "b",
        isProcessAlive: () => false,
      });
      expect(blocked.acquired).toBe(false);
      expect(blocked.blockedReason).toBe("error");
      expect(blocked.blockedBy).toContain("delete a.json");
      // Only the age cap, or the human, clears it.
      expect(
        acquireLock(dir, {
          host,
          now: now + 8 * 24 * 60 * 60 * 1000,
          pid: 2,
          token: "b",
          isProcessAlive: () => false,
        }).acquired,
      ).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("neutralizes the git settings that could stash or push extra work", () => {
    // A real git invocation: -c overrides must reach the child process.
    const runGit = createGitRunner(NodePath.join(import.meta.dirname, ".."));
    expect(GIT_SAFETY_CONFIG).toContain("merge.autoStash=false");
    expect(GIT_SAFETY_CONFIG).toContain("push.followTags=false");
    expect(runGit(["config", "--get", "merge.autoStash"]).stdout.trim()).toBe("false");
    expect(runGit(["config", "--get", "rebase.autoStash"]).stdout.trim()).toBe("false");
    expect(runGit(["config", "--get", "push.followTags"]).stdout.trim()).toBe("false");
  });

  it("reports an ordinary overlap as held, not as an error", () => {
    const dir = tempRoot();
    try {
      const now = Date.now();
      expect(acquireLock(dir, { host, now, pid: 1, token: "a", ...alive }).acquired).toBe(true);
      const blocked = acquireLock(dir, { host, now, pid: 2, token: "b", ...alive });
      expect(blocked.acquired).toBe(false);
      expect(blocked.blockedReason).toBe("held");
    } finally {
      NodeFS.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps a live lock from another machine", () => {
    const record = {
      host: "other-pc",
      pid: 4321,
      startedAt: new Date(1_000).toISOString(),
      sticky: false,
      token: "t",
    };
    expect(isLockStale(record, { host, isProcessAlive: () => false, now: 2_000 })).toBe(false);
    expect(isLockStale(record, { host: "other-pc", isProcessAlive: () => false, now: 2_000 })).toBe(
      true,
    );
    expect(isLockStale(undefined, { host, isProcessAlive: () => true, now: 2_000 })).toBe(true);
    expect(
      isLockStale(
        { host, pid: 1, startedAt: "not a date", sticky: false, token: "t" },
        {
          host,
          isProcessAlive: () => true,
          now: 2_000,
        },
      ),
    ).toBe(true);
    expect(parseLockRecord('{"pid":"x"}')).toBeUndefined();
    expect(parseLockRecord("nonsense")).toBeUndefined();
  });

  it("bounds the log to the most recent runs and byte budget", () => {
    const runs = [1, 2, 3, 4].map((index) => `${RUN_HEADER_PREFIX} ${index} ===\nline ${index}\n`);
    const content = runs.join("");
    expect(trimLogRuns(content, 4, 1_000)).toBe(content);
    expect(trimLogRuns(content, 2, 1_000)).toBe(`${runs[2] ?? ""}${runs[3] ?? ""}`);
    // One oversized run block is still truncated to its tail, so the byte
    // ceiling holds even when the publisher floods the log in a single run.
    const bounded = trimLogRuns(content, 4, 30);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(30);
    expect(bounded.endsWith("line 4\n")).toBe(true);
    expect(trimLogRuns("", 4, 30)).toBe("");
    expect(trimLogRuns("orphan line\n", 4, 1_000)).toBe("orphan line\n");
    expect(Buffer.byteLength(trimLogRuns("x".repeat(5_000), 4, 500), "utf8")).toBeLessThanOrEqual(
      500,
    );
    // Truncating inside a multi-byte character must not decode to replacement
    // characters, which are bigger than the bytes they replace.
    for (const budget of [1, 2, 3, 4, 5]) {
      const clipped = trimLogRuns("😀😀", 4, budget);
      expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(budget);
      expect(clipped.includes("�")).toBe(false);
    }
    expect(formatLogLine("2026-08-25T00:00:00.000Z", "hello")).toBe(
      "[2026-08-25T00:00:00.000Z] hello",
    );
  });
});

describe("scheduled task registration", () => {
  const registrar = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "register-local-fork-sync.cmd"),
    "utf8",
  );
  const schtasksLine = registrar
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("schtasks /create"));

  it("registers the two-hourly task without storing a password", () => {
    expect(schtasksLine).toBeDefined();
    const line = schtasksLine ?? "";
    expect(line).toContain('/tn "%TASK_NAME%"');
    expect(line).toContain("/sc HOURLY /mo 2");
    expect(line).toContain("/rl LIMITED");
    // /it runs it with the logged-on user's own token: no /rp, no /np, no
    // stored credential anywhere.
    expect(line).toContain("/it");
    expect(line).not.toContain("/rp");
    expect(line).not.toContain("/np");
    // /f keeps re-registration idempotent.
    expect(line).toContain("/create /f");
    expect(registrar).toContain('schtasks /delete /tn "%TASK_NAME%" /f');
  });

  it("keeps the schtasks action quoting that Windows actually parses", () => {
    // schtasks parses /tr with C runtime rules, so the inner quotes must be
    // backslash-escaped, and both executables must be absolute.
    expect(schtasksLine).toContain(String.raw`/tr "\"%SHELL_EXE%\" /c \"%SELF%\" --run"`);
    expect(registrar).toContain('set "SHELL_EXE=%SystemRoot%\\System32\\cmd.exe"');
    expect(registrar).toContain('set "SELF=%~f0"');
    // The run branch must hand the sync its --task flag and redirect into the log.
    expect(registrar).toContain(
      '"%NODE_EXE%" "%REPO%\\scripts\\local-fork-sync.ts" --task >>"%LOG%" 2>&1',
    );
    expect(registrar).toContain("where node.exe");
  });
});
