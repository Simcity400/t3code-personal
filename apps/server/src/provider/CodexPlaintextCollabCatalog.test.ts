import { describe, expect, it } from "vite-plus/test";

import { buildPlaintextCollabModelCatalog } from "./CodexPlaintextCollabCatalog.ts";
import { codexModelCatalogHomePath, type CodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

describe("buildPlaintextCollabModelCatalog", () => {
  it("switches only V2 collaboration models to plaintext-capable V1", () => {
    const result = buildPlaintextCollabModelCatalog(
      JSON.stringify({
        client_version: "1.2.3",
        models: [
          { slug: "gpt-5.6-sol", multi_agent_version: "v2", priority: 1 },
          { slug: "gpt-5.6-luna", multi_agent_version: "v1", priority: 2 },
          { slug: "gpt-5.5", priority: 3 },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(JSON.parse(result ?? "{}")).toEqual({
      models: [
        { slug: "gpt-5.6-sol", multi_agent_version: "v1", priority: 1 },
        { slug: "gpt-5.6-luna", multi_agent_version: "v1", priority: 2 },
        { slug: "gpt-5.5", priority: 3 },
      ],
    });
  });

  it("does not write a redundant catalog when no V2 model exists", () => {
    expect(
      buildPlaintextCollabModelCatalog(
        JSON.stringify({ models: [{ slug: "gpt-5.6-luna", multi_agent_version: "v1" }] }),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed catalog JSON", () => {
    expect(buildPlaintextCollabModelCatalog("not-json")).toBeUndefined();
  });
});

describe("codexModelCatalogHomePath", () => {
  it("uses the private effective home for a shadow account", () => {
    expect(
      codexModelCatalogHomePath({
        mode: "authOverlay",
        sharedHomePath: "C:\\codex-shared",
        effectiveHomePath: "C:\\codex-shadow",
        continuationKey: "codex:home:C:\\codex-shared",
      } satisfies CodexHomeLayout),
    ).toBe("C:\\codex-shadow");
  });

  it("falls back to the shared home for the default direct account", () => {
    expect(
      codexModelCatalogHomePath({
        mode: "direct",
        sharedHomePath: "C:\\codex",
        effectiveHomePath: undefined,
        continuationKey: "codex:home:C:\\codex",
      } satisfies CodexHomeLayout),
    ).toBe("C:\\codex");
  });
});
