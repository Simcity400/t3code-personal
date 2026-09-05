import { ThreadId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectTaskActivity } from "../../../../apps/server/src/orchestration/taskState.ts";

/** Feed provider activities through the actual server projection before testing client presentation. */
export function projectedTaskActivities(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  let states: ReadonlyArray<OrchestrationThreadActivity> = [];
  for (const activity of activities) {
    const updates = projectTaskActivity(ThreadId.make("fixture"), states, activity);
    const ids = new Set(updates.map((row) => row.id));
    states = [...states.filter((row) => !ids.has(row.id)), ...updates];
  }
  return [...activities, ...states];
}
