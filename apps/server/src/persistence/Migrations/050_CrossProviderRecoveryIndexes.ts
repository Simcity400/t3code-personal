import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_bridge_tasks
    ON projection_thread_activities(thread_id)
    WHERE kind = 'task.state'
      AND json_extract(payload_json, '$.executionOwner') = 'cross-provider'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_bridge_requests
    ON projection_thread_activities(thread_id, sequence DESC, created_at DESC, activity_id DESC)
    WHERE kind IN ('approval.requested', 'approval.resolved', 'user-input.requested', 'user-input.resolved')
      AND json_extract(payload_json, '$.bridgeAgentId') IS NOT NULL
      AND json_extract(payload_json, '$.requestId') IS NOT NULL
  `;
});
