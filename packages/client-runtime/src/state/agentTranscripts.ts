import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

export function isAgentMessage(message: Pick<OrchestrationMessage, "agentId">): boolean {
  return typeof message.agentId === "string" && message.agentId.trim().length > 0;
}

/** Select stored agent content from the loaded history window for ordinary transcript renderers. */
export function selectAgentTranscript(
  messages: readonly OrchestrationMessage[],
  activities: readonly OrchestrationThreadActivity[],
  agentId: string,
): { messages: OrchestrationMessage[]; activities: OrchestrationThreadActivity[] } {
  if (!agentId.trim()) return { messages: [], activities: [] };
  return {
    messages: messages
      .filter((message) => message.agentId === agentId)
      .map(({ agentId: _agentId, ...message }) => message),
    activities: activities.flatMap((activity) => {
      if (!activity.payload || typeof activity.payload !== "object") return [];
      const payload = activity.payload as Record<string, unknown>;
      if (payload.agentId !== agentId) return [];
      // Root renderers hide attributed rows and provider-marked timeline bypasses.
      // Remove only those routing stamps from copies; retain tool/reasoning payloads.
      const { agentId: _agentId, timelineBypass: _timelineBypass, ...scopedPayload } = payload;
      return [{ ...activity, payload: scopedPayload }];
    }),
  };
}
