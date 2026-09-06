import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ModelOption } from "../../lib/modelOptions";
import {
  canCommitPendingModel,
  compatibleProviderInstanceIdsForThread,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: " ZEN " })).toBe(
      true,
    );
    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "copilot" })).toBe(
      false,
    );
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});

const decodeServerProvider = Schema.decodeSync(ServerProvider);

function setupProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return decodeServerProvider({
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    enabled: false,
    installed: false,
    version: null,
    status: "disabled",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    setup: { canAuthenticate: true, canInstall: true },
    models: [],
    ...overrides,
  });
}

describe("compatibleProviderInstanceIdsForThread", () => {
  it("offers accounts with the same driver and continuation group", () => {
    const codex = ProviderDriverKind.make("codex");
    const work = setupProvider({
      instanceId: ProviderInstanceId.make("codex_work"),
      driver: codex,
      continuation: { groupKey: "codex:home:shared" },
    });
    const personal = setupProvider({
      instanceId: ProviderInstanceId.make("codex_personal"),
      driver: codex,
      continuation: { groupKey: "codex:home:shared" },
    });
    const isolated = setupProvider({
      instanceId: ProviderInstanceId.make("codex_isolated"),
      driver: codex,
      continuation: { groupKey: "codex:home:isolated" },
    });
    const claude = setupProvider({
      instanceId: ProviderInstanceId.make("claude_work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      continuation: { groupKey: "claude:home:shared" },
    });

    expect(
      compatibleProviderInstanceIdsForThread({
        providers: [work, personal, isolated, claude],
        instanceId: work.instanceId,
      }),
    ).toEqual(new Set([work.instanceId, personal.instanceId]));
  });

  it("allows legacy same-driver switching when continuation metadata is absent", () => {
    const codex = ProviderDriverKind.make("codex");
    const primary = setupProvider({ driver: codex, instanceId: ProviderInstanceId.make("codex") });
    const personal = setupProvider({
      driver: codex,
      instanceId: ProviderInstanceId.make("codex_personal"),
    });

    expect(
      compatibleProviderInstanceIdsForThread({
        providers: [primary, personal],
        instanceId: primary.instanceId,
      }),
    ).toEqual(new Set([primary.instanceId, personal.instanceId]));
  });

  it("keeps legacy Antigravity threads on their exact profile", () => {
    const personal = setupProvider();
    const work = setupProvider({ instanceId: ProviderInstanceId.make("google_work") });

    expect(
      compatibleProviderInstanceIdsForThread({
        providers: [personal, work],
        instanceId: work.instanceId,
      }),
    ).toEqual(new Set([work.instanceId]));
  });

  it("uses the session driver when the locked Codex instance is missing", () => {
    const missing = ProviderInstanceId.make("codex_removed");
    const codex = ProviderDriverKind.make("codex");
    const primary = setupProvider({ driver: codex, instanceId: ProviderInstanceId.make("codex") });
    const personal = setupProvider({
      driver: codex,
      instanceId: ProviderInstanceId.make("codex_personal"),
    });

    expect(
      compatibleProviderInstanceIdsForThread({
        providers: [primary, personal],
        instanceId: missing,
        driver: codex,
      }),
    ).toEqual(new Set([missing, primary.instanceId, personal.instanceId]));
  });

  it("keeps a missing legacy Antigravity instance exact", () => {
    const missing = ProviderInstanceId.make("google_removed");
    const primary = setupProvider();
    const work = setupProvider({ instanceId: ProviderInstanceId.make("google_work") });

    expect(
      compatibleProviderInstanceIdsForThread({
        providers: [primary, work],
        instanceId: missing,
        driver: ProviderDriverKind.make("antigravity"),
      }),
    ).toEqual(new Set([missing]));
  });
});
