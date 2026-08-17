#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- This standalone bootstrap must run before workspace dependencies are installed.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const PERSONAL_REPOSITORY = "Simcity400/t3code-personal";
const DESKTOP_PUBLIC_ENV = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsudDMuY29kZXMk",
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "hzxSgY2cH10sDU2r",
  T3CODE_RELAY_URL: "https://relay.t3.codes",
  T3CODE_DESKTOP_UPDATE_PRIVATE: "true",
  T3CODE_DESKTOP_UPDATE_REPOSITORY: PERSONAL_REPOSITORY,
} as const;

export interface PublishSelection {
  readonly desktop: boolean;
  readonly iphone: boolean;
}

export interface LocalReleaseMetadata {
  readonly date: string;
  readonly name: string;
  readonly runNumber: number;
  readonly tag: string;
  readonly version: string;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly quiet?: boolean;
}

function runCommand(command: string, args: ReadonlyArray<string>, options: CommandOptions): void {
  if (!options.quiet) {
    console.log(`> ${command} ${args.join(" ")}`);
  }
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}.`);
  }
}

function captureCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions,
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "pipe" : "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      `${command} exited with code ${result.status ?? "unknown"}${stderr ? `: ${stderr}` : ""}.`,
    );
  }
  return result.stdout.trim();
}

function assertFile(filePath: string, label: string): void {
  if (!NodeFS.existsSync(filePath) || !NodeFS.statSync(filePath).isFile()) {
    throw new Error(`${label} was not found at ${filePath}.`);
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${filePath}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${key} in ${source}.`);
  }
  return value;
}

export function parsePublishSelection(args: ReadonlyArray<string>): PublishSelection {
  const allowed = new Set(["--desktop-only", "--iphone-only"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`Unknown option '${arg}'. Use --desktop-only or --iphone-only.`);
    }
  }
  if (args.includes("--desktop-only") && args.includes("--iphone-only")) {
    throw new Error("Choose either --desktop-only or --iphone-only, not both.");
  }
  if (args.includes("--desktop-only")) return { desktop: true, iphone: false };
  if (args.includes("--iphone-only")) return { desktop: false, iphone: true };
  return { desktop: true, iphone: true };
}

