import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isListedThread, isSideChatOf, isUnpromotedSideChat } from "./sideChat.ts";

const parent = ThreadId.make("thread-parent");
const other = ThreadId.make("thread-other");

describe("side chat predicates", () => {
  it("treats a fork without a promotion stamp as an attached side chat", () => {
    const sideChat = { id: ThreadId.make("side"), forkedFromThreadId: parent };
    expect(isUnpromotedSideChat(sideChat)).toBe(true);
    expect(isListedThread(sideChat)).toBe(false);
    expect(isSideChatOf(sideChat, parent)).toBe(true);
    expect(isSideChatOf(sideChat, other)).toBe(false);
  });

  it("lists a promoted side chat like any other thread", () => {
    const promoted = {
      id: ThreadId.make("side"),
      forkedFromThreadId: parent,
      sideChatPromotedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isUnpromotedSideChat(promoted)).toBe(false);
    expect(isListedThread(promoted)).toBe(true);
    expect(isSideChatOf(promoted, parent)).toBe(false);
  });

  it("lists threads that were never forked", () => {
    expect(isListedThread({})).toBe(true);
    expect(isListedThread({ forkedFromThreadId: null })).toBe(true);
  });
});
