import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadDetail } from "../../state/use-thread-detail";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { threadEnvironment } from "../../state/threads";
import { relatedChats } from "@t3tools/client-runtime/state/sideChat";
import { projectThreadContentPresentation } from "./threadContentPresentation";

export function ThreadSideChatsRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const state = useThreadDetail({ environmentId, threadId });
  const thread = Option.getOrNull(state.data);
  const threads = useThreadShells();
  const shell = threads.find(
    (item) => item.environmentId === environmentId && item.id === threadId,
  );
  const chats = useMemo(() => (shell ? relatedChats(shell, threads) : []), [shell, threads]);
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const presentation = projectThreadContentPresentation({
    hasDetail: thread !== null,
    detailError: Option.getOrNull(state.error),
    detailDeleted: state.status === "deleted",
    connectionState: runtime?.connectionState ?? "available",
  });
  const openThread = (id: ThreadId) =>
    navigation.dispatch(
      StackActions.popTo("Thread", {
        environmentId: String(environmentId),
        threadId: String(id),
      }),
    );

  const removeSideChat = async () => {
    if (inFlight.current || !thread) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await deleteThread({ environmentId, input: { threadId } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not update side chat",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      const parent = chats.find((item) => item.relation === "Original thread");
      if (parent) openThread(parent.thread.id);
      else navigation.dispatch(StackActions.popTo("Home"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (presentation.kind === "loading") return <LoadingScreen message="Loading side chats…" />;
  if (presentation.kind === "unavailable" || !thread) {
    return (
      <EmptyState
        title={presentation.kind === "unavailable" ? presentation.title : "Thread unavailable"}
        detail={
          presentation.kind === "unavailable"
            ? presentation.detail
            : "Return to your threads and try again."
        }
      />
    );
  }

  return (
    <FlatList
      className="flex-1 bg-screen"
      data={chats}
      keyExtractor={({ thread: item }) => item.id}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 8 }}
      ListHeaderComponent={
        <View className="mb-3 gap-3">
          <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4">
            <View className="min-w-0 flex-1">
              <Text className="text-xs text-foreground-muted">Current conversation</Text>
              <Text className="mt-1 text-base font-t3-bold text-foreground" numberOfLines={2}>
                {thread.title}
              </Text>
              <Text className="mt-1 text-sm text-foreground-muted">Saved in your thread list</Text>
            </View>
            {thread.forkedFromThreadId != null ? (
              <ControlPillMenu
                title="Side chat"
                actions={[
                  {
                    id: "delete",
                    title: "Delete side chat…",
                    image: "trash",
                    attributes: { destructive: true, disabled: busy },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "delete")
                    Alert.alert(
                      "Delete side chat?",
                      "This permanently deletes its messages. Any attached side chats will be kept in the main thread list.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => void removeSideChat(),
                        },
                      ],
                    );
                }}
              >
                <ControlPill
                  icon="ellipsis"
                  accessibilityLabel="Side chat actions"
                  disabled={busy}
                />
              </ControlPillMenu>
            ) : null}
          </View>
          <Text className="px-1 text-sm text-foreground-muted">
            Switch conversations below. Returning to another chat keeps this one saved.
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.relation.toLowerCase()}: ${item.thread.title}`}
          disabled={busy}
          onPress={() => openThread(item.thread.id)}
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-70"
        >
          <SymbolView
            name={
              item.relation === "Original thread"
                ? "arrow.turn.up.left"
                : "bubble.left.and.bubble.right"
            }
            size={20}
            tintColorClassName="accent-icon"
          />
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-foreground-muted">{item.relation}</Text>
            <Text className="mt-1 text-base text-foreground" numberOfLines={2}>
              {item.thread.title}
            </Text>
          </View>
          <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-subtle" />
        </Pressable>
      )}
      ListEmptyComponent={
        <EmptyState
          title="No related chats"
          detail="Use /side in the conversation to start a side chat with Codex or Claude."
        />
      }
    />
  );
}
