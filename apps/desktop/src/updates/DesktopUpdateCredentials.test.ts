import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopUpdates from "./DesktopUpdates.ts";

const textEncoder = new TextEncoder();

function makeProcess(output: string): ChildProcessSpawner.ChildProcessHandle {
  const stdout = Stream.make(textEncoder.encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

describe("DesktopUpdateCredentials", () => {
  it.effect("reads GitHub CLI auth without changing the app process environment", () => {
    const commands: ChildProcess.Command[] = [];
    const tokenBeforeResolve = process.env.GH_TOKEN;
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command);
        return Effect.succeed(makeProcess("test-private-token\n"));
      }),
    );

    return Effect.gen(function* () {
      const credentials = yield* DesktopUpdates.DesktopUpdateCredentials;
      const token = yield* credentials.resolvePrivateGitHubToken;

      assert.isTrue(Option.isSome(token));
      if (Option.isSome(token)) {
        assert.equal(token.value, "test-private-token");
      }
      assert.equal(process.env.GH_TOKEN, tokenBeforeResolve);
      const command = commands[0];
      assert.equal(command?._tag, "StandardCommand");
      if (command?._tag === "StandardCommand") {
        assert.equal(command.command, "gh");
        assert.deepEqual(command.args, ["auth", "token"]);
      }
    }).pipe(
      Effect.provide(
        DesktopUpdates.desktopUpdateCredentialsLayer.pipe(Layer.provide(spawnerLayer)),
      ),
    );
  });
});
