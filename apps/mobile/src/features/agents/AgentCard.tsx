import {
  formatSubagentTitle,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { agentStatusAccessibilityLabel, formatAgentElapsed } from "./ThreadAgentsRouteScreen.logic";
import type { AgentStatusClockSnapshot } from "./agentStatusClock";

function agentStatusLabel(agent: RuntimeSubagent): string {
  switch (agent.status) {
    case "pending":
    case "running":
    case "waiting":
      return "Working";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
  }
}

function agentStatusPresentation(agent: RuntimeSubagent, clock: AgentStatusClockSnapshot) {
  const working = isActiveSubagentStatus(agent.status);
  const startedAt = agent.startedAt ?? agent.firstSeenAt;
  const endedAtMs = working
    ? clock.nowMs
    : Date.parse(agent.completedAt ?? agent.updatedAt ?? agent.firstSeenAt);
  const elapsed = startedAt ? formatAgentElapsed(startedAt, endedAtMs) : null;
  const status = agentStatusLabel(agent);
  return {
    working,
    elapsed,
    status,
    accessibilityLabel: agentStatusAccessibilityLabel(status, elapsed),
  };
}

export function AgentStatus({
  agent,
  clock,
}: {
  readonly agent: RuntimeSubagent;
  readonly clock: AgentStatusClockSnapshot;
}) {
  const presentation = agentStatusPresentation(agent, clock);

  return (
    <Text
      accessibilityLabel={presentation.accessibilityLabel}
      className="text-xs tabular-nums text-foreground-muted"
    >
      {presentation.status}
      {presentation.elapsed ? ` \u00b7 ${presentation.elapsed}` : ""}
    </Text>
  );
}

function AgentCardImpl({
  agent,
  clock,
  onOpen,
}: {
  readonly agent: RuntimeSubagent;
  readonly clock: AgentStatusClockSnapshot;
  readonly onOpen: (agentId: string) => void;
}) {
  const title = formatSubagentTitle(agent.title);
  const status = agentStatusPresentation(agent, clock);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title} transcript. ${status.accessibilityLabel}`}
      onPress={() => onOpen(agent.id)}
      className="rounded-xl bg-card px-3 py-3 active:opacity-70"
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm font-t3-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <AgentStatus agent={agent} clock={clock} />
      </View>
      <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
        {agent.progress ?? agent.result ?? agent.error ?? agent.role ?? "No activity yet"}
      </Text>
    </Pressable>
  );
}

// The status clock publishes a new snapshot every second while any agent is
// active; without this guard every card in the list re-renders each tick.
// Settled cards render their elapsed time from completedAt/updatedAt, so they
// can ignore clock ticks entirely.
export const AgentCard = memo(
  AgentCardImpl,
  (prev, next) =>
    prev.agent === next.agent &&
    prev.onOpen === next.onOpen &&
    (!isActiveSubagentStatus(next.agent.status) || prev.clock.tick === next.clock.tick),
);
