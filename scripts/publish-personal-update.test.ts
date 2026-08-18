import { describe, expect, it } from "vite-plus/test";

import {
  assertLinuxX64Elf,
  deriveLocalReleaseMetadata,
  deriveLocalRunNumber,
  hasCompatibleIphoneRuntimeBuild,
  hasCompleteDesktopReleaseAssets,
  iphoneRuntimeBuildListArgs,
  parseJsonOutput,
  parseGitCommitCount,
  parsePublishSelection,
} from "./publish-personal-update.ts";

describe("personal local update publisher", () => {
  it("publishes both surfaces by default and supports one-surface retries", () => {
    expect(parsePublishSelection([])).toEqual({ desktop: true, iphone: true });
    expect(parsePublishSelection(["--desktop-only"])).toEqual({ desktop: true, iphone: false });
    expect(parsePublishSelection(["--iphone-only"])).toEqual({ desktop: false, iphone: true });
    expect(() => parsePublishSelection(["--desktop-only", "--iphone-only"])).toThrow();
    expect(() => parsePublishSelection(["--unknown"])).toThrow();
  });

  it("derives deterministic retry-safe nightly metadata from the commit", () => {
    const sha = "75a818ff86fecb32602d3df291832e1fd91b7264";
    expect(parseGitCommitCount("1729")).toBe(1729);
    expect(() => parseGitCommitCount("0")).toThrow();
    expect(() => parseGitCommitCount("abc")).toThrow();
    expect(deriveLocalRunNumber("2026-08-17T02:32:00+00:00", 1729)).toBe(1_786_933_920_001_729);
    expect(deriveLocalRunNumber("2026-08-17T02:32:01+00:00", 1730)).toBeGreaterThan(
      deriveLocalRunNumber("2026-08-17T02:32:00+00:00", 1729),
    );
    expect(deriveLocalRunNumber("2026-08-17T02:32:00+00:00", 1729)).toBeGreaterThan(31_951_414_553);
    expect(deriveLocalReleaseMetadata("0.0.34", sha, "2026-08-17T02:32:00+00:00", 1729)).toEqual({
      date: "20260817",
      runNumber: 1_786_933_920_001_729,
      version: "0.0.35-nightly.20260817.1786933920001729",
      tag: "v0.0.35-nightly.20260817.1786933920001729",
      name: "T3 Code Nightly 0.0.35-nightly.20260817.1786933920001729 (75a818ff86fe)",
    });
  });

  it("extracts JSON after CLI notices", () => {
    expect(parseJsonOutput('Notice: using preview\n{"hash":"abc"}\n')).toEqual({
      hash: "abc",
    });
    expect(parseJsonOutput('warning\n[{"id":1}]\n')).toEqual([{ id: 1 }]);
    expect(() => parseJsonOutput("no structured output")).toThrow();
  });

  it("requires every desktop updater asset before treating a retry as complete", () => {
    const complete = {
      assets: [
        { name: "T3-Code-Setup.exe" },
        { name: "T3-Code-Setup.exe.blockmap" },
        { name: "nightly.yml" },
        { name: "latest.yml" },
      ],
    };
    expect(hasCompleteDesktopReleaseAssets(complete)).toBe(true);
    expect(
      hasCompleteDesktopReleaseAssets({
        assets: complete.assets.filter((asset) => asset.name !== "latest.yml"),
      }),
    ).toBe(false);
    expect(hasCompleteDesktopReleaseAssets(undefined)).toBe(false);
  });

  it("reuses only an iPhone build with the pinned personal runtime", () => {
    expect(
      hasCompatibleIphoneRuntimeBuild([
        { runtime: { version: "other-runtime" } },
        { runtime: { version: "346493b9258a61dc18bed1ffc18be830a6f3b2ce" } },
      ]),
    ).toBe(true);
    expect(hasCompatibleIphoneRuntimeBuild([{ runtime: { version: "other-runtime" } }])).toBe(
      false,
    );
    expect(hasCompatibleIphoneRuntimeBuild(undefined)).toBe(false);
  });

  it("queries EAS directly for the pinned personal runtime", () => {
    expect(iphoneRuntimeBuildListArgs()).toEqual([
      "build:list",
      "--platform",
      "ios",
      "--build-profile",
      "preview",
      "--status",
      "finished",
      "--runtime-version",
      "346493b9258a61dc18bed1ffc18be830a6f3b2ce",
      "--limit",
      "1",
      "--json",
      "--non-interactive",
    ]);
  });

  it("accepts only a little-endian Linux x64 ELF seed", () => {
    const elf = Buffer.alloc(20);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    expect(() => assertLinuxX64Elf(elf)).not.toThrow();
    elf.writeUInt16LE(183, 18);
    expect(() => assertLinuxX64Elf(elf)).toThrow(/Linux x64 ELF/u);
  });
});
