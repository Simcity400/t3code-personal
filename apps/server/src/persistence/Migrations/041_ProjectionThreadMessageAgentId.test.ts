import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadMessageAgentId", (it) => {
  it.effect("adds nullable agent attribution and its thread lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const agentId = columns.find((column) => column.name === "agent_id");
      assert.equal(agentId?.name, "agent_id");
      assert.equal(agentId?.notnull, 0);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_messages)
      `;
      assert.equal(
        indexes.some(
          (index) => index.name === "idx_projection_thread_messages_thread_agent_created",
        ),
        true,
      );
    }),
  );
});
