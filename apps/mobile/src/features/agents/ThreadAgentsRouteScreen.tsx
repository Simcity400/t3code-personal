import type { LegendListRef } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  deriveAgentTranscriptTurn,
  selectAgentTranscript,
} from "@t3tools/client-runtime/state/agent-transcripts";
import { foldSubagentActivities } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadFeed } from "../../lib/threadActivity";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useThreadDetail } from "../../state/use-thread-detail";
import { useProject } from "../../state/entities";
import { ThreadFeed } from "../threads/ThreadFeed";
import { projectThreadContentPresentation } from "../threads/threadContentPresentation";

type ThreadParams = { readonly environmentId: string; readonly threadId: string };

function useAgentThread(params: ThreadParams) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const state = useThreadDetail({ environmentId, threadId });
  const thread = Option.getOrNull(state.data);
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const workspaceRoot = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const activities = thread?.activities;
  const sessionLive =
    thread?.session != null &&
    thread?.session?.status !== "stopped" &&
    thread?.session?.status !== "error";
  const agents = useMemo(
    () => foldSubagentActivities(activities ?? [], { sessionLive }),
    [activities, sessionLive],
  );
  const presentation = projectThreadContentPresentation({
    hasDetail: thread !== null,
    detailError: Option.getOrNull(state.error),
    detailDeleted: state.status === "deleted",
    connectionState: runtime?.connectionState ?? "available",
  });
  const loadEarlier = threadHasOlderTurns(state)
    ? {
        cursor: Option.getOrNull(state.page)?.beforeCursor ?? null,
        loading: Option.isSome(state.page) && state.page.value.loadingOlder,
        onLoadEarlier: () => requestOlderThreadTurns(environmentId, threadId),
      }
    : null;
  return { environmentId, threadId, thread, agents, presentation, loadEarlier, workspaceRoot };
}

export function ThreadAgentsRouteScreen(props: StaticScreenProps<ThreadParams>) {
  const navigation = useNavigation();
  const { environmentId, threadId, agents, presentation, loadEarlier } = useAgentThread(
    props.route.params,
  );
  const insets = useSafeAreaInsets();
  const historyRequest = useRef<{ key: string | null; size: number }>({ key: null, size: 0 });

  // Parent history pages may contain no agents, leaving the list too short to reach its edge again.
  useEffect(() => {
    if (agents.length !== historyRequest.current.size || !loadEarlier || loadEarlier.loading)
      return;
    const key = `${environmentId}:${threadId}:${loadEarlier.cursor}`;
    if (historyRequest.current.key === key) return;
    historyRequest.current = { key, size: agents.length };
    loadEarlier.onLoadEarlier();
  }, [agents.length, environmentId, threadId, loadEarlier]);

  if (presentation.kind === "loading") return <LoadingScreen message="Loading agents…" />;
  if (presentation.kind === "unavailable") {
    return <EmptyState title={presentation.title} detail={presentation.detail} />;
  }

  return (
    <FlatList
      className="flex-1 bg-screen"
      data={agents}
      keyExtractor={(agent) => agent.id}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 8 }}
      renderItem={({ item: agent }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View ${agent.title} transcript, ${agent.status}`}
          className="rounded-2xl border border-border bg-card p-4 active:opacity-70"
          onPress={() =>
            navigation.navigate("ThreadAgentTranscript", {
              ...props.route.params,
              agentId: agent.id,
            })
          }
        >
          <Text className="text-base font-t3-bold text-foreground">{agent.title}</Text>
          <Text className="mt-1 text-sm text-foreground-muted">
            {[agent.role, agent.status].filter(Boolean).join(" · ")}
          </Text>
          {agent.progress ? (
            <Text className="mt-2 text-sm text-foreground" numberOfLines={2}>
              {agent.progress}
            </Text>
          ) : null}
        </Pressable>
      )}
      ListEmptyComponent={
        <EmptyState
          title="No agents yet"
          detail="Native agents will appear here when the provider reports them."
        />
      }
      onEndReached={() => {
        if (loadEarlier && !loadEarlier.loading) {
          historyRequest.current = {
            key: `${environmentId}:${threadId}:${loadEarlier.cursor}`,
            size: agents.length,
          };
          loadEarlier.onLoadEarlier();
        }
      }}
      onEndReachedThreshold={0.25}
    />
  );
}

export function ThreadAgentTranscriptRouteScreen(
  props: StaticScreenProps<ThreadParams & { readonly agentId: string }>,
) {
  const { environmentId, threadId, thread, agents, presentation, loadEarlier, workspaceRoot } =
    useAgentThread(props.route.params);
  const agentId = props.route.params.agentId;
  const agent = agents.find((entry) => entry.id === agentId);
  const messages = thread?.messages;
  const activities = thread?.activities;
  const scoped = useMemo(
    () => selectAgentTranscript(messages ?? [], activities ?? [], agentId),
    [messages, activities, agentId],
  );
  const feed = useMemo(() => buildThreadFeed(scoped), [scoped]);
  const turn = useMemo(() => deriveAgentTranscriptTurn(scoped, agent), [scoped, agent]);
  const listRef = useRef<LegendListRef>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: agent?.title ?? "Agent transcript" }} />
      <ThreadFeed
        key={agentId}
        environmentId={environmentId}
        threadId={threadId}
        workspaceRoot={workspaceRoot}
        feed={feed}
        queuedMessages={[]}
        dispatchingMessageId={null}
        onEditPendingMessage={() => undefined}
        contentPresentation={presentation}
        agentLabel={agent?.title ?? "Agent"}
        latestTurn={turn.latestTurn}
        activeWorkStartedAt={turn.activeTurnStartedAt}
        listRef={listRef}
        freeze={freeze}
        anchorMessageId={null}
        submittedMessageId={null}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        contentTopInset={0}
        contentBottomInset={insets.bottom + 16}
        loadEarlier={loadEarlier}
      />
    </View>
  );
}
