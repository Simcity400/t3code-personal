# Agent transcripts

T3 Code keeps the work of spawned Codex and Claude agents separate from the main conversation while still making it available as it happens.

On web and desktop, open **Agents** and select an agent. On mobile, use the **Agents** button in the thread header, then select an agent. The transcript uses the same message and tool presentation as the main conversation, including Markdown, code blocks, copy controls, expandable tool details, timestamps, and live-follow behavior. It continues updating while the agent works.

Assistant text follows the thread's response-delivery setting, just like the main conversation. With token streaming enabled, Codex child text streams as it is generated. Claude child text appears when each child message completes. Tool activity and agent status update live for both providers.

Transcripts are persisted with the thread. Agent work recorded before this feature was available may only show the existing status and summary information.
