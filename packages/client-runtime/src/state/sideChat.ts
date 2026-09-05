import type { OrchestrationThreadShell } from "@t3tools/contracts";

export type SideChatThreadFields = Pick<
  OrchestrationThreadShell,
  "forkedFromThreadId" | "sideChatPromotedAt"
>;

/**
 * A side chat is a provider-native fork that stays attached to its parent
 * thread until the user promotes it. While attached it is hidden from every
 * thread list, launcher, and fallback-selection path; promotion clears that.
 */
export function isUnpromotedSideChat(thread: SideChatThreadFields): boolean {
  return thread.forkedFromThreadId != null && thread.sideChatPromotedAt == null;
}

/** Threads that belong in the normal thread lists: everything but attached side chats. */
export function isListedThread(thread: SideChatThreadFields): boolean {
  return !isUnpromotedSideChat(thread);
}

/** Attached side chats of `parentThreadId`, in shell order. */
export function isSideChatOf<T extends SideChatThreadFields & { readonly id: unknown }>(
  thread: T,
  parentThreadId: T["id"],
): boolean {
  return thread.forkedFromThreadId === parentThreadId && thread.sideChatPromotedAt == null;
}
