import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
  options?: {
    readonly driverKind?: string;
    readonly enabled?: boolean;
    readonly authStatus?: "authenticated" | "unauthenticated" | "unknown";
  },
): ProviderInstance => {
  const driverKind = (options?.driverKind ??
    instanceId) as unknown as ProviderInstance["driverKind"];
  return {
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: options?.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.succeed({ auth: { status: options?.authStatus ?? "authenticated" } }),
    } as unknown as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  } satisfies ProviderInstance;
};

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );
  it.effect("falls back to another instance of the same driver when the selected one fails", () =>
    Effect.gen(function* () {
      const attempts: Array<{ instanceId: string; model: string }> = [];
      const failing = (instanceId: ProviderInstanceId) =>
        makeStubInstance(
          instanceId,
          makeStubTextGeneration({
            generateThreadTitle: (input) => {
              attempts.push({ instanceId, model: input.modelSelection.model });
              return Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "You've hit your usage limit.",
                }),
              );
            },
          }),
          { driverKind: "codex" },
        );
      const work = makeStubInstance(
        ProviderInstanceId.make("codex_work"),
        makeStubTextGeneration({
          generateThreadTitle: (input) => {
            attempts.push({ instanceId: "codex_work", model: input.modelSelection.model });
            return Effect.succeed({ title: "Fix sidebar titles" });
          },
        }),
        { driverKind: "codex" },
      );
      const disabled = makeStubInstance(
        ProviderInstanceId.make("codex_disabled"),
        makeStubTextGeneration({
          generateThreadTitle: () => Effect.die("disabled instances must never be tried"),
        }),
        { driverKind: "codex", enabled: false },
      );
      const signedOut = makeStubInstance(
        ProviderInstanceId.make("codex_signed_out"),
        makeStubTextGeneration({
          generateThreadTitle: () => Effect.die("signed-out instances must never be tried"),
        }),
        { driverKind: "codex", authStatus: "unauthenticated" },
      );
      const claude = makeStubInstance(
        ProviderInstanceId.make("claudeAgent"),
        makeStubTextGeneration({
          generateThreadTitle: (input) => {
            attempts.push({ instanceId: "claudeAgent", model: input.modelSelection.model });
            return Effect.succeed({ title: "Claude should not be reached" });
          },
        }),
        { driverKind: "claudeAgent" },
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([
          failing(ProviderInstanceId.make("codex")),
          claude,
          disabled,
          signedOut,
          work,
        ]),
      );

      const result = yield* tg.generateThreadTitle({
        cwd: process.cwd(),
        message: "Why are sidebar titles stuck on New thread?",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna"),
      });

      expect(result.title).toBe("Fix sidebar titles");
      // Same driver keeps the selected model; the other driver is never needed.
      expect(attempts).toEqual([
        { instanceId: "codex", model: "gpt-5.6-luna" },
        { instanceId: "codex_work", model: "gpt-5.6-luna" },
      ]);
    }),
  );

  it.effect("crosses drivers on that driver's default model and reports the selected failure", () =>
    Effect.gen(function* () {
      const attempts: Array<{ instanceId: string; model: string }> = [];
      const codex = makeStubInstance(
        ProviderInstanceId.make("codex"),
        makeStubTextGeneration({
          generateBranchName: (input) => {
            attempts.push({ instanceId: "codex", model: input.modelSelection.model });
            return Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "selected broke",
              }),
            );
          },
        }),
        { driverKind: "codex" },
      );
      const claude = makeStubInstance(
        ProviderInstanceId.make("claudeAgent"),
        makeStubTextGeneration({
          generateBranchName: (input) => {
            attempts.push({ instanceId: "claudeAgent", model: input.modelSelection.model });
            return Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "fallback broke",
              }),
            );
          },
        }),
        { driverKind: "claudeAgent" },
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([codex, claude]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna"),
        })
        .pipe(Effect.result);

      expect(attempts).toEqual([
        { instanceId: "codex", model: "gpt-5.6-luna" },
        { instanceId: "claudeAgent", model: "claude-haiku-4-5" },
      ]);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toBe("selected broke");
      }
    }),
  );
});
