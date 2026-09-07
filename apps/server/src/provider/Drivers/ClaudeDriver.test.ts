import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

const account = vi.hoisted(() => ({ email: undefined as string | undefined }));
vi.mock("../Layers/ClaudeProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/ClaudeProvider.ts")>();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    probeClaudeCapabilities: () =>
      Effect.sync(() =>
        account.email
          ? {
              email: account.email,
              subscriptionType: account.email ? "max" : undefined,
              tokenSource: account.email ? "oauth" : undefined,
              apiProvider: account.email ? "firstParty" : undefined,
              slashCommands: [],
            }
          : undefined,
      ),
  };
});

const spawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(new TextEncoder().encode("2.1.263\n")),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-login-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    ),
  ),
);

it.layer(testLayer)("Claude account verification", (it) => {
  it.effect(
    "explicit refresh observes login, replacement, and failed verification without waiting for the cache TTL",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-account-" });
        account.email = undefined;
        const instance = yield* ClaudeDriver.create({
          instanceId: ProviderInstanceId.make("claude-login-test"),
          displayName: "Personal",
          enabled: true,
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: homePath, sensitive: false }],
          config: ClaudeDriver.defaultConfig(),
        });
        const before = yield* instance.snapshot.refresh;
        expect(before.auth.status).toBe("unknown");
        expect(before.continuation?.conversationHomePath).toBe(homePath);
        account.email = "personal@example.test";
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unknown");
        yield* instance.refreshModels!();
        expect((yield* instance.snapshot.refresh).auth.email).toBe("personal@example.test");
        account.email = "work@example.test";
        expect((yield* instance.snapshot.refresh).auth.email).toBe("personal@example.test");
        yield* instance.refreshModels!();
        expect((yield* instance.snapshot.refresh).auth.email).toBe("work@example.test");
        account.email = undefined;
        yield* instance.refreshModels!();
        const failed = yield* instance.snapshot.refresh;
        expect(failed.status).toBe("warning");
        expect(failed.auth.stale).toBe(true);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.scoped,
      ),
  );
});
