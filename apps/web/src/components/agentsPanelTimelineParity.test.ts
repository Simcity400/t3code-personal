// @effect-diagnostics nodeBuiltinImport:off - reads both call sites as source text.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * A subagent transcript is supposed to be the main chat, not a thinner view of
 * it: the same `MessagesTimeline`, driven the same way. That only holds if the
 * Agents panel keeps passing what `ChatView` passes, and the failure mode when
 * it drifts is silent — every prop is optional with a no-op default, so a
 * dropped handler renders an identical-looking row that does nothing on click.
 *
 * So this reads both call sites and compares them. When an upstream sync adds a
 * prop to the main chat, this fails until the agent transcript passes it too,
 * or until the prop is listed below as main-thread-only with a reason.
 */

/** Props that belong to the main thread alone, with why they cannot apply. */
const MAIN_THREAD_ONLY: Record<string, string> = {
  // Inbound citation navigation: resolving a citation against the thread's own
  // paginated message history. An agent transcript is not paginated and is
  // never a citation target.
  citationRequest: "resolves against the thread's paginated history",
  citationHistoryLoading: "state of that history fetch",
  loadEarlier: "the thread's history pagination",
  // Chrome owned by the thread pane's layout.
  hideEmptyPlaceholder: "empty-state chrome of the chat pane",
  topFadeEnabled: "scroll chrome of the chat pane",
  isPreparingWorktree: "thread-level worktree status",
};

function timelineProps(fileName: string): ReadonlySet<string> {
  const source = NodeFS.readFileSync(`${import.meta.dirname}/${fileName}`, "utf8");
  const start = source.indexOf("<MessagesTimeline");
  expect(start, `${fileName} renders MessagesTimeline`).toBeGreaterThan(-1);
  let depth = 0;
  let end = start;
  while (end < source.length) {
    const character = source[end];
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth === 0) break;
    end += 1;
  }
  const block = source.slice(start, end);
  const named = [...block.matchAll(/^\s{2,}([a-zA-Z][a-zA-Z0-9]*)=/gm)].map((match) => match[1]!);
  // Optional handlers are spread rather than passed as undefined, because the
  // timeline treats "absent" and "undefined" differently for the cite toolbar.
  const spread = [...block.matchAll(/\{\.\.\.\([a-zA-Z0-9]+ \? \{ ([a-zA-Z0-9]+) \}/g)].map(
    (match) => match[1]!,
  );
  return new Set([...named, ...spread]);
}

describe("agent transcript timeline parity", () => {
  it("passes every main-chat timeline prop that is not main-thread-only", () => {
    const chat = timelineProps("ChatView.tsx");
    const transcript = timelineProps("AgentsPanel.tsx");
    expect(chat.size).toBeGreaterThan(20);

    const missing = [...chat].filter(
      (prop) => !transcript.has(prop) && !(prop in MAIN_THREAD_ONLY),
    );
    expect(missing).toEqual([]);
  });

  it("does not exempt a prop the agent transcript actually passes", () => {
    const transcript = timelineProps("AgentsPanel.tsx");
    // A stale exemption would hide a real regression behind a reason that no
    // longer applies.
    expect(Object.keys(MAIN_THREAD_ONLY).filter((prop) => transcript.has(prop))).toEqual([]);
  });
});
