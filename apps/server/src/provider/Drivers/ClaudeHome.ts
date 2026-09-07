import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * The config directory the spawned CLI will actually use, with the CLI's own
 * precedence: the instance's `homePath`, then a `CLAUDE_CONFIG_DIR` already in
 * the instance environment, then `~/.claude`. Unlike `resolveClaudeHomePath`,
 * an empty setting never means the OS home directory.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Threads continue across instances that share this key. It names the
 * directory holding `projects`: the instance's own config directory, or the
 * shared conversation home (see ClaudeSharedHome.ts) when one is set, so two
 * accounts resuming from one `projects` folder report the same key.
 */
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "sharedHomePath">>,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const sharedHomePath = config.sharedHomePath?.trim() ?? "";
    if (sharedHomePath.length > 0) {
      return `claude:home:${path.resolve(expandHomePath(sharedHomePath))}`;
    }
    return `claude:home:${yield* resolveClaudeConfigDirPath(config, environment)}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
