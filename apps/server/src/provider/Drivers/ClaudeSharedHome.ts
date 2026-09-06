import type { ClaudeSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expandHomePath } from "../../pathExpansion.ts";
import { resolveClaudeConfigDirPath } from "./ClaudeHome.ts";

/**
 * Two Claude accounts continuing one thread (fork feature, 2026-09-06).
 *
 * Claude Code keeps everything under its config directory, and a thread can
 * only be resumed by a process whose config directory holds the transcript
 * (`projects/<cwd>/<session>.jsonl`). Each account needs its own directory
 * for `.credentials.json` and `.claude.json`, so two accounts cannot share
 * one directory the way Codex accounts share a home. The Codex arrangement
 * is mirrored instead: the account keeps its private config directory and
 * only `projects` is a link into a shared account's directory. Resume then
 * finds the transcript from either account, and both instances report the
 * shared directory as their continuation key. Verified against Claude Code
 * 2.1.263: a resumed session answers from the linked transcript's context.
 */
export interface ClaudeHomeLayout {
  readonly mode: "direct" | "sharedConversations";
  /** The instance's own config directory, as the spawned CLI resolves it. */
  readonly homePath: string;
  /** Where `projects` lives; equals homePath in direct mode. */
  readonly conversationHomePath: string;
  readonly continuationKey: string;
}

/** Conversation state that must be visible to every account continuing a thread. */
export const CLAUDE_SHARED_ENTRY = "projects";

export class ClaudeSharedHomePathConflictError extends Schema.TaggedErrorClass<ClaudeSharedHomePathConflictError>()(
  "ClaudeSharedHomePathConflictError",
  { homePath: Schema.String, sharedHomePath: Schema.String },
) {
  override get message(): string {
    return `Claude shared conversation home '${this.sharedHomePath}' is the same directory as this instance's CLAUDE_CONFIG_DIR '${this.homePath}'. Point it at the other account's directory.`;
  }
}

export class ClaudeSharedHomeVolumeError extends Schema.TaggedErrorClass<ClaudeSharedHomeVolumeError>()(
  "ClaudeSharedHomeVolumeError",
  { homePath: Schema.String, sharedHomePath: Schema.String },
) {
  override get message(): string {
    return `Claude shared conversation home '${this.sharedHomePath}' must be on the same drive as '${this.homePath}' so existing conversations can be moved across.`;
  }
}

