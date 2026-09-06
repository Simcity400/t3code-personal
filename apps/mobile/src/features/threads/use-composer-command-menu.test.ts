import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("provider-slash-command");
      const item = items[0];
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });

  // Fork feature: `/side` lives inside the upstream-owned builder, so it is
  // the first thing an upstream refactor of that function can drop silently.
  it.each([false, true])(
    "offers the fork's /side command with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "sid",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items.map((entry) => entry.id)).toEqual(["cmd:side"]);
      const item = items[0];
      if (!item) throw new Error("Expected the side-chat command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/sid",
          trigger: { rangeStart: 0, rangeEnd: 4 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/side ", cursor: 6, interactionMode: null });
    },
  );

  it("keeps /side listed inside the message, where provider commands are gated", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "side",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: false,
        selectedProviderStatus: antigravity,
      }).map((entry) => entry.id),
    ).toEqual(["cmd:side"]);
  });
});
