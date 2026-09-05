import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import {
  CrossAgentSendInput,
  CrossAgentSpawnInput,
  CrossAgentTargetInput,
  CrossAgentWaitInput,
  type CrossProviderAgentBridge,
} from "../../provider/CrossProviderAgentBridge.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  requireMcpCapability,
  McpInvocationContext,
  type McpInvocationScope,
} from "../McpInvocationContext.ts";

class CrossProviderAgentToolError extends Schema.TaggedErrorClass<CrossProviderAgentToolError>()(
  "CrossProviderAgentToolError",
  { errorTag: Schema.String, message: Schema.String },
) {}

const defaults = {
  success: Schema.Unknown,
  failure: CrossProviderAgentToolError,
  dependencies: [McpInvocationContext],
};

export const CrossProviderAgentToolkit = Toolkit.make(
  Tool.make("t3_agent_targets", {
    ...defaults,
    description:
      "List configured cross-provider agent targets, their instance IDs, and availability. Requires Agent Browser access.",
    parameters: Schema.Struct({}),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_agent_spawn", {
    ...defaults,
    description:
      "Launch an agent on another provider in this workspace and promptly return its stable agentId, retained across server restarts for user Resume. Use native tools for same-provider delegation. Assign disjoint files for concurrent edits. Reuse requestKey when retrying the same launch.",
    parameters: CrossAgentSpawnInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_agent_send_input", {
    ...defaults,
    description:
      "Send a prompt to an owned agent, or use agentId 'parent' to message your authenticated owner. Delivery may be queued. Set interrupt to redirect only an owned descendant. Manually stopped agents require user resume. Reuse requestKey for retries.",
    parameters: CrossAgentSendInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_agent_wait", {
    ...defaults,
    description:
      "Read an owned agent's status, reply, error, and pending requests, optionally waiting up to 60000ms for a change. A timeout or interrupted wait leaves the agent running.",
    parameters: CrossAgentWaitInput,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_agent_interrupt", {
    ...defaults,
    description:
      "Interrupt only the selected owned agent without sending a new prompt. Independent descendants continue running. Unsupported individual interruption fails without broadening the stop. Reuse requestKey for retries.",
    parameters: CrossAgentTargetInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_agent_close", {
    ...defaults,
    description:
      "Release only the selected owned agent's session resources while retaining its transcript and stable agentId for user Resume. Closing does not delete the agent. Independent descendants continue running. Close finished agents when no follow-up is needed. Reuse requestKey for retries.",
    parameters: CrossAgentTargetInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
);

export const CrossProviderAgentToolkitHandlersLive = CrossProviderAgentToolkit.toLayer(
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const invoke = Effect.fn("CrossProviderAgentToolkit.invoke")(
      function* <A, E extends { readonly _tag: string; readonly message: string }>(
        run: (bridge: CrossProviderAgentBridge, scope: McpInvocationScope) => Effect.Effect<A, E>,
      ) {
        const scope = yield* requireMcpCapability("preview");
        const bridge = provider.crossProviderAgents;
        if (!bridge) {
          return yield* Effect.fail({
            _tag: "CrossProviderAgentUnavailableError",
            message: "Cross-provider agents are unavailable in this environment.",
          });
        }
        return yield* run(bridge, scope);
      },
      Effect.mapError(
        (error) =>
          new CrossProviderAgentToolError({
            errorTag: error._tag,
            message: error.message,
          }),
      ),
    );
    return {
      t3_agent_targets: () =>
        invoke((bridge, scope) => bridge.targets(scope)).pipe(
          Effect.map((targets) => ({ targets })),
        ),
      t3_agent_spawn: (input) => invoke((bridge, scope) => bridge.spawn(scope, input)),
      t3_agent_send_input: (input) => invoke((bridge, scope) => bridge.send(scope, input)),
      t3_agent_wait: (input) => invoke((bridge, scope) => bridge.wait(scope, input)),
      t3_agent_interrupt: (input) =>
        invoke((bridge, scope) => bridge.control(scope, input, "interrupt")),
      t3_agent_close: (input) => invoke((bridge, scope) => bridge.control(scope, input, "close")),
    };
  }),
);

export const CrossProviderAgentToolkitRegistrationLive = McpServer.toolkit(
  CrossProviderAgentToolkit,
).pipe(Layer.provide(CrossProviderAgentToolkitHandlersLive));