export class ClaudeSharedHomeFileSystemError extends Schema.TaggedErrorClass<ClaudeSharedHomeFileSystemError>()(
  "ClaudeSharedHomeFileSystemError",
  {
    homePath: Schema.String,
    sharedHomePath: Schema.String,
    operation: Schema.Literals([
      "readLink",
      "realPath",
      "makeDirectory",
      "readDirectory",
      "rename",
      "remove",
      "symlink",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not prepare the Claude shared conversation home (${this.operation} ${this.path}).`;
  }
}

export type ClaudeSharedHomeError =
  | ClaudeSharedHomePathConflictError
  | ClaudeSharedHomeVolumeError
  | ClaudeSharedHomeFileSystemError;

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: Pick<ClaudeSettings, "homePath" | "sharedHomePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = yield* resolveClaudeConfigDirPath(config, environment);
  const shared = config.sharedHomePath.trim();
  if (shared.length === 0) {
    return {
      mode: "direct",
      homePath,
      conversationHomePath: homePath,
      continuationKey: `claude:home:${homePath}`,
    };
  }
  const conversationHomePath = path.resolve(expandHomePath(shared));
  return {
    mode: "sharedConversations",
    homePath,
    conversationHomePath,
    continuationKey: `claude:home:${conversationHomePath}`,
  };
});

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Symlink"; readonly target: string }
  | { readonly _tag: "Directory" };

/** `readlink` on a real directory: EINVAL on every platform Node supports. */
function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

/** Windows paths differ only by case for the same directory. */
function samePathOn(platform: NodeJS.Platform) {
  return (left: string, right: string): boolean =>
    platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Links `<home>/projects` to `<shared>/projects`. An account that already has
 * conversations of its own is not cut off from them: its project folders are
 * moved into the shared directory first. Session transcripts carry unique
 * ids, but a project folder also holds non-unique entries (auto-memory,
 * checkpoints), so anything that would overwrite a shared entry is left
 * behind and the remainder is set aside as `projects.migrated-<time>` rather
 * than deleted. Nothing of the user's is ever removed.
 */
export const materializeClaudeSharedHome = Effect.fn("materializeClaudeSharedHome")(function* (
  layout: ClaudeHomeLayout,
): Effect.fn.Return<void, ClaudeSharedHomeError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "sharedConversations") return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const samePath = samePathOn(yield* HostProcessPlatform);
  const fail =
    (operation: ClaudeSharedHomeFileSystemError["operation"], target: string) => (cause: unknown) =>
      new ClaudeSharedHomeFileSystemError({
        homePath: layout.homePath,
        sharedHomePath: layout.conversationHomePath,
        operation,
        path: target,
        cause,
      });
  const conflict = new ClaudeSharedHomePathConflictError({
    homePath: layout.homePath,
    sharedHomePath: layout.conversationHomePath,
  });
  if (samePath(layout.conversationHomePath, layout.homePath)) {
    return yield* conflict;
  }
  if (
    samePath(path.parse(layout.conversationHomePath).root, path.parse(layout.homePath).root) ===
    false
  ) {
    return yield* new ClaudeSharedHomeVolumeError({
      homePath: layout.homePath,
      sharedHomePath: layout.conversationHomePath,
    });
  }

  // Only the two base directories exist before the real-path comparison; a
  // case variant or a junction to the same place must not pass the guard, and
  // nothing may be created inside either until it has.
  yield* fileSystem
    .makeDirectory(layout.homePath, { recursive: true })
    .pipe(Effect.mapError(fail("makeDirectory", layout.homePath)));
  yield* fileSystem
    .makeDirectory(layout.conversationHomePath, { recursive: true })
    .pipe(Effect.mapError(fail("makeDirectory", layout.conversationHomePath)));
  const [realHome, realShared] = yield* Effect.all([
    fileSystem.realPath(layout.homePath).pipe(Effect.mapError(fail("realPath", layout.homePath))),
    fileSystem
      .realPath(layout.conversationHomePath)
      .pipe(Effect.mapError(fail("realPath", layout.conversationHomePath))),
  ]);
  if (samePath(realHome, realShared)) {
    return yield* conflict;
  }

  const sharedProjects = path.join(layout.conversationHomePath, CLAUDE_SHARED_ENTRY);
  const link = path.join(layout.homePath, CLAUDE_SHARED_ENTRY);
  yield* fileSystem
    .makeDirectory(sharedProjects, { recursive: true })
    .pipe(Effect.mapError(fail("makeDirectory", sharedProjects)));

  const state: LinkState = yield* fileSystem.readLink(link).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<LinkState>({ _tag: "Missing" })
          : isNotSymlinkError(cause)
            ? Effect.succeed<LinkState>({ _tag: "Directory" })
            : Effect.fail(fail("readLink", link)(cause)),
    }),
  );

  if (state._tag === "Symlink") {
    if (samePath(path.resolve(path.dirname(link), state.target), sharedProjects)) return;
    yield* fileSystem.remove(link).pipe(Effect.mapError(fail("remove", link)));
  } else if (state._tag === "Directory") {
    const realLink = yield* fileSystem.realPath(link).pipe(Effect.mapError(fail("realPath", link)));
    const realSharedProjects = yield* fileSystem
      .realPath(sharedProjects)
      .pipe(Effect.mapError(fail("realPath", sharedProjects)));
    if (samePath(realLink, realSharedProjects)) {
      return yield* conflict;
    }
    // Carry this account's existing conversations into the shared home.
    const projectNames = yield* fileSystem
      .readDirectory(link)
      .pipe(Effect.mapError(fail("readDirectory", link)));
    let leftBehind = false;
    for (const projectName of projectNames) {
      const source = path.join(link, projectName);
      const destination = path.join(sharedProjects, projectName);
      const destinationExists = yield* fileSystem
        .exists(destination)
        .pipe(Effect.mapError(fail("readDirectory", destination)));
      if (!destinationExists) {
        yield* fileSystem.rename(source, destination).pipe(Effect.mapError(fail("rename", source)));
        continue;
      }
      const entries = yield* fileSystem
        .readDirectory(source)
        .pipe(Effect.mapError(fail("readDirectory", source)));
      for (const entry of entries) {
        const entrySource = path.join(source, entry);
        const entryDestination = path.join(destination, entry);
        const taken = yield* fileSystem
          .exists(entryDestination)
          .pipe(Effect.mapError(fail("readDirectory", entryDestination)));
        if (taken) {
          leftBehind = true;
          continue;
        }
        yield* fileSystem
          .rename(entrySource, entryDestination)
          .pipe(Effect.mapError(fail("rename", entrySource)));
      }
      if (!leftBehind) {
        yield* fileSystem
          .remove(source, { recursive: true })
          .pipe(Effect.mapError(fail("remove", source)));
      }
    }
    if (leftBehind) {
      const now = yield* DateTime.now;
      const aside = `${link}.migrated-${DateTime.formatIso(now).replace(/[:.]/g, "-")}`;
      yield* fileSystem.rename(link, aside).pipe(Effect.mapError(fail("rename", link)));
    } else {
      yield* fileSystem
        .remove(link, { recursive: true })
        .pipe(Effect.mapError(fail("remove", link)));
    }
  }

  yield* fileSystem.symlink(sharedProjects, link).pipe(Effect.mapError(fail("symlink", link)));
});
