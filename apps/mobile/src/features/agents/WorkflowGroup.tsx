import { View } from "react-native";
import type { AgentPanelWorkflowGroup } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/contextWindow";
import { AppText as Text } from "../../components/AppText";
import { AgentCard } from "./AgentCard";
import type { AgentStatusClockSnapshot } from "./agentStatusClock";

export function WorkflowGroup({
  group,
  clock,
  windows,
  onOpen,
}: {
  group: AgentPanelWorkflowGroup;
  clock: AgentStatusClockSnapshot;
  windows: ReadonlyMap<string | null, ContextWindowSnapshot>;
  onOpen: (id: string) => void;
}) {
  const card = (agent: AgentPanelWorkflowGroup["workflow"]) => (
    <AgentCard
      key={agent.id}
      agent={agent}
      clock={clock}
      contextWindow={windows.get(agent.id) ?? null}
      onOpen={onOpen}
    />
  );
  return (
    <View className="gap-2 rounded-xl border border-border p-2">
      {card(group.workflow)}
      {group.phases.map((phase) => (
        <View key={phase.index} className="gap-2 pl-2">
          <Text className="text-xs font-t3-semibold text-foreground-muted">
            {phase.title} · {phase.settledCount}/{phase.members.length} finished
          </Text>
          {phase.members.map(card)}
        </View>
      ))}
      {group.unphasedMembers.map(card)}
    </View>
  );
}
