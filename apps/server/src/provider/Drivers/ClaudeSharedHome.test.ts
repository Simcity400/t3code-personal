import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
import { materializeClaudeSharedHome, resolveClaudeHomeLayout } from "./ClaudeSharedHome.ts";

const makeTempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

it.layer(NodeServices.layer)("ClaudeSharedHome", (it) => {
  describe("resolveClaudeHomeLayout", () => {
    it.effect("keys continuation to the instance's own directory without a shared home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const layout = yield* resolveClaudeHomeLayout({
          homePath: "~/.claude-work",
          sharedHomePath: "",
        });
        const resolved = path.resolve(
          process.env.HOME ?? process.env.USERPROFILE ?? "",
          ".claude-work",
        );
        expect(layout.mode).toBe("direct");
        expect(layout.conversationHomePath).toBe(layout.homePath);
        expect(layout.continuationKey).toBe(`claude:home:${resolved}`);
      }),
    );

    it.effect("pairs the default instance with one that shares ~/.claude", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude");
        const work = yield* resolveClaudeHomeLayout({ homePath: "", sharedHomePath: "" }, {});
        const personal = yield* resolveClaudeHomeLayout(
          { homePath: "~/.claude_personal", sharedHomePath: "~/.claude" },
          {},
        );
        expect(work.homePath).toBe(home);
        expect(work.continuationKey).toBe(personal.continuationKey);
        // Never the OS home directory: linking ~/projects would be a disaster.
        expect(work.homePath).not.toBe(
          path.resolve(process.env.HOME ?? process.env.USERPROFILE ?? ""),
        );
      }),
    );

    it.effect("keys both accounts to the shared conversation home", () =>
      Effect.gen(function* () {
        const layout = yield* resolveClaudeHomeLayout({
          homePath: "~/.claude-personal",
          sharedHomePath: "~/.claude",
        });
        expect(layout.mode).toBe("sharedConversations");
        expect(layout.continuationKey).toBe(
          yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude", sharedHomePath: "" }),
        );
        expect(
          yield* makeClaudeContinuationGroupKey({
            homePath: "~/.claude-personal",
            sharedHomePath: "~/.claude",
          }),
        ).toBe(layout.continuationKey);
      }),
    );
  });

  describe("materializeClaudeSharedHome", () => {
    it.effect("leaves a direct layout untouched", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeTempDirectory("t3-claude-direct-");
        yield* materializeClaudeSharedHome({
          mode: "direct",
          homePath: home,
          conversationHomePath: home,
          continuationKey: `claude:home:${home}`,
        });
        expect(yield* fileSystem.exists(`${home}/projects`)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a shared home that is the instance's own directory", () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectory("t3-claude-conflict-");
        const result = yield* materializeClaudeSharedHome({
          mode: "sharedConversations",
          homePath: home,
          conversationHomePath: home,
          continuationKey: `claude:home:${home}`,
        }).pipe(Effect.flip);
        expect(result._tag).toBe("ClaudeSharedHomePathConflictError");
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects a shared home that only looks different from the instance's directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* makeTempDirectory("t3-claude-alias-");
          const alias = path.join(yield* makeTempDirectory("t3-claude-alias-link-"), "shared");
          yield* fileSystem.symlink(home, alias);
          const result = yield* materializeClaudeSharedHome({
            mode: "sharedConversations",
            homePath: home,
            conversationHomePath: alias,
            continuationKey: `claude:home:${alias}`,
          }).pipe(Effect.flip);
          expect(result._tag).toBe("ClaudeSharedHomePathConflictError");
          expect(yield* fileSystem.exists(path.join(home, "projects"))).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "sets aside entries it cannot move instead of deleting them",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const shared = yield* makeTempDirectory("t3-claude-shared-");
          const home = yield* makeTempDirectory("t3-claude-home-");
          // Both accounts keep auto-memory for the same project.
          for (const [root, note] of [
            [shared, "shared memory"],
            [home, "own memory"],
          ] as const) {
            yield* fileSystem.makeDirectory(path.join(root, "projects", "C--repo", "memory"), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(
              path.join(root, "projects", "C--repo", "memory", "MEMORY.md"),
              note,
            );
          }
          yield* fileSystem.writeFileString(
            path.join(home, "projects", "C--repo", "own-session.jsonl"),
            "{}\n",
          );

          yield* materializeClaudeSharedHome({
            mode: "sharedConversations",
            homePath: home,
            conversationHomePath: shared,
            continuationKey: `claude:home:${shared}`,
          });

          const link = path.join(home, "projects");
          expect(path.resolve(home, yield* fileSystem.readLink(link))).toBe(
            path.join(shared, "projects"),
          );
          expect(
            yield* fileSystem.readFileString(
              path.join(shared, "projects", "C--repo", "memory", "MEMORY.md"),
            ),
          ).toBe("shared memory");
          expect(
            yield* fileSystem.exists(path.join(shared, "projects", "C--repo", "own-session.jsonl")),
          ).toBe(true);
          const aside = (yield* fileSystem.readDirectory(home)).find((entry) =>
            entry.startsWith("projects.migrated-"),
          );
          expect(aside).toBeDefined();
          expect(
            yield* fileSystem.readFileString(
              path.join(home, aside ?? "", "C--repo", "memory", "MEMORY.md"),
            ),
          ).toBe("own memory");
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "links projects into the shared home and carries existing conversations across",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const shared = yield* makeTempDirectory("t3-claude-shared-");
          const home = yield* makeTempDirectory("t3-claude-home-");
          // The shared account already has one project; this account has its own
          // conversation in the same project plus a project of its own.
          yield* fileSystem.makeDirectory(path.join(shared, "projects", "C--repo"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(shared, "projects", "C--repo", "shared-session.jsonl"),
            "{}\n",
          );
          yield* fileSystem.makeDirectory(path.join(home, "projects", "C--repo"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(home, "projects", "C--repo", "own-session.jsonl"),
            "{}\n",
          );
          yield* fileSystem.makeDirectory(path.join(home, "projects", "C--other"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(home, "projects", "C--other", "other-session.jsonl"),
            "{}\n",
          );

          const layout = {
            mode: "sharedConversations" as const,
            homePath: home,
            conversationHomePath: shared,
            continuationKey: `claude:home:${shared}`,
          };
          yield* materializeClaudeSharedHome(layout);

          const link = path.join(home, "projects");
          expect(path.resolve(home, yield* fileSystem.readLink(link))).toBe(
            path.join(shared, "projects"),
          );
          for (const relative of [
            ["C--repo", "shared-session.jsonl"],
            ["C--repo", "own-session.jsonl"],
            ["C--other", "other-session.jsonl"],
          ]) {
            expect(yield* fileSystem.exists(path.join(shared, "projects", ...relative))).toBe(true);
            // Visible through the link too, which is what Claude's resume reads.
            expect(yield* fileSystem.exists(path.join(link, ...relative))).toBe(true);
          }

          // Idempotent: a second start finds the link and leaves it alone.
          yield* materializeClaudeSharedHome(layout);
          expect(path.resolve(home, yield* fileSystem.readLink(link))).toBe(
            path.join(shared, "projects"),
          );
        }).pipe(Effect.scoped),
    );
  });
});
