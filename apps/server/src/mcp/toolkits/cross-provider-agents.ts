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

/**
 * The delegation rules, returned once from `t3_agent_targets` (which every
 * launch must call first for an instance ID). Tool descriptions stay terse
 * because they sit in the agent's context on every turn; this list is paid
 * for only when an agent is about to delegate.
 */
export const CROSS_PROVIDER_AGENT_GUIDANCE: ReadonlyArray<string> = [
  "Same provider: use native subagent tools. Cross-provider: spawn only targets listed as available.",
  "Children share the workspace and permission mode but not your context: give a self-contained prompt and non-overlapping files.",
  "Keep the agentId and poll with t3_agent_wait; a wait timeout does not stop the agent.",
  "Follow-ups go through t3_agent_send_input and may queue. Only agents you own; children may message 'parent' but not interrupt it. Never touch siblings or ancestors.",
  "Never restart an agent the user stopped; only the user can Resume. Never widen a failed stop.",
  "Retry writes with the same requestKey and arguments. Report unavailable providers and limits; do not fall back to raw CLI launches.",
  "The agentId survives restarts. After an interruption, check prior tool outcomes before repeating work.",
];

export const CrossProviderAgentToolkit = Toolkit.make(
  Tool.make("t3_agent_targets", {
    ...defaults,
    description:
      "List cross-provider agent targets and the delegation rules. Call before the first t3_agent_spawn.",
    parameters: Schema.Struct({}),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_agent_spawn", {
    ...defaults,
    description:
      "Launch an agent on another provider in this workspace; returns a stable agentId. Use native subagent tools for your own provider. Reuse requestKey on retry.",
    parameters: CrossAgentSpawnInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_agent_send_input", {
    ...defaults,
    description:
      "Send a prompt to an agent you own, or to 'parent'. Set interrupt to redirect it. Reuse requestKey on retry.",
    parameters: CrossAgentSendInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_agent_wait", {
    ...defaults,
    description:
      "Read an owned agent's status, reply, error and pending requests; optionally wait up to 60000ms for a change. Never stops the agent.",
    parameters: CrossAgentWaitInput,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_agent_interrupt", {
    ...defaults,
    description:
      "Interrupt one agent you own; its cross-provider children keep running. Reuse requestKey on retry.",
    parameters: CrossAgentTargetInput,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_agent_close", {
    ...defaults,
    description:
      "Release an owned agent's session; its transcript and agentId stay resumable. Reuse requestKey on retry.",
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
          Effect.map((targets) => ({ targets, guidance: CROSS_PROVIDER_AGENT_GUIDANCE })),
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
