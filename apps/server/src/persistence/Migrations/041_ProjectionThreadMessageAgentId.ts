import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Guarded like its sibling 042: a database restored from another checkout
  // can carry the column while the migrations ledger does not.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "agent_id")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN agent_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_agent_created
    ON projection_thread_messages(thread_id, agent_id, created_at)
  `;
});
