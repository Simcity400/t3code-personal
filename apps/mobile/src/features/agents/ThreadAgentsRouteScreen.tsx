import {
  deriveAgentPanelModel,
  flattenAgentPanelRoster,
  foldSubagentActivities,
  formatSubagentTitle,
  isActiveSubagentStatus,
  subagentPanelSection,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  deriveAgentWaitReasons,
  deriveAgentWaitStates,
  deriveCompactingSince,
  deriveDetachedTaskIds,
  deriveBackgroundTasksPanelModel,
  deriveOpenRequestWaits,
  foldBackgroundTasks,
} from "@t3tools/client-runtime/state/backgroundTasks";
import { deriveContextWindowSnapshotsByAgent } from "@t3tools/client-runtime/state/contextWindow";
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
import { ContextWindowChip } from "./ContextWindowChip";
import { buildThreadFeed } from "../../lib/threadActivity";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadFeed } from "../threads/ThreadFeed";
import { AgentCard, AgentStatus } from "./AgentCard";
import { useAgentStatusClock } from "./agentStatusClock";
import { BackgroundTasksSection, WaitingOnSection } from "./BackgroundTasksSection";

type ThreadAgentsRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function ThreadAgentsRouteScreen(_props: ThreadAgentsRouteScreenProps) {
  const thread = useSelectedThreadDetail();
  const activities = thread?.activities;
  const { selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [idleOpen, setIdleOpen] = useState(true);
  const chevronColor = useUniwindTheme()["--color-chevron"];
  const transcriptListRef = useRef<LegendListRef>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  // Same liveness rule web uses (derivePhase !== "disconnected"): work dies
  // with its provider session, so a dead session must settle its rows instead
  // of leaving them "Working"/"Running" and ticking forever. The roster needs
  // it as much as the task fold, because those agents feed the wait lines.
  const sessionStatus = thread?.session?.status ?? null;
  const agentSessionLive =
    sessionStatus !== null &&
    sessionStatus !== "stopped" &&
    sessionStatus !== "interrupted" &&
    sessionStatus !== "error";
  const agents = useMemo(
    () =>
      activities
        ? foldSubagentActivities(activities, {
            sessionLive: agentSessionLive,
            // Keep the transcript being read alive even when live activity
            // pushes it past the roster cap.
            protectedAgentIds: selectedAgentId ? [selectedAgentId] : [],
          })
        : [],
    [agentSessionLive, activities, selectedAgentId],
  );
  const model = useMemo(() => deriveAgentPanelModel({ agents, v2Projection: null }), [agents]);
  const allAgents = useMemo(() => flattenAgentPanelRoster(model), [model]);
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
  // One pass over the thread's activities gives every conversation's meter;
  // each card and the open transcript then read their own by id.
  const contextWindowByAgentId = useMemo(
    () => (activities ? deriveContextWindowSnapshotsByAgent(activities) : new Map()),
    [activities],
  );
  const selectedAgentContextWindow = selectedAgent
    ? (contextWindowByAgentId.get(selectedAgent.id) ?? null)
    : null;
  const openAgent = useCallback((agentId: string) => setSelectedAgentId(agentId), []);
  const transcript = useMemo(
    () => (thread && selectedAgent ? buildThreadFeed(thread, { agentId: selectedAgent.id }) : []),
    [selectedAgent, thread],
  );
  const transcriptTurnId = useMemo(() => {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index]!;
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
  // Background work the subagent fold deliberately drops: shells, monitors,
  // and a subagent's own internal tasks. Same durable activities, so this
  // survives reload exactly as the roster does.
  const backgroundTasks = useMemo(
    () => (activities ? foldBackgroundTasks(activities, { sessionLive: agentSessionLive }) : []),
    [agentSessionLive, activities],
  );
  const backgroundTasksModel = useMemo(
    () =>
      deriveBackgroundTasksPanelModel({
        tasks: backgroundTasks,
        agentTitles: new Map(
          allAgents.map((agent) => [agent.id, formatSubagentTitle(agent.title)] as const),
        ),
      }),
    [allAgents, backgroundTasks],
  );
  const agentWaits = useMemo(
    () =>
      deriveAgentWaitStates({
        tasks: backgroundTasks,
        agents: allAgents.map((agent) => ({
          id: agent.id,
          title: formatSubagentTitle(agent.title),
          status: agent.status,
          startedAt: agent.startedAt,
          // Members block their coordinator, not main.
          parentAgentId: agent.parentAgentId,
        })),
        requests: activities ? deriveOpenRequestWaits(activities) : [],
        agentWaitReasons: activities ? deriveAgentWaitReasons(activities) : new Map(),
        detachedIds: activities ? deriveDetachedTaskIds(activities) : new Set(),
        // A dead session cannot still be compacting: the wait dies with the
        // provider process exactly as running tasks do.
        compactingSince: activities && agentSessionLive ? deriveCompactingSince(activities) : null,
        mainTurnActive: sessionStatus === "running",
      }),
    [agentSessionLive, allAgents, backgroundTasks, sessionStatus, activities],
  );
  const statusClock = useAgentStatusClock(
    activeAgents.length > 0 ||
      selectedAgentWorking ||
      backgroundTasksModel.activeCount > 0 ||
      // A pending approval with no running work still shows a ticking wait.
      agentWaits.length > 0,
  );
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
  }, [selectedAgent, transcriptTurnId]);
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
            {selectedAgentContextWindow ? (
              <ContextWindowChip usage={selectedAgentContextWindow} />
            ) : null}
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
        {allAgents.length === 0 && !backgroundTasksModel.hasTasks && agentWaits.length === 0 ? (
          <View className="items-center px-8 py-16">
            <Text className="text-base font-t3-semibold text-foreground">No agents yet</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-foreground-muted">
              Subagents spawned by Codex or Claude appear here with live transcripts, alongside any
              work left running in the background.
            </Text>
          </View>
        ) : (
          <>
            <WaitingOnSection waits={agentWaits} clock={statusClock} />
            {activeAgents.length > 0 ? (
              <View className="gap-2 rounded-2xl border border-primary/25 bg-card/40 p-2">
                <View className="flex-row items-center gap-2 px-1 py-1">
                  <Text className="text-xs font-t3-semibold uppercase tracking-wider text-primary">
                    Active
                  </Text>
                  <Text className="text-xs text-foreground-muted">{activeAgents.length}</Text>
                </View>
                {activeAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    clock={statusClock}
                    contextWindow={contextWindowByAgentId.get(agent.id) ?? null}
                    onOpen={openAgent}
                  />
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
                        contextWindow={contextWindowByAgentId.get(agent.id) ?? null}
                        onOpen={openAgent}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
            <BackgroundTasksSection
              model={backgroundTasksModel}
              clock={statusClock}
              chevronColor={chevronColor}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}
