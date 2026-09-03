import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentTitle,
  isActiveSubagentStatus,
  subagentPanelSection,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { LegendListRef } from "@legendapp/list/react-native";
import { EnvironmentId } from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { LoadingScreen } from "../../components/LoadingScreen";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { buildThreadFeed } from "../../lib/threadActivity";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadFeed } from "../threads/ThreadFeed";
import { AgentCard, AgentStatus } from "./AgentCard";
import { useAgentStatusClock } from "./agentStatusClock";

type ThreadAgentsRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function ThreadAgentsRouteScreen(_props: ThreadAgentsRouteScreenProps) {
  const thread = useSelectedThreadDetail();
  const { selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [idleOpen, setIdleOpen] = useState(true);
  const chevronColor = useUniwindTheme()["--color-chevron"];
  const transcriptListRef = useRef<LegendListRef>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  const agents = useMemo(
    () =>
      thread
        ? foldSubagentActivities(thread.activities, {
            // Keep the transcript being read alive even when live activity
            // pushes it past the roster cap.
            protectedAgentIds: selectedAgentId ? [selectedAgentId] : [],
          })
        : [],
    [thread, selectedAgentId],
  );
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
  const activeAgents = useMemo(
    () => allAgents.filter((agent) => subagentPanelSection(agent.status) === "active"),
    [allAgents],
  );
  const idleAgents = useMemo(
    () => allAgents.filter((agent) => subagentPanelSection(agent.status) === "idle"),
    [allAgents],
  );
  const selectedAgentTitle = selectedAgent ? formatSubagentTitle(selectedAgent.title) : null;
  const openAgent = useCallback((agentId: string) => setSelectedAgentId(agentId), []);
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
  const statusClock = useAgentStatusClock(activeAgents.length > 0 || selectedAgentWorking);
  // The status clock re-renders this screen every second while agents are
  // active; a fresh latestTurn object here would defeat ThreadFeed's memo and
  // reconcile the whole transcript list on every tick.
  const transcriptLatestTurn = useMemo(() => {
    if (!selectedAgent || !transcriptTurnId) {
      return null;
    }
    const working = isActiveSubagentStatus(selectedAgent.status);
    return {
      turnId: transcriptTurnId,
      state: working
        ? ("running" as const)
        : selectedAgent.status === "failed"
          ? ("error" as const)
          : selectedAgent.status === "cancelled" || selectedAgent.status === "interrupted"
            ? ("interrupted" as const)
            : ("completed" as const),
      startedAt: selectedAgent.startedAt,
      completedAt: working ? null : (selectedAgent.completedAt ?? selectedAgent.updatedAt),
    };
  }, [
    selectedAgent,
    transcriptTurnId,
    selectedAgent?.status,
    selectedAgent?.startedAt,
    selectedAgent?.completedAt,
    selectedAgent?.updatedAt,
  ]);
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
            <AgentStatus agent={selectedAgent} clock={statusClock} />
          </View>
        </View>
        <ThreadFeed
          key={selectedAgent.id}
          keyboardAware={false}
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
          // Read-only transcript: nothing is ever submitted from this surface.
          submittedMessageId={null}
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
          <>
            {activeAgents.length > 0 ? (
              <View className="gap-2 rounded-2xl border border-primary/25 bg-card/40 p-2">
                <View className="flex-row items-center gap-2 px-1 py-1">
                  <Text className="text-xs font-t3-semibold uppercase tracking-wider text-primary">
                    Active
                  </Text>
                  <Text className="text-xs text-foreground-muted">{activeAgents.length}</Text>
                </View>
                {activeAgents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} clock={statusClock} onOpen={openAgent} />
                ))}
              </View>
            ) : null}
            {idleAgents.length > 0 ? (
              <View className="rounded-2xl border border-border bg-card/20 p-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${idleOpen ? "Hide" : "Show"} idle agents`}
                  accessibilityState={{ expanded: idleOpen }}
                  onPress={() => setIdleOpen((value) => !value)}
                  className="flex-row items-center gap-2 rounded-lg px-1 py-1 active:opacity-70"
                >
                  <SymbolView
                    name={idleOpen ? "chevron.down" : "chevron.right"}
                    size={14}
                    tintColor={chevronColor}
                    type="monochrome"
                  />
                  <Text className="text-xs font-t3-semibold uppercase tracking-wider text-foreground-muted">
                    Idle
                  </Text>
                  <Text className="text-xs text-foreground-muted">{idleAgents.length}</Text>
                </Pressable>
                {idleOpen ? (
                  <View className="mt-1 gap-2">
                    {idleAgents.map((agent) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        clock={statusClock}
                        onOpen={openAgent}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
