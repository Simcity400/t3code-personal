import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import type { CrossProviderAgentBridge } from "../../provider/CrossProviderAgentBridge.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../McpInvocationContext.ts";
import { CrossProviderAgentToolkitRegistrationLive } from "./cross-provider-agents.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("cross-provider-session:child"),
  visibleThreadId: ThreadId.make("root"),
  providerSessionId: "child-session",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bridge-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const requests = [
  { name: "t3_agent_targets", arguments: {} },
  {
    name: "t3_agent_spawn",
    arguments: { providerInstanceId: "codex", prompt: "Review", requestKey: "spawn-key" },
  },
  {
    name: "t3_agent_send_input",
    arguments: { agentId: "parent", prompt: "Update", requestKey: "send-key" },
  },
  { name: "t3_agent_wait", arguments: { agentId: "child", timeoutMs: 0 } },
  { name: "t3_agent_interrupt", arguments: { agentId: "child", requestKey: "interrupt-key" } },
  { name: "t3_agent_close", arguments: { agentId: "child", requestKey: "close-key" } },
];
const makeLayer = (bridge?: Partial<CrossProviderAgentBridge>) =>
  CrossProviderAgentToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.succeed(
        ProviderService,
        (bridge
          ? { crossProviderAgents: bridge as CrossProviderAgentBridge }
          : {}) as ProviderService["Service"],
      ),
    ),
  );
const call = (
  server: McpServer.McpServer["Service"],
  request: (typeof requests)[number],
  invocation = scope,
) =>
  server
    .callTool(request)
    .pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
const forbiddenBridge = {
  targets: () => Effect.die("must not invoke bridge"),
  spawn: () => Effect.die("must not invoke bridge"),
  send: () => Effect.die("must not invoke bridge"),
  wait: () => Effect.die("must not invoke bridge"),
  control: () => Effect.die("must not invoke bridge"),
};

it.effect(
  "registers all six tools and retains authenticated child identity and write retry keys",
  () => {
    const received: unknown[] = [];
    const record = (invocation: McpInvocationScope, input?: unknown, action?: string) => {
      received.push({ invocation, input, action });
      return Effect.succeed({ accepted: true });
    };
    const bridge = {
      targets: (invocation: McpInvocationScope) => record(invocation).pipe(Effect.as([])),
      spawn: record,
      send: record,
      wait: record,
      control: record,
    } as unknown as CrossProviderAgentBridge;
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual(
        requests.map((r) => r.name).sort(),
      );
      for (const request of requests) {
        const result = yield* call(server, request);
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual(
          request.name === "t3_agent_targets" ? { targets: [] } : { accepted: true },
        );
      }
      expect(received).toEqual(
        requests.map((request, index) => ({
          invocation: scope,
          input: index === 0 ? undefined : request.arguments,
          action: index === 4 ? "interrupt" : index === 5 ? "close" : undefined,
        })),
      );
    }).pipe(Effect.provide(makeLayer(bridge)));
  },
);

it.effect("checks preview capability before bridge authorization for every tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const request of requests) {
      const result = yield* call(server, request, { ...scope, capabilities: new Set() });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "MCP credential does not grant the preview capability." },
      ]);
    }
  }).pipe(Effect.provide(makeLayer(forbiddenBridge))),
);

it.effect("reports bridge authorization failures for every tool", () => {
  const denied = () =>
    Effect.fail(
      new ProviderValidationError({
        operation: "authorize",
        issue: "Agent Browser access is disabled",
      }),
    );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const request of requests) {
      const result = yield* call(server, request);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("Agent Browser access is disabled") },
      ]);
    }
  }).pipe(
    Effect.provide(
      makeLayer({
        targets: denied,
        spawn: denied,
        send: denied,
        wait: denied,
        control: denied,
      }),
    ),
  );
});

it.effect("reports an unavailable bridge for legacy ProviderService mocks", () =>
  Effect.gen(function* () {
    const result = yield* call(yield* McpServer.McpServer, requests[0]!);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Cross-provider agents are unavailable in this environment." },
    ]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("rejects malformed inputs before authorizing or starting provider work", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const request of [
      { name: "t3_agent_spawn", arguments: { providerInstanceId: "codex", prompt: "" } },
      { name: "t3_agent_wait", arguments: { agentId: "child", timeoutMs: 60001 } },
      {
        name: "t3_agent_send_input",
        arguments: { agentId: "child", prompt: "go", interrupt: "yes" },
      },
      { name: "t3_agent_close", arguments: { agentId: "child", requestKey: "" } },
    ]) {
      const error = yield* server
        .callTool(request)
        .pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(error._tag).toBe("InvalidParams");
    }
  }).pipe(Effect.provide(makeLayer(forbiddenBridge))),
);
