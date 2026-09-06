import type { DesktopUpstreamMergeStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildUpstreamMergePrompt, describeUpstreamMerge } from "./upstreamMerge.logic";

const blocked: DesktopUpstreamMergeStatus = {
  tag: "v0.0.39-nightly.20260906.1291",
  commit: "bd16b86d50c1df49afeb7c0a7568a4908ade4048",
  conflicts: ["apps/web/src/components/ChatView.tsx", "packages/contracts/src/rpc.ts"],
  reason: null,
  runUrl: "https://github.com/Simcity400/t3code-personal/actions/runs/1",
  at: "2026-09-06T10:00:00.000Z",
};

describe("upstream merge notice text", () => {
  it("counts the conflicting files", () => {
    expect(describeUpstreamMerge(blocked)).toBe(
      "Official nightly v0.0.39-nightly.20260906.1291 conflicts with your customizations in 2 files.",
    );
    expect(describeUpstreamMerge({ ...blocked, conflicts: [blocked.conflicts[0]!] })).toContain(
      "in 1 file.",
    );
  });

  it("falls back to the run's reason when the sync stopped before merging", () => {
    expect(
      describeUpstreamMerge({ ...blocked, conflicts: [], reason: "The sync run failed." }),
    ).toBe(
      "Official nightly v0.0.39-nightly.20260906.1291 could not be merged. The sync run failed.",
    );
  });

  it("writes a prompt that names the recipe, the commit, every conflict and the run", () => {
    const prompt = buildUpstreamMergePrompt(blocked);
    expect(prompt.split("\n")).toEqual([
      "Finish the upstream merge: integrate the official nightly v0.0.39-nightly.20260906.1291 into this fork's main.",
      'Follow docs/internals/personal-fork-updates.md, section "Finishing a blocked sync", and keep the fork\'s customizations listed in MY-FORK.md.',
      "Upstream commit: bd16b86d50c1df49afeb7c0a7568a4908ade4048",
      "Conflicting files:",
      "- apps/web/src/components/ChatView.tsx",
      "- packages/contracts/src/rpc.ts",
      "Failed run: https://github.com/Simcity400/t3code-personal/actions/runs/1",
    ]);
  });

  it("explains a stop without conflicts instead of listing nothing", () => {
    const prompt = buildUpstreamMergePrompt({
      ...blocked,
      commit: null,
      conflicts: [],
      reason: "The sync run failed.",
      runUrl: null,
    });
    expect(prompt).not.toContain("Conflicting files");
    expect(prompt).toContain("The sync stopped before merging: The sync run failed.");
    expect(prompt).not.toContain("Failed run");
  });
});
