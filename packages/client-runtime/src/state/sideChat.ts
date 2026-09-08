import type { EnvironmentThreadShell } from "./shell.ts";

/** Keep navigation local to this environment and project, including nested forks. */
type RelatedThread = Pick<
  EnvironmentThreadShell,
  "id" | "projectId" | "environmentId" | "forkedFromThreadId" | "createdAt"
>;

export function relatedChats<T extends RelatedThread>(
  current: RelatedThread,
  threads: ReadonlyArray<T>,
) {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === current.environmentId &&
        thread.projectId === current.projectId &&
        thread.id !== current.id &&
        (thread.id === current.forkedFromThreadId ||
          thread.forkedFromThreadId === current.id ||
          (current.forkedFromThreadId != null &&
            thread.forkedFromThreadId === current.forkedFromThreadId)),
    )
    .map((thread) => ({
      thread,
      relation:
        thread.id === current.forkedFromThreadId
          ? "Original thread"
          : thread.forkedFromThreadId === current.id
            ? "Side chat"
            : "Related side chat",
    }))
    .sort((a, b) => {
      if (a.relation === "Original thread") return -1;
      if (b.relation === "Original thread") return 1;
      return (
        b.thread.createdAt.localeCompare(a.thread.createdAt) ||
        a.thread.id.localeCompare(b.thread.id)
      );
    });
}
