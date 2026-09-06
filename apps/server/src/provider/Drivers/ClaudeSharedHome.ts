import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";

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
  /** The instance's own config directory (CLAUDE_CONFIG_DIR). */
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
    return `Claude shared conversation home '${this.sharedHomePath}' must be different from this instance's CLAUDE_CONFIG_DIR '${this.homePath}'.`;
  }
}

export class ClaudeSharedHomeFileSystemError extends Schema.TaggedErrorClass<ClaudeSharedHomeFileSystemError>()(
  "ClaudeSharedHomeFileSystemError",
  {
    homePath: Schema.String,
    sharedHomePath: Schema.String,
    operation: Schema.Literals([
      "readLink",
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
  | ClaudeSharedHomeFileSystemError;

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: Pick<ClaudeSettings, "homePath" | "sharedHomePath">,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = yield* resolveClaudeHomePath(config);
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

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "EINVAL" || cause.code === "UNKNOWN")
  );
}

/**
 * Links `<home>/projects` to `<shared>/projects`. An account that already has
 * conversations of its own is not silently cut off from them: its project
 * folders are moved into the shared directory first (session files carry
 * unique ids, so entries never collide), then the link replaces the folder.
 */
export const materializeClaudeSharedHome = Effect.fn("materializeClaudeSharedHome")(function* (
  layout: ClaudeHomeLayout,
): Effect.fn.Return<void, ClaudeSharedHomeError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "sharedConversations") return;
  if (layout.conversationHomePath === layout.homePath) {
    return yield* new ClaudeSharedHomePathConflictError({
      homePath: layout.homePath,
      sharedHomePath: layout.conversationHomePath,
    });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail =
    (operation: ClaudeSharedHomeFileSystemError["operation"], target: string) => (cause: unknown) =>
      new ClaudeSharedHomeFileSystemError({
        homePath: layout.homePath,
        sharedHomePath: layout.conversationHomePath,
        operation,
        path: target,
        cause,
      });

  const sharedProjects = path.join(layout.conversationHomePath, CLAUDE_SHARED_ENTRY);
  const link = path.join(layout.homePath, CLAUDE_SHARED_ENTRY);
  yield* fileSystem
    .makeDirectory(sharedProjects, { recursive: true })
    .pipe(Effect.mapError(fail("makeDirectory", sharedProjects)));
  yield* fileSystem
    .makeDirectory(layout.homePath, { recursive: true })
    .pipe(Effect.mapError(fail("makeDirectory", layout.homePath)));

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
    if (path.resolve(path.dirname(link), state.target) === sharedProjects) return;
    yield* fileSystem.remove(link).pipe(Effect.mapError(fail("remove", link)));
  } else if (state._tag === "Directory") {
    // Carry this account's existing conversations into the shared home.
    const projectNames = yield* fileSystem
      .readDirectory(link)
      .pipe(Effect.mapError(fail("readDirectory", link)));
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
        if (taken) continue;
        yield* fileSystem
          .rename(entrySource, entryDestination)
          .pipe(Effect.mapError(fail("rename", entrySource)));
      }
    }
    yield* fileSystem.remove(link, { recursive: true }).pipe(Effect.mapError(fail("remove", link)));
  }

  yield* fileSystem.symlink(sharedProjects, link).pipe(Effect.mapError(fail("symlink", link)));
});
