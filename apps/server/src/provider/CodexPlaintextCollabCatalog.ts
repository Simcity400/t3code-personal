import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const CodexModelCatalog = Schema.Struct({
  models: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeCodexModelCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexModelCatalog),
);

export class CodexPlaintextCollabCatalogError extends Schema.TaggedErrorClass<CodexPlaintextCollabCatalogError>()(
  "CodexPlaintextCollabCatalogError",
  {
    operation: Schema.Literals(["read", "parse", "inspect", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} Codex model catalog '${this.path}'.`;
  }
}

export function buildPlaintextCollabModelCatalog(source: string): string | undefined {
  return Option.match(decodeCodexModelCatalog(source), {
    onNone: () => undefined,
    onSome: (catalog) => {
      let changed = false;
      const models = catalog.models.map((model) => {
        if (model.multi_agent_version !== "v2") return model;
        changed = true;
        return { ...model, multi_agent_version: "v1" };
      });
      return changed ? JSON.stringify({ models }) : undefined;
    },
  });
}

export const materializePlaintextCollabModelCatalog = Effect.fn(
  "CodexPlaintextCollabCatalog.materialize",
)(function* (input: {
  readonly modelCatalogHomePath: string;
  readonly outputDirectory: string;
  readonly instanceId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(input.modelCatalogHomePath, "models_cache.json");
  const source = yield* fileSystem.readFileString(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new CodexPlaintextCollabCatalogError({
          operation: "read",
          path: sourcePath,
          cause,
        }),
    ),
  );
  const contents = buildPlaintextCollabModelCatalog(source);
  if (contents === undefined) {
    if (Option.isNone(decodeCodexModelCatalog(source))) {
      return yield* new CodexPlaintextCollabCatalogError({
        operation: "parse",
        path: sourcePath,
        cause: new Error("Codex model cache is not valid model catalog JSON."),
      });
    }
    return undefined;
  }

  const digest = NodeCrypto.createHash("sha256")
    .update(contents, "utf8")
    .digest("hex")
    .slice(0, 16);
  const outputPath = path.join(
    input.outputDirectory,
    `codex-${input.instanceId}-plaintext-collab-${digest}.json`,
  );
  const exists = yield* fileSystem.exists(outputPath).pipe(
    Effect.mapError(
      (cause) =>
        new CodexPlaintextCollabCatalogError({
          operation: "inspect",
          path: outputPath,
          cause,
        }),
    ),
  );
  if (!exists) {
    yield* writeFileStringAtomically({ filePath: outputPath, contents }).pipe(
      Effect.mapError(
        (cause) =>
          new CodexPlaintextCollabCatalogError({
            operation: "write",
            path: outputPath,
            cause,
          }),
      ),
    );
  }
  return outputPath;
});
