import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { relatedChats } from "./sideChat.ts";

const chat = (id: string, parent?: string, environment = "local") => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make(environment),
  projectId: ProjectId.make("project"),
  createdAt: "2026-09-08T00:00:00.000Z",
  ...(parent ? { forkedFromThreadId: ThreadId.make(parent) } : {}),
});
describe("related chat navigation", () => {
  it("keeps the parent, children and siblings reachable from a nested chat", () => {
    const current = chat("child", "parent");
    expect(
      relatedChats(current, [
        chat("sibling", "parent"),
        chat("grandchild", "child"),
        current,
        chat("parent"),
        chat("unrelated"),
      ]).map(({ thread, relation }) => [thread.id, relation]),
    ).toEqual([
      ["parent", "Original thread"],
      ["grandchild", "Side chat"],
      ["sibling", "Related side chat"],
    ]);
  });
  it("never crosses environments or projects with matching identifiers", () => {
    expect(
      relatedChats(chat("parent"), [
        chat("child", "parent", "remote"),
        { ...chat("other", "parent"), projectId: ProjectId.make("other-project") },
      ]),
    ).toEqual([]);
  });
  it("keeps children reachable after the original parent disappears", () => {
    expect(
      relatedChats(chat("child", "deleted"), [chat("grandchild", "child")]).map(
        ({ thread }) => thread.id,
      ),
    ).toEqual(["grandchild"]);
  });
  it("keeps long titles intact and sorts recent chats first", () => {
    const newer = {
      ...chat("new", "parent"),
      title: "Long title ".repeat(100),
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    expect(relatedChats(chat("parent"), [chat("old", "parent"), newer])[0]?.thread).toBe(newer);
  });
});
