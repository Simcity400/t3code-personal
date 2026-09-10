# Thread detail agent scoping

A thread that fans out to subagents produces most of its activity inside those
agents: a single Codex turn has been observed to append 18,000 activities, of
which 16,000 were subagent tool calls, on top of hundreds of subagent
messages. Every client used to receive all of it through the thread
subscription, then filter it away in the renderer. Phones could not keep up.

## The model

A thread detail read or subscription carries an optional `agentScope`
(`packages/contracts/src/orchestration.ts`):

- `root` is the main transcript. It omits subagent messages and subagent
  `tool.*` rows, but keeps every other agent-attributed row (task lifecycle,
  requests, warnings, context updates) so agent rosters, pending cards, and
  status derive without the transcript.
- `agent:<id>` is one agent's transcript: only that agent's messages and
  activities, windowed and paged exactly like the root read.
- Absent means the pre-scoping full read. Pagination and scoping shipped
  together, so a client only sends a scope when the server advertises
  `threadAgentScoping`; older servers keep returning everything and the views
  still filter with `selectAgentTranscript`.

Clients open the root scope for the thread screen and an agent scope only when
a transcript is viewed (`ScopedAgentTranscript` on web, the agent transcript
route on mobile). Each agent scope is its own state machine keyed by thread and
scope in `packages/client-runtime/src/state/threads.ts`; it is never written to
the thread cache.

## Traps

- The root rule lives in two places that must agree:
  `apps/server/src/orchestration/threadDetailScope.ts` for live and replayed
  events, and the SQL scope conditions in
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` for
  snapshots. `AGENT_DETAIL_ACTIVITY_KINDS` is the single list of kinds the root
  transcript drops.
- Activity attribution is read from the `projection_thread_activity_agents`
  side table, not from `payload_json`. Tool payloads run to megabytes per row,
  so a `json_extract` filter would read the whole thread on every open. The
  activity repository mirrors `payload.agentId` into the side table on every
  upsert and clears it with the thread; `ensureForkColumns` creates and
  backfills it once, outside upstream's numbered migrations. Anything else that
  writes activity rows directly must keep the side table in step.
- Reconnect replay is budgeted before scoping: `getThreadReplayStats` counts
  every event in the gap, while a root client's cursor only advances on the
  events it received. After a subagent burst the gap exceeds the replay
  budget and the subscription falls back to a windowed snapshot. That is the
  cheaper path, not a bug to fix by counting scoped events.
- The agent branch of the SQL condition drives from the side table's
  `(thread_id, agent_id, sequence)` index. An `EXISTS` per candidate row scans
  the thread's whole history instead and was twenty times slower on a large
  thread.
