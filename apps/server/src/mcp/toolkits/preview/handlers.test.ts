import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewToolkit } from "./tools.ts";

import { normalizePreviewOpenInput, PreviewToolkitHandlersLive } from "./handlers.ts";

it.effect("maps preview failure context to the visible root while retaining child identity", () => {
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("cross-provider-session:child"),
    visibleThreadId: ThreadId.make("root"),
    providerSessionId: "child-session",
    providerInstanceId: ProviderInstanceId.make("claude"),
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };
  return Effect.gen(function* () {
    const toolkit = yield* PreviewToolkit;
    for (const tool of [
      "preview_status",
      "preview_snapshot",
      "preview_recording_start",
      "preview_recording_stop",
    ] as const) {
      const error = yield* toolkit
        .handle(tool, {})
        .pipe(Stream.unwrap, Stream.runDrain, Effect.flip);
      expect(error).toMatchObject({
        _tag: "PreviewAutomationNoAvailableHostError",
        threadId: scope.visibleThreadId,
        environmentId: scope.environmentId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
      });
    }
  }).pipe(
    Effect.provideService(McpInvocationContext, scope),
    Effect.provide(
      PreviewToolkitHandlersLive.pipe(
        Layer.provideMerge(PreviewAutomationBroker.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});
