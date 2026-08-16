import { describe, expect, it } from "@effect/vitest";

import { blurComposerAfterDraftCommit } from "./composerSendHandoff";

describe("blurComposerAfterDraftCommit", () => {
  it("waits one render frame before blurring the native editor", async () => {
    const frames: Array<() => void> = [];
    let blurred = false;
    const handoff = blurComposerAfterDraftCommit({
      targetThreadKey: "env:thread",
      currentThreadKey: () => "env:thread",
      requestFrame: (callback) => {
        frames.push(callback);
      },
      blur: () => {
        blurred = true;
      },
    });

    expect(blurred).toBe(false);
    frames[0]?.();
    await handoff;
    expect(blurred).toBe(true);
  });

  it("does not blur a different thread after the frame handoff", async () => {
    await blurComposerAfterDraftCommit({
      targetThreadKey: "env:old-thread",
      currentThreadKey: () => "env:new-thread",
      requestFrame: (callback) => callback(),
      blur: () => {
        throw new Error("must not blur");
      },
    });
  });
});
