// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - CI bootstrap runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface Release {
  tag_name: string;
  target_commitish: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets?: ReadonlyArray<{ name: string; size: number }>;
}
const nightlyTag = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const forkWorkflows = new Set([
  "fork-sync.yml",
  "fork-release.yml",
  "fork-mobile-preview.yml",
  "fork-checks.yml",
]);
// No parameter properties: CI runs this file through Node type stripping.
export class NightlyMergeConflict extends Error {
  readonly tag: string;
  readonly conflicts: ReadonlyArray<string>;
  constructor(tag: string, conflicts: ReadonlyArray<string>) {
    super(`Official ${tag} needs a merge review:\n${conflicts.join("\n")}`);
    this.tag = tag;
    this.conflicts = conflicts;
  }
}

export function latestNightly(releases: ReadonlyArray<Release>): Release {
  const release = releases
    .filter((r) => !r.draft && r.prerelease && nightlyTag.test(r.tag_name))
    .toSorted((a, b) => b.published_at.localeCompare(a.published_at))[0];
  if (!release) throw new Error("No published official nightly was found.");
  return release;
}

export function hasDesktopAssets(release: Pick<Release, "tag_name" | "assets">): boolean {
  if (!nightlyTag.test(release.tag_name)) return false;
  const prefix = "T3-Code-" + release.tag_name.slice(1);
  const required = [
    "latest.yml",
    "nightly.yml",
    ...["x64", "arm64"].flatMap((arch) => [
      prefix + "-" + arch + ".exe",
      prefix + "-" + arch + ".exe.blockmap",
    ]),
  ];
  return required.every((name) =>
    release.assets?.some((asset) => asset.name === name && asset.size > 0),
  );
}

export function planSync(tag: string, trackedTag: string, releaseNeeded: boolean) {
  const sync = tag !== trackedTag;
  return { sync, release: sync || releaseNeeded };
}

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Match the release workflow's Markdown-only exclusion, including recovery. */
export function hasReleaseChanges(
  cwd: string,
  published: string | undefined,
  main: string,
): boolean {
  if (!published || !/^[a-f0-9]{40}$/.test(published)) return true;
  if (published === main) return false;
  const available = NodeChildProcess.spawnSync("git", ["cat-file", "-e", published + "^{commit}"], {
    cwd,
    stdio: "ignore",
  });
  if (available.status !== 0) git(cwd, "fetch", "--no-tags", "--depth=1", "origin", published);
  return git(cwd, "diff", "--name-only", "-z", published, main)
    .split("\0")
    .some((path) => path !== "" && !path.endsWith(".md"));
}

/** Runs only in the clean CI checkout; real code conflicts remain unresolved. */
export function syncNightly(cwd: string, upstream: string, tag: string): string {
  if (!nightlyTag.test(tag)) throw new Error("Invalid official nightly tag.");
  if (git(cwd, "status", "--porcelain")) throw new Error("Nightly sync requires a clean checkout.");
  git(cwd, "fetch", "--no-tags", upstream, `refs/tags/${tag}`);
  const commit = git(cwd, "rev-parse", "FETCH_HEAD^{commit}");
  try {
    const merge = NodeChildProcess.spawnSync(
      "git",
      ["merge", "--no-commit", "--no-ff", "--no-edit", commit],
      {
        cwd,
        encoding: "utf8",
      },
    );
    if (merge.error) throw merge.error;
    // Upstream CI uses its own runners and secrets. Keep its workflow removal
    // inside the merge commit, so the push does not modify workflow files.
    const workflows = git(cwd, "ls-files", "-z", ".github/workflows").split("\0").filter(Boolean);
    for (const path of new Set(workflows)) {
      const name = path.slice(".github/workflows/".length);
      if (!forkWorkflows.has(name)) git(cwd, "rm", "-f", "--ignore-unmatch", "--", path);
    }
    const conflicts = git(cwd, "diff", "--name-only", "--diff-filter=U");
    if (conflicts) throw new NightlyMergeConflict(tag, conflicts.split("\n"));
    const pendingMerge =
      NodeChildProcess.spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        cwd,
        stdio: "ignore",
      }).status === 0;
    if (merge.status !== 0 && !pendingMerge)
      throw new Error(merge.stderr || "Git could not merge the nightly.");
    const changedWorkflows = git(
      cwd,
      "diff",
      "--cached",
      "--name-only",
      "HEAD",
      "--",
      ".github/workflows",
    );
    if (changedWorkflows)
      throw new Error(`The sync would change fork workflows:\n${changedWorkflows}`);
    NodeFS.writeFileSync(
      NodePath.join(cwd, "fork-upstream.json"),
      JSON.stringify({ tag, commit }, null, 2) + "\n",
    );
    git(cwd, "add", "fork-upstream.json");
    if (pendingMerge || git(cwd, "diff", "--cached", "--name-only"))
      git(cwd, "commit", "-m", `chore(fork): sync ${tag}`);
    return git(cwd, "rev-parse", "HEAD");
  } catch (error) {
    NodeChildProcess.spawnSync("git", ["merge", "--abort"], { cwd, stdio: "ignore" });
    throw error;
  }
}

function output(name: string, value: string | boolean) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("This command requires GITHUB_OUTPUT.");
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (import.meta.main) {
  const cwd = process.cwd();
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Missing fork repository.");
  if (process.argv[2] === "check") {
    const releases = (repository: string): Release[] =>
      JSON.parse(
        NodeChildProcess.execFileSync("gh", ["api", `repos/${repository}/releases?per_page=30`], {
          encoding: "utf8",
        }),
      );
    const upstream = latestNightly(releases("pingdotgg/t3code"));
    const tracked = JSON.parse(
      NodeFS.readFileSync(NodePath.join(cwd, "fork-upstream.json"), "utf8"),
    ) as {
      tag: string;
    };
    const published = releases(repo)
      .filter((r) => !r.draft && r.prerelease && nightlyTag.test(r.tag_name))
      .toSorted((a, b) => b.published_at.localeCompare(a.published_at))[0];
    const plan = planSync(
      upstream.tag_name,
      tracked.tag,
      !published ||
        !hasDesktopAssets(published) ||
        hasReleaseChanges(cwd, published.target_commitish, git(cwd, "rev-parse", "HEAD")),
    );
    output("ref", git(cwd, "rev-parse", "HEAD"));
    output("tag", upstream.tag_name);
    output("sync", plan.sync);
    output("release", plan.release);
    console.log(
      `Official nightly: ${upstream.tag_name}; integrated: ${tracked.tag}; sync: ${plan.sync}; publish: ${plan.release}`,
    );
  } else if (process.argv[2] === "merge") {
    output(
      "ref",
      syncNightly(cwd, "https://github.com/pingdotgg/t3code.git", process.env.NIGHTLY_TAG ?? ""),
    );
  } else if (process.argv[2] === "verify-release") {
    const id = process.env.RELEASE_ID;
    if (!id || !/^\d+$/.test(id)) throw new Error("Missing release ID.");
    const release = JSON.parse(
      NodeChildProcess.execFileSync("gh", ["api", "repos/" + repo + "/releases/" + id], {
        encoding: "utf8",
      }),
    ) as Release;
    if (!hasDesktopAssets(release))
      throw new Error(
        "The draft release is missing a Windows installer, blockmap or update manifest.",
      );
  } else throw new Error("Expected check, merge or verify-release.");
}
