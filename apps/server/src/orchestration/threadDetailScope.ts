import {
  threadActivityAgentId,
  threadDetailScopeAgentId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type ThreadDetailAgentScope,
} from "@t3tools/contracts";

/**
 * Subagent rows only an agent transcript renders. Every other agent-attributed
 * row (task lifecycle, requests, warnings, context updates) stays in the root
 * thread so rosters, pending cards, and status keep working without the
 * transcript. Mirrored in SQL by ProjectionSnapshotQuery's scope conditions.
 */
export const AGENT_DETAIL_ACTIVITY_KINDS: ReadonlyArray<string> = [
  "tool.started",
  "tool.updated",
  "tool.completed",
];

export function messageMatchesThreadDetailScope(
  message: { readonly agentId?: string | undefined },
  scope: ThreadDetailAgentScope | undefined,
): boolean {
  if (scope === undefined) return true;
  const agentId =
    typeof message.agentId === "string" && message.agentId.trim().length > 0
      ? message.agentId
      : null;
  const scopedAgentId = threadDetailScopeAgentId(scope);
  return scopedAgentId === null ? agentId === null : agentId === scopedAgentId;
}

export function activityMatchesThreadDetailScope(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
  scope: ThreadDetailAgentScope | undefined,
): boolean {
  if (scope === undefined) return true;
  const agentId = threadActivityAgentId(activity.payload);
  const scopedAgentId = threadDetailScopeAgentId(scope);
  if (scopedAgentId !== null) return agentId === scopedAgentId;
  return agentId === null || !AGENT_DETAIL_ACTIVITY_KINDS.includes(activity.kind);
}

/** Thread-level events pass every scope; only attributed content is filtered. */
export function eventMatchesThreadDetailScope(
  event: OrchestrationEvent,
  scope: ThreadDetailAgentScope | undefined,
): boolean {
  if (scope === undefined) return true;
  switch (event.type) {
    case "thread.message-sent":
      return messageMatchesThreadDetailScope(event.payload, scope);
    case "thread.activity-appended":
      return activityMatchesThreadDetailScope(event.payload.activity, scope);
    default:
      return true;
  }
}
