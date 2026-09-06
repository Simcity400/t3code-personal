# Side chats

A side chat lets you ask something aside, with the current conversation's full context, without
adding the detour to the thread itself or to the thread list.

## Open one

Type `/side` in the composer and press Enter. The side chat opens as a tab in the right panel,
next to Browser, Terminal, Files, Diff, and Agents, with the cursor ready for your question.

You can also start it from the panel's **+** menu (**Side chat**, shortcut **S** while the menu
is open), or type the first question inline:

```text
/side compare these two implementation approaches
```

T3 Code creates a real provider conversation fork. Codex uses its native thread fork and Claude
uses its native session fork, so the side chat receives the original thread's context without a
copied summary. The side chat uses the same model and workspace as the thread it came from. Side
chats are not subagents and do not appear in the Agents view.

Side chats require a conversation that has already started, so send the first message of a thread
before forking it.

## Work in it

The panel composer takes text. Enter sends, Shift+Enter adds a line, and **Stop** interrupts a
running reply. For attachments, mentions, approvals, or anything else the main composer offers,
use **Open full view** in the tab header; the draft you typed comes with you.

Several side chats can be open as tabs at once. Closed tabs are not lost: reopen any side chat from
the panel's **+** menu on its original thread, or from the panel's launcher when no tab is open.

## Keep it or close it

- **Add to main threads** moves the side chat into the normal thread list. It keeps the same
  conversation and provider session; nothing is copied or restarted.
- **Close side chat** deletes it, including its messages.

Deleting the original thread keeps its side chats: they move to the thread list as their own
threads.

## On mobile

`/side` works the same way on the phone. The side chat opens as its own screen rather than a panel,
with **Add to main threads** and **Close** in the header.
