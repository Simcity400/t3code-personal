import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentTitle,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { LegendListRef } from "@legendapp/list/react-native";
import { EnvironmentId } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadFeed } from "../../lib/threadActivity";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadFeed } from "../threads/ThreadFeed";

type ThreadAgentsRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

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

export function ThreadAgentsRouteScreen(_props: ThreadAgentsRouteScreenProps) {
  const thread = useSelectedThreadDetail();
  const { selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const transcriptListRef = useRef<LegendListRef>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  const agents = useMemo(() => (thread ? foldSubagentActivities(thread.activities) : []), [thread]);
  const model = useMemo(() => deriveAgentPanelModel({ agents, v2Projection: null }), [agents]);
  const allAgents = useMemo(
    () => [
      ...model.directAgents,
      ...model.workflows.flatMap((group) => [
        group.workflow,
        ...group.phases.flatMap((phase) => phase.members),
        ...group.unphasedMembers,
      ]),
    ],
    [model],
  );
  const selectedAgent = allAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentTitle = selectedAgent ? formatSubagentTitle(selectedAgent.title) : null;
  const transcript = useMemo(
    () => (thread && selectedAgent ? buildThreadFeed(thread, { agentId: selectedAgent.id }) : []),
    [selectedAgent, thread],
  );
  const transcriptTurnId = useMemo(() => {
    for (const entry of transcript) {
      if (entry.type === "message" && entry.message.turnId !== null) {
        return entry.message.turnId;
      }
      if (entry.type === "activity-group" && entry.turnId !== null) {
        return entry.turnId;
      }
    }
    return null;
  }, [transcript]);
  const selectedAgentWorking = selectedAgent ? isActiveSubagentStatus(selectedAgent.status) : false;
  const transcriptLatestTurn =
    selectedAgent && transcriptTurnId
      ? {
          turnId: transcriptTurnId,
          state: selectedAgentWorking
            ? ("running" as const)
            : selectedAgent.status === "failed"
              ? ("error" as const)
              : selectedAgent.status === "cancelled" || selectedAgent.status === "interrupted"
                ? ("interrupted" as const)
                : ("completed" as const),
          startedAt: selectedAgent.startedAt,
          completedAt: selectedAgentWorking
            ? null
            : (selectedAgent.completedAt ?? selectedAgent.updatedAt),
        }
      : null;
  const selectedProviderSkills = useMemo(
    () =>
      thread
        ? (selectedEnvironmentRuntime?.serverConfig?.providers.find(
            (provider) => provider.instanceId === thread.modelSelection.instanceId,
          )?.skills ?? [])
        : [],
    [selectedEnvironmentRuntime?.serverConfig?.providers, thread],
  );

  if (!thread) {
    return <LoadingScreen message="Loading agents…" />;
  }

  if (selectedAgent) {
    return (
      <View className="flex-1 bg-screen">
        <View className="border-b border-border px-4 py-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to agents"
            onPress={() => setSelectedAgentId(null)}
            className="mb-2 self-start"
          >
            <Text className="text-sm font-t3-medium text-primary">‹ Agents</Text>
          </Pressable>
          <View className="flex-row items-center justify-between gap-3">
            <Text
              className="min-w-0 flex-1 text-base font-t3-semibold text-foreground"
              numberOfLines={1}
            >
              {selectedAgentTitle}
            </Text>
            <Text className="text-xs text-foreground-muted">{agentStatusLabel(selectedAgent)}</Text>
          </View>
        </View>
        <ThreadFeed
          key={selectedAgent.id}
          environmentId={EnvironmentId.make(_props.route.params.environmentId)}
          threadId={thread.id}
          workspaceRoot={selectedThreadCwd}
          feed={transcript}
          contentPresentation={{ kind: "ready" }}
          agentLabel={selectedAgentTitle ?? selectedAgent.title}
          latestTurn={transcriptLatestTurn}
          activeWorkStartedAt={
            selectedAgentWorking ? (selectedAgent.startedAt ?? selectedAgent.firstSeenAt) : null
          }
          listRef={transcriptListRef}
          freeze={freeze}
          anchorMessageId={null}
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          contentTopInset={0}
          contentBottomInset={18}
          skills={selectedProviderSkills}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      <ScrollView contentContainerClassName="gap-2 p-3">
        {allAgents.length === 0 ? (
          <View className="items-center px-8 py-16">
            <Text className="text-base font-t3-semibold text-foreground">No agents yet</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-foreground-muted">
              Subagents spawned by Codex or Claude will appear here with live transcripts.
            </Text>
          </View>
        ) : (
          allAgents.map((agent) => (
            <Pressable
              key={agent.id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${formatSubagentTitle(agent.title)} transcript`}
              onPress={() => setSelectedAgentId(agent.id)}
              className="rounded-xl bg-card px-3 py-3 active:opacity-70"
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text
                  className="min-w-0 flex-1 text-sm font-t3-semibold text-foreground"
                  numberOfLines={1}
                >
                  {formatSubagentTitle(agent.title)}
                </Text>
                <Text className="text-xs text-foreground-muted">{agentStatusLabel(agent)}</Text>
              </View>
              <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
                {agent.progress ?? agent.result ?? agent.error ?? agent.role ?? "No activity yet"}
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}
