# Cross-provider agents

An agent can delegate an assignment to another locally configured provider. The child appears in **Agents**, alongside native subagents, with its own transcript, tools, questions, status, and usage when the provider reports them. Web, desktop, and mobile observe the same work in the connected environment.

Enable **Agent Browser access** before starting the parent session. Cross-provider delegation uses the authenticated tools attached to that session. A raw CLI command launched in a terminal does not receive this integration. Same-provider delegation continues to use the provider's native tools. Externally hosted OpenCode sessions are not supported by this bridge.

## Stopping and messaging

**Stop** in the main conversation stops only the main agent. Independently managed children keep working. **Stop** beside a child stops only that child; independent grandchildren continue. **Stop all** explicitly interrupts the main agent and its descendants in this thread, not other threads.

Some native descendants share a provider process that cannot be interrupted independently. T3 disables unsupported individual controls or reports an error; it does not silently turn an individual Stop into Stop all. A failed stop is not confirmation that work has ended.

Cursor and Grok do not expose enough information to verify independent native cancellation, so their Stop requires explicit **Stop all**. Independently managed children of other providers still have their own supported controls.

Agents can send follow-up instructions to their owned descendants. Codex can accept live steering; other providers queue ordinary messages until their current turn ends. Interrupt-and-redirect stops the recipient first, then sends the replacement instruction. An agent cannot interrupt its ancestors or siblings.

A child can send a message to its parent. Messages to the main agent are retained until its next input; they do not wake a stopped main agent. A queued message is not yet delivered. Questions remain pending until their answers reach the child, or show cancellation if the child stops first.

Follow-up-message answers to a native descendant inside a bridge child are not supported unless the provider exposes individual delivery. T3 reports this limitation instead of sending the answer to the wrong agent.

A manual Stop clears the child's queued work and prevents agents from restarting it. Use **Resume** on the child to explicitly continue. Finished, failed, and released children can also be resumed. Resuming one agent does not resume the whole tree. Archiving a thread does not stop its children; deleting the thread releases its owned sessions and removes the ability to resume them.

## Resume by the same agent ID

The `cross-provider:…` agent ID belongs to T3, not to an individual provider process. T3 saves the assignment, provider configuration reference, native conversation cursor, most recent instruction, and bounded recovery context in the environment's database. Transcripts and this identity survive server restarts. Lost executions are marked interrupted and remain available through **Resume**; restarting the server never automatically starts them.

Resume first uses the existing native conversation when possible. If native history is missing, including after an early startup interruption or an account change that makes that history unavailable, T3 recovers into a fresh provider session under the **same T3 agent ID**. A notice appears in its transcript. The recovery prompt includes the original assignment and saved context and instructs the agent to inspect previous tool outcomes before repeating work. This is reconstructed context, not a claim that a provider's lost internal state was restored exactly.

Closing a child releases its process resources, not its identity. You can resume the same ID later; independent descendants are unaffected. Agents can continue non-manually-stopped children with `t3_agent_send_input` using that ID. Only explicit user Resume clears a manual Stop.

Working credentials and an available local provider configuration are still required. Authentication errors, usage limits, unavailable providers, or a full execution capacity are reported without deleting the agent ID. Fix the underlying condition and resume that same ID again. Native-history fallback is attempted once per activation, not in an unlimited retry loop. Deleting the thread or its environment data deliberately removes recovery; keep database backups if you need protection from data loss.

## Reusable agent instructions

Copy this block into your project's agent instructions:

```md
### Cross-provider delegation in T3 Code

- Use native subagent tools for the same provider. For another provider, call
  `t3_agent_targets`, then `t3_agent_spawn` with its `providerInstanceId`, a
  self-contained `prompt`, and a unique `requestKey`. Use only available targets.
- Assign non-overlapping files for concurrent edits. Children share this workspace
  and inherit its permission and interaction modes; they do not clone your context.
- Keep the returned `agentId`. Use `t3_agent_wait` to read progress/results; a wait
  timeout or cancellation does not stop the child.
- Use `t3_agent_send_input` for follow-ups. Delivery may be queued. Set
  `interrupt: true` only to interrupt and redirect an owned descendant. A child may send to
  `agentId: "parent"`, but may not interrupt it. Do not message or stop siblings.
- Use `t3_agent_interrupt` to interrupt one child, or `t3_agent_close` when its
  session is no longer needed. Independent descendants continue. Never override
  a manual user Stop; wait for explicit user Resume. Never broaden a failed Stop.
- Reuse the same requestKey and arguments when retrying a write after a transport
  failure. Report unavailable providers, limits, and errors; do not silently fall
  back to raw CLI launches. Keep the same T3 agent ID across restarts and recovery;
  inspect prior tool outcomes before repeating work after an interruption.
```

Native children sometimes share their parent's tool credential. If the provider does not identify the actual caller, T3 attaches a cross-provider launch to the nearest identifiable session owner.
