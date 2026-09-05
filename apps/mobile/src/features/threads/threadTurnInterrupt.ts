import type { OrchestrationThreadShell } from "@t3tools/contracts";

export function buildThreadTurnInterruptInput(
  thread: Pick<OrchestrationThreadShell, "id" | "session">,
  scope: "self" | "tree" = "self",
) {
  const activeTurnId = thread.session?.activeTurnId;
  return {
    threadId: thread.id,
    scope,
    ...(scope === "self" && thread.session?.status === "running" && activeTurnId
      ? { turnId: activeTurnId }
      : {}),
  };
}
