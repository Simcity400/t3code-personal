import { ForkUpdateStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as ForkUpdates from "../../updates/ForkUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getForkUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: ForkUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.forkUpdates.getState")(function* () {
    const forkUpdates = yield* ForkUpdates.ForkUpdates;
    return yield* forkUpdates.getState;
  }),
});

export const checkForForkUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: ForkUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.forkUpdates.check")(function* () {
    const forkUpdates = yield* ForkUpdates.ForkUpdates;
    return yield* forkUpdates.check;
  }),
});

export const applyForkUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FORK_UPDATE_APPLY_CHANNEL,
  payload: Schema.Void,
  result: ForkUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.forkUpdates.apply")(function* () {
    const forkUpdates = yield* ForkUpdates.ForkUpdates;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const accepted = yield* forkUpdates.beginApply;
    if (accepted) {
      // The merge + install + rebuild takes minutes; run it detached so the
      // invoke resolves immediately and progress streams via the push channel.
      yield* forkUpdates.runApply.pipe(
        Effect.flatMap((succeeded) =>
          succeeded ? lifecycle.relaunch("fork-update") : Effect.void,
        ),
        Effect.forkDetach,
      );
    }
    return yield* forkUpdates.getState;
  }),
});
