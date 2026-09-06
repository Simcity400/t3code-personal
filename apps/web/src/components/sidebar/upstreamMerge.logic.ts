import type { DesktopUpstreamMergeStatus } from "@t3tools/contracts";

// Text for the personal fork's blocked-sync notice (SidebarUpstreamMergeNotice).
// The desktop updater fills `upstreamMerge` from the marker Fork Sync pushes
// when an official nightly cannot be merged on its own.

export function describeUpstreamMerge(status: DesktopUpstreamMergeStatus): string {
  const count = status.conflicts.length;
  if (count === 0) {
    return `Official nightly ${status.tag} could not be merged. ${status.reason ?? "Read the run log."}`;
  }
  return `Official nightly ${status.tag} conflicts with your customizations in ${count} ${
    count === 1 ? "file" : "files"
  }.`;
}

/**
 * The prompt the notice drops into a new thread. It names the docs section
 * that carries the full recipe, so the agent follows the same steps every
 * time and the prompt itself stays short.
 */
export function buildUpstreamMergePrompt(status: DesktopUpstreamMergeStatus): string {
  const lines = [
    `Finish the upstream merge: integrate the official nightly ${status.tag} into main of the fork ${status.repository}.`,
    'Follow docs/internals/personal-fork-updates.md, section "Finishing a blocked sync", and keep the fork\'s customizations listed in MY-FORK.md.',
  ];
  if (status.commit) lines.push(`Upstream commit: ${status.commit}`);
  if (status.conflicts.length > 0) {
    lines.push("Conflicting files:", ...status.conflicts.map((path) => `- ${path}`));
  } else if (status.reason) {
    lines.push(`The sync stopped before merging: ${status.reason}`);
  }
  if (status.runUrl) lines.push(`Failed run: ${status.runUrl}`);
  return lines.join("\n");
}
