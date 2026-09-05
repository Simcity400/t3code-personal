/** Provider task classification is fixed by the server; this predicate scopes transcript rows. */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}