export function parseGitCommitCount(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Invalid Git commit count '${value}'.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Invalid Git commit count '${value}'.`);
  }
  return count;
}

export function deriveLocalRunNumber(committedAt: string, commitCount: number): number {
  const committedDate = new Date(committedAt);
  if (Number.isNaN(committedDate.getTime())) {
    throw new Error(`Invalid commit date '${committedAt}'.`);
  }
  const runNumber = Math.floor(committedDate.getTime() / 1000) * 1_000_000 + commitCount;
  if (!Number.isSafeInteger(runNumber)) {
    throw new Error(`Commit date '${committedAt}' is outside the supported release range.`);
  }
  return runNumber;
}

export function deriveLocalReleaseMetadata(
  desktopVersion: string,
  sha: string,
  committedAt: string,
  commitCount: number,
): LocalReleaseMetadata {
  const stableVersion = desktopVersion.replace(/[-+].*$/u, "");
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(stableVersion);
  if (!match) {
    throw new Error(`Invalid desktop version '${desktopVersion}'.`);
  }
  const committedDate = new Date(committedAt);
  if (Number.isNaN(committedDate.getTime())) {
    throw new Error(`Invalid commit date '${committedAt}'.`);
  }
  const date = committedDate.toISOString().slice(0, 10).replaceAll("-", "");
  const runNumber = deriveLocalRunNumber(committedAt, commitCount);
  const baseVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  const version = `${baseVersion}-nightly.${date}.${runNumber}`;
  return {
    date,
    runNumber,
    version,
    tag: `v${version}`,
    name: `T3 Code Nightly ${version} (${sha.slice(0, 12)})`,
  };
}

export function parseJsonOutput(output: string): unknown {
  const candidates = [output.indexOf("{"), output.indexOf("[")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  for (const start of candidates) {
    const candidate = output.slice(start).trim();
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next JSON container in output containing CLI notices.
    }
  }
  throw new Error("Command output did not contain valid JSON.");
}

export function hasCompleteDesktopReleaseAssets(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const assets = (value as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return false;
  const names = assets.flatMap((asset) => {
    if (typeof asset !== "object" || asset === null || Array.isArray(asset)) return [];
    const name = (asset as Record<string, unknown>).name;
    return typeof name === "string" ? [name] : [];
  });
  return (
    names.some((name) => name.endsWith(".exe")) &&
    names.some((name) => name.endsWith(".blockmap")) &&
    names.includes("nightly.yml") &&
    names.includes("latest.yml")
  );
}

function readDesktopRelease(tag: string, repoRoot: string): unknown | undefined {
  const result = NodeChildProcess.spawnSync(
    "gh.exe",
    ["release", "view", tag, "--repo", PERSONAL_REPOSITORY, "--json", "assets"],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return parseJsonOutput(result.stdout);
  const stderr = result.stderr.trim();
  if (/release not found|not found.*release/iu.test(stderr)) return undefined;
  throw new Error(`Unable to inspect desktop release ${tag}${stderr ? `: ${stderr}` : "."}`);
}

export function assertLinuxX64Elf(binary: Buffer): void {
  const validMagic =
    binary.length >= 20 &&
    binary[0] === 0x7f &&
    binary[1] === 0x45 &&
    binary[2] === 0x4c &&
    binary[3] === 0x46;
  const is64BitLittleEndian = binary[4] === 2 && binary[5] === 1;
  const isX64 = binary.length >= 20 && binary.readUInt16LE(18) === 62;
  if (!validMagic || !is64BitLittleEndian || !isX64) {
    throw new Error("The installed WSL node-pty seed is not a Linux x64 ELF binary.");
  }
}

function resolveInstalledDesktopResources(): {
  readonly linuxPtyPath: string;
  readonly windowsPtyPath: string;
} {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not available.");
  }
  const resources = NodePath.join(localAppData, "Programs", "t3code", "resources");
  const installedNodePtyRoot = NodePath.join(
    resources,
    "server.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  const linuxPtyPath = NodePath.join(installedNodePtyRoot, "linux-x64", "pty.node");
  const windowsPtyPath = NodePath.join(installedNodePtyRoot, "win32-x64", "pty.node");
  assertFile(linuxPtyPath, "Installed T3 Code WSL node-pty seed");
  assertFile(windowsPtyPath, "Installed T3 Code Windows node-pty prebuild");
  assertLinuxX64Elf(NodeFS.readFileSync(linuxPtyPath));
  return { linuxPtyPath, windowsPtyPath };
}

function assertInstalledNodePtyPackageMatches(
  releaseRoot: string,
  installedWindowsPtyPath: string,
): void {
  const sourceManifestPath = NodePath.join(
    releaseRoot,
    "apps",
    "server",
    "node_modules",
    "node-pty",
    "package.json",
  );
  assertFile(sourceManifestPath, "Release node-pty manifest");
  const sourceVersion = requiredString(
    readJsonRecord(sourceManifestPath),
    "version",
    sourceManifestPath,
  );
  const sourceWindowsPtyPath = NodePath.join(
    releaseRoot,
    "apps",
    "server",
    "node_modules",
    "node-pty",
    "prebuilds",
    "win32-x64",
    "pty.node",
  );
  assertFile(sourceWindowsPtyPath, "Release Windows node-pty prebuild");
  const installedHash = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(installedWindowsPtyPath))
    .digest("hex");
  const sourceHash = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(sourceWindowsPtyPath))
    .digest("hex");
  if (installedHash !== sourceHash) {
    throw new Error(
      `Installed node-pty does not match source version ${sourceVersion}. ` +
        "Install a compatible T3 Code build before publishing.",
    );
  }
  console.log(`Verified reusable Linux node-pty belongs to source package ${sourceVersion}.`);
}

function collectDesktopReleaseAssets(releaseRoot: string): ReadonlyArray<string> {
  const releaseDir = NodePath.join(releaseRoot, "release");
  const publishDir = NodePath.join(releaseRoot, "release-publish");
  NodeFS.rmSync(publishDir, { recursive: true, force: true });
  NodeFS.mkdirSync(publishDir, { recursive: true });
  const assets = NodeFS.readdirSync(releaseDir)
    .filter((name) => name.endsWith(".exe") || name.endsWith(".blockmap") || name.endsWith(".yml"))
    .map((name) => {
      const destination = NodePath.join(publishDir, name);
      NodeFS.copyFileSync(NodePath.join(releaseDir, name), destination);
      return destination;
    });
  const nightlyManifest = NodePath.join(publishDir, "nightly.yml");
  assertFile(nightlyManifest, "nightly.yml updater manifest");
  const latestManifest = NodePath.join(publishDir, "latest.yml");
  NodeFS.copyFileSync(nightlyManifest, latestManifest);
  const withLatest = assets.includes(latestManifest) ? assets : [...assets, latestManifest];
  if (!withLatest.some((asset) => asset.endsWith(".exe"))) {
    throw new Error("The desktop build did not produce a Windows installer.");
  }
  return withLatest;
}

function publishDesktop(input: {
  readonly releaseExists: boolean;
  readonly linuxPtyPath: string;
  readonly metadata: LocalReleaseMetadata;
  readonly releaseRoot: string;
  readonly sha: string;
  readonly vpPath: string;
}): void {
  runCommand(
    process.execPath,
    [
      NodePath.join(input.releaseRoot, "scripts", "update-release-package-versions.ts"),
      input.metadata.version,
    ],
    { cwd: input.releaseRoot },
  );
  runCommand(
    input.vpPath,
    [
      "run",
      "dist:desktop:artifact",
      "--platform",
      "win",
      "--target",
      "nsis",
      "--arch",
      "x64",
      "--build-version",
      input.metadata.version,
      "--wsl-prebuild",
      input.linuxPtyPath,
      "--verbose",
    ],
    { cwd: input.releaseRoot, env: { ...process.env, ...DESKTOP_PUBLIC_ENV } },
  );
  const assets = collectDesktopReleaseAssets(input.releaseRoot);
  if (input.releaseExists) {
    runCommand(
      "gh.exe",
      [
        "release",
        "upload",
        input.metadata.tag,
        "--repo",
        PERSONAL_REPOSITORY,
        "--clobber",
        ...assets,
      ],
      { cwd: input.releaseRoot },
    );
  } else {
    runCommand(
      "gh.exe",
      [
        "release",
        "create",
        input.metadata.tag,
        "--repo",
        PERSONAL_REPOSITORY,
        "--target",
        input.sha,
        "--title",
        input.metadata.name,
        "--notes",
        `Personal T3 Code local release for ${input.sha.slice(0, 12)}.`,
        "--prerelease",
        "--latest=false",
        ...assets,
      ],
      { cwd: input.releaseRoot },
    );
  }
  console.log(`Published desktop release ${input.metadata.tag}.`);
}

function easCommand(releaseRoot: string, args: ReadonlyArray<string>, capture = false): string {
  const cwd = NodePath.join(releaseRoot, "apps", "mobile");
  const env = {
    ...process.env,
    APP_VARIANT: "preview",
    MOBILE_VERSION_POLICY: "fingerprint",
    NODE_OPTIONS: "--max-old-space-size=8192",
  };
  const fullArgs = ["--yes", "eas-cli@latest", ...args];
  if (capture) {
    return captureCommand("npx.cmd", fullArgs, { cwd, env, quiet: true });
  }
  runCommand("npx.cmd", fullArgs, { cwd, env });
  return "";
}

function publishIphone(releaseRoot: string, sha: string): boolean {
  try {
    easCommand(releaseRoot, ["whoami"]);
  } catch {
    console.log("Expo login is required once on this PC.");
    easCommand(releaseRoot, ["login"]);
    easCommand(releaseRoot, ["whoami"]);
  }
  easCommand(releaseRoot, ["env:pull", "preview", "--non-interactive"]);
  const fingerprintValue = parseJsonOutput(
    easCommand(
      releaseRoot,
      [
        "fingerprint:generate",
        "--platform",
        "ios",
        "--environment",
        "preview",
        "--json",
        "--non-interactive",
      ],
      true,
    ),
  );
  const fingerprintCandidate =
    typeof fingerprintValue === "object" && fingerprintValue !== null
      ? (fingerprintValue as Record<string, unknown>).hash
      : undefined;
  if (
    typeof fingerprintValue !== "object" ||
    fingerprintValue === null ||
    Array.isArray(fingerprintValue) ||
    typeof fingerprintCandidate !== "string"
  ) {
    throw new Error("EAS did not return a valid iPhone fingerprint.");
  }
  const fingerprint = fingerprintCandidate;
  const buildsValue = parseJsonOutput(
    easCommand(
      releaseRoot,
      [
        "build:list",
        "--platform",
        "ios",
        "--build-profile",
        "preview",
        "--status",
        "finished",
        "--fingerprint-hash",
        fingerprint,
        "--limit",
        "1",
        "--json",
        "--non-interactive",
      ],
      true,
    ),
  );
  if (!Array.isArray(buildsValue)) {
    throw new Error("EAS did not return a valid iPhone build list.");
  }
  const builtNewApp = buildsValue.length === 0;
  if (builtNewApp) {
    console.log(`No compatible iPhone build exists for ${fingerprint}; building one now.`);
    easCommand(releaseRoot, [
      "build",
      "--platform",
      "ios",
      "--profile",
      "preview",
      "--non-interactive",
    ]);
  }
  const subject = captureCommand("git.exe", ["log", "-1", "--pretty=%s"], {
    cwd: releaseRoot,
    quiet: true,
  }).slice(0, 120);
  easCommand(releaseRoot, [
    "update",
    "--channel",
    "preview",
    "--environment",
    "preview",
    "--platform",
    "ios",
    "--message",
    `${subject} (${sha.slice(0, 9)})`,
    "--non-interactive",
  ]);
  console.log(`Published the iPhone preview update for ${sha.slice(0, 12)}.`);
  return builtNewApp;
}

function removeReleaseWorktree(repoRoot: string, releaseRoot: string): void {
  const remove = NodeChildProcess.spawnSync(
    "git.exe",
    ["worktree", "remove", "--force", releaseRoot],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (remove.status !== 0 || NodeFS.existsSync(releaseRoot)) {
    NodeFS.rmSync(NodePath.toNamespacedPath(releaseRoot), { recursive: true, force: true });
  }
  runCommand("git.exe", ["worktree", "prune"], { cwd: repoRoot, quiet: true });
}

async function main(): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone publisher runs before the Effect workspace is installed.
  if (process.platform !== "win32") {
    throw new Error("The personal local publisher currently supports Windows only.");
  }
  const selection = parsePublishSelection(process.argv.slice(2));
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const branch = captureCommand("git.exe", ["branch", "--show-current"], {
    cwd: repoRoot,
    quiet: true,
  });
  if (branch !== "main") {
    throw new Error(`Publish from main, not '${branch || "detached HEAD"}'.`);
  }
  const trackedStatus = captureCommand(
    "git.exe",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: repoRoot, quiet: true },
  );
  if (trackedStatus.length > 0) {
    throw new Error("Tracked files are modified. Commit or restore them before publishing.");
  }
  runCommand("gh.exe", ["auth", "status", "--hostname", "github.com"], {
    cwd: repoRoot,
    quiet: true,
  });
  runCommand("git.exe", ["fetch", "origin", "main", "--tags"], { cwd: repoRoot });
  const sha = captureCommand("git.exe", ["rev-parse", "HEAD"], { cwd: repoRoot, quiet: true });
  const originSha = captureCommand("git.exe", ["rev-parse", "origin/main"], {
    cwd: repoRoot,
    quiet: true,
  });
  if (sha !== originSha) {
    throw new Error("Local main does not match origin/main. Push or pull before publishing.");
  }
  const desktopManifestPath = NodePath.join(repoRoot, "apps", "desktop", "package.json");
  const desktopVersion = requiredString(
    readJsonRecord(desktopManifestPath),
    "version",
    desktopManifestPath,
  );
  const committedAt = captureCommand("git.exe", ["show", "-s", "--format=%cI", sha], {
    cwd: repoRoot,
    quiet: true,
  });
  const commitCount = parseGitCommitCount(
    captureCommand("git.exe", ["rev-list", "--count", sha], { cwd: repoRoot, quiet: true }),
  );
  const metadata = deriveLocalReleaseMetadata(desktopVersion, sha, committedAt, commitCount);
  let desktopAlreadyPublished = false;
  let desktopReleaseExists = false;
  if (selection.desktop) {
    const existingTag = captureCommand("git.exe", ["tag", "--list", metadata.tag], {
      cwd: repoRoot,
      quiet: true,
    });
    if (existingTag === metadata.tag) {
      const taggedSha = captureCommand("git.exe", ["rev-parse", `${metadata.tag}^{commit}`], {
        cwd: repoRoot,
        quiet: true,
      });
      if (taggedSha !== sha) {
        throw new Error(`Release tag ${metadata.tag} already points to another commit.`);
      }
      const release = readDesktopRelease(metadata.tag, repoRoot);
      desktopReleaseExists = release !== undefined;
      if (hasCompleteDesktopReleaseAssets(release)) {
        console.log(`Desktop commit is already published as ${metadata.tag}.`);
        desktopAlreadyPublished = true;
        if (!selection.iphone) return;
      } else {
        console.log(`Desktop release ${metadata.tag} is incomplete; rebuilding its assets.`);
      }
    }
  }

  const releaseRoot = NodePath.join(NodeOS.tmpdir(), `t3r-${process.pid}-${sha.slice(0, 8)}`);
  if (NodeFS.existsSync(releaseRoot)) {
    NodeFS.rmSync(NodePath.toNamespacedPath(releaseRoot), { recursive: true, force: true });
  }
  let builtNewIphoneApp = false;
  try {
    runCommand("git.exe", ["worktree", "add", "--detach", releaseRoot, sha], { cwd: repoRoot });
    runCommand("corepack.cmd", ["pnpm", "install", "--frozen-lockfile"], {
      cwd: releaseRoot,
    });
    const vpPath = NodePath.join(releaseRoot, "node_modules", ".bin", "vp.CMD");
    assertFile(vpPath, "Vite+ executable");

    if (selection.iphone) {
      builtNewIphoneApp = publishIphone(releaseRoot, sha);
    }
    if (selection.desktop && !desktopAlreadyPublished) {
      const installed = resolveInstalledDesktopResources();
      assertInstalledNodePtyPackageMatches(releaseRoot, installed.windowsPtyPath);
      console.log(
        `Using installed Linux node-pty seed ${NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(installed.linuxPtyPath))
          .digest("hex")}.`,
      );
      publishDesktop({
        linuxPtyPath: installed.linuxPtyPath,
        metadata,
        releaseExists: desktopReleaseExists,
        releaseRoot,
        sha,
        vpPath,
      });
    }
  } finally {
    removeReleaseWorktree(repoRoot, releaseRoot);
  }
  if (builtNewIphoneApp) {
    console.log("");
    console.log("IMPORTANT: A new iPhone app was built for this update.");
    console.log("Open the EAS install link shown above and install that build once on your phone.");
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
