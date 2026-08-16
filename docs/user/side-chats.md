# Side chats

Use a side chat to explore a question with the current conversation's context without adding the
exploration to the normal thread list.

Type `/side` followed by your first message, for example:

```text
/side compare these two implementation approaches
```

T3 Code creates a real provider conversation fork. Codex uses its native thread fork and Claude
uses its native session fork, so the side chat receives the original thread's context without a
copied summary. Side chats are not subagents and do not appear in the Agents view.

Open an existing side chat from the **Side chats** strip on its original thread. While viewing the
side chat, use **Promote to thread** to move it into the normal thread list. Promotion keeps the
same conversation and provider session; it does not copy or restart the chat.

Side chats require a resumable provider conversation. A thread that has never started cannot be
forked yet.
