import {
  type DesktopUpstreamMergeStatus,
  DesktopUpstreamMergeStatusSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Fork Sync publishes this file on the `needs-merge-help` branch when a
// nightly cannot be merged on its own (scripts/fork-sync.ts markSyncBlocked)
// and deletes the branch once a resolved main is pushed.
export const UPSTREAM_MERGE_STATUS_BRANCH = "needs-merge-help";
export const UPSTREAM_MERGE_STATUS_FILE = "fork-sync-status.json";

const decodeStatus = Schema.decodeUnknownEffect(DesktopUpstreamMergeStatusSchema);

/** Validates the published status; anything malformed reads as "not blocked". */
export const parseUpstreamMergeStatus = (
  raw: unknown,
): Effect.Effect<DesktopUpstreamMergeStatus | null> =>
  decodeStatus(raw).pipe(
    Effect.map((status): DesktopUpstreamMergeStatus | null => status),
    Effect.orElseSucceed((): DesktopUpstreamMergeStatus | null => null),
  );

/** Structural compare so a repeated read does not re-broadcast an unchanged notice. */
export function isSameUpstreamMergeStatus(
  left: DesktopUpstreamMergeStatus | null,
  right: DesktopUpstreamMergeStatus | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.tag === right.tag &&
    left.commit === right.commit &&
    left.reason === right.reason &&
    left.runUrl === right.runUrl &&
    left.at === right.at &&
    left.conflicts.length === right.conflicts.length &&
    left.conflicts.every((path, index) => path === right.conflicts[index])
  );
}

export function upstreamMergeStatusUrl(feed: { readonly owner: string; readonly repo: string }) {
  return `https://api.github.com/repos/${feed.owner}/${feed.repo}/contents/${UPSTREAM_MERGE_STATUS_FILE}?ref=${UPSTREAM_MERGE_STATUS_BRANCH}`;
}

/**
 * Reads the marker with the same token the private release feed uses. A
 * missing branch (404) and every failure read as "not blocked": the notice is
 * best effort and must never disturb the update check that triggered it.
 */
export const fetchUpstreamMergeStatus = (
  feed: { readonly owner: string; readonly repo: string },
  token: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<DesktopUpstreamMergeStatus | null> =>
  Effect.tryPromise(() =>
    fetchImpl(upstreamMergeStatusUrl(feed), {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),
  ).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise(() => response.json() as Promise<unknown>)
        : Effect.succeed(null),
    ),
    Effect.flatMap((raw) => (raw === null ? Effect.succeed(null) : parseUpstreamMergeStatus(raw))),
    Effect.orElseSucceed((): DesktopUpstreamMergeStatus | null => null),
  );
