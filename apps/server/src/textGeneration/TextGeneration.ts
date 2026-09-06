import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  TextGenerationError,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

interface TextGenerationAttempt {
  readonly instance: ProviderInstance;
  readonly modelSelection: ModelSelection;
}

/**
 * Every enabled, signed-in instance other than the selected one, as a place
 * to retry a failed generation. Same-driver instances come first and keep the
 * selected model (the model id is only meaningful to that driver); other
 * drivers run their default text-generation model. Order follows the settings
 * author's instance order, like the registry itself. Each attempt is a CLI
 * spawn, so an instance the probe already knows is signed out is not worth
 * one; an unknown auth state still gets its chance.
 */
const fallbackAttempts = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  selection: ModelSelection,
): Effect.Effect<ReadonlyArray<TextGenerationAttempt>> =>
  Effect.gen(function* () {
    const selected = yield* registry.getInstance(selection.instanceId);
    const instances = yield* registry.listInstances;
    const candidates = yield* Effect.filter(
      instances.filter(
        (instance) => instance.enabled && instance.instanceId !== selection.instanceId,
      ),
      (instance) =>
        instance.snapshot.getSnapshot.pipe(
          Effect.map((snapshot) => snapshot.auth.status !== "unauthenticated"),
        ),
    );
    const sameDriver = candidates
      .filter((instance) => selected !== undefined && instance.driverKind === selected.driverKind)
      .map((instance) => ({
        instance,
        modelSelection: { ...selection, instanceId: instance.instanceId },
      }));
    const otherDrivers = candidates
      .filter((instance) => selected === undefined || instance.driverKind !== selected.driverKind)
      .map((instance) => ({
        instance,
        modelSelection: createModelSelection(
          instance.instanceId,
          DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driverKind] ??
            DEFAULT_MODEL_BY_PROVIDER[instance.driverKind] ??
            DEFAULT_TEXT_GENERATION_MODEL,
        ),
      }));
    return [...sameDriver, ...otherDrivers];
  });

/**
 * Runs one generation on the selected instance and, when that fails, on each
 * fallback in turn until one succeeds. A single account hitting its usage
 * limit or losing its login used to silently stop every thread title, branch
 * name and commit message on a server that had four other signed-in accounts
 * to hand. The selected instance's error is what surfaces when every attempt
 * fails, so a misconfiguration still reads as itself.
 */
const generateWithFallback = <A>(
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  selection: ModelSelection,
  run: (
    textGeneration: ProviderInstance["textGeneration"],
    modelSelection: ModelSelection,
  ) => Effect.Effect<A, TextGenerationError>,
): Effect.Effect<A, TextGenerationError> =>
  Effect.gen(function* () {
    const fallbacks = yield* fallbackAttempts(registry, selection);
    const primary = yield* resolveInstance(registry, operation, selection.instanceId).pipe(
      Effect.flatMap((instance) => {
        const attempt = run(instance.textGeneration, selection);
        // With nowhere else to turn, keep the old retry for transient CLI
        // failures; with fallbacks, another account is the better second try.
        return fallbacks.length === 0
          ? attempt.pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }))
          : attempt;
      }),
      Effect.result,
    );
    if (Result.isSuccess(primary)) {
      return primary.success;
    }
    for (const attempt of fallbacks) {
      const result = yield* run(attempt.instance.textGeneration, attempt.modelSelection).pipe(
        Effect.result,
      );
      if (Result.isSuccess(result)) {
        yield* Effect.logInfo("text generation fell back to another provider instance", {
          operation,
          selectedInstanceId: selection.instanceId,
          instanceId: attempt.instance.instanceId,
          model: attempt.modelSelection.model,
          cause: primary.failure.message,
        });
        return result.success;
      }
      yield* Effect.logWarning("text generation fallback instance failed", {
        operation,
        instanceId: attempt.instance.instanceId,
        model: attempt.modelSelection.model,
        cause: result.failure.message,
      });
    }
    return yield* Effect.fail(primary.failure);
  });

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      generateWithFallback(
        registry,
        "generateCommitMessage",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
      ),
    generatePrContent: (input) =>
      generateWithFallback(
        registry,
        "generatePrContent",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generatePrContent({ ...input, modelSelection }),
      ),
    generateBranchName: (input) =>
      generateWithFallback(
        registry,
        "generateBranchName",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
      ),
    generateThreadTitle: (input) =>
      generateWithFallback(
        registry,
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateThreadTitle({ ...input, modelSelection }),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
