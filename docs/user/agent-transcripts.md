# Agent transcripts

T3 Code keeps the work of spawned agents separate from the main conversation when the provider exposes that work.

On web and desktop, open **Agents** and select an agent. On mobile, use the **Agents** button in the thread header, then select an agent. The transcript uses the same message and tool presentation as the main conversation, including Markdown, code blocks, copy controls, expandable tool details, timestamps, and live-follow behavior. It continues updating while the agent works.

While subagents are active, their count appears beside the working status above the composer. Select the count to open **Agents**. The count includes starting, running, and waiting subagents and disappears when none are active.

Assistant text follows the thread's response-delivery setting, just like the main conversation. Text streams when the provider supplies streaming child messages. Tool activity and agent status update live.

The Agents roster survives reloading long conversations. Selecting a resumed agent opens its latest turn on every client. Idle agent timers stop at their last recorded update.

The **Idle** section remembers whether you collapsed or expanded it when you switch threads or reopen Agents during the same app session. Each thread and connected environment keeps its own choice.

Agents use the name supplied by their provider. If the provider only supplies an ID, the opening line of the agent's assignment becomes its label when those instructions are available. The roster leaves out role badges to make more room for names.

Transcripts are persisted with the thread. Agent work recorded before this feature was available may only show the existing status and summary information.

Instructions sent to an agent appear as user messages, including the original assignment and subsequent instructions. An agent's own final message stays in its transcript; it is not automatically copied into the main conversation. Use **Load earlier turns** to read older conversation history.

The Agents panel groups background tasks by their owner, including **Main**. Workflow phases, retries, and token usage are shown when the provider supplies them. Agent and task records survive long work logs and reconnects.

Use the square **Stop** icon beside a running agent or task to stop just that work. On web and desktop, hovering anywhere on an agent row highlights its full width, including the stop control. Claude supports native task stopping; Codex and OpenCode support stopping individual child agents. Other providers may expose a task without exposing an individual stop operation; the control explains when that operation is unavailable. A rejected individual stop reports an error and leaves the parent session running.

Older threads recorded before the current task roster was introduced are not backfilled. New provider activity creates current task records.
