import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Alert, Platform, View } from "react-native";
import * as Option from "effect/Option";
import type { CodexGoalSetInput } from "@t3tools/contracts";
import {
  codexGoalSessionActivity,
  codexGoalStatusAction,
  describeCodexGoalStatus,
  formatCodexGoalDescription,
  formatCodexGoalError,
  formatCodexGoalStatus,
  formatCodexGoalUsage,
  parseCodexGoalCommand,
  toCodexGoalSetInput,
} from "@t3tools/client-runtime/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { CodexGoalEditorModal, type CodexGoalEditorSubmission } from "./CodexGoalEditorModal";
import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";

export function useCodexGoalControls(
  props: Pick<
    ThreadDetailScreenProps,
    "environmentId" | "selectedThread" | "serverConfig" | "showContent"
  >,
) {
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const showContent = props.showContent ?? true;
  const setCodexGoal = useAtomCommand(threadEnvironment.setCodexGoal, { reportFailure: false });
  const clearCodexGoal = useAtomCommand(threadEnvironment.clearCodexGoal, { reportFailure: false });
  const selectedProvider = props.serverConfig?.providers.find(
    (provider) => provider.instanceId === selectedInstanceId,
  );
  // The goal is projected from Codex's notifications onto the thread detail,
  // so it stays visible while the provider session is stopped. Same atom the
  // route screen already subscribes to for the feed.
  const environmentThread = Option.getOrNull(
    useEnvironmentThread(props.environmentId, props.selectedThread.id).data,
  );
  const codexGoal = selectedProvider?.driver === "codex" ? (environmentThread?.goal ?? null) : null;
  const codexGoalActivity = codexGoalSessionActivity(props.selectedThread.session);
  const [codexGoalEditorOpen, setCodexGoalEditorOpen] = useState(false);
  const [codexGoalBusy, setCodexGoalBusy] = useState(false);
  const codexGoalMutationInFlight = useRef(false);
  const codexGoalThreadStarted = props.selectedThread.session !== null;
  // One path for the banner controls, the editor, and `/goal` commands.
  const runCodexGoalMutation = useCallback(
    async (
      mutation: { kind: "set"; input: CodexGoalSetInput } | { kind: "clear" },
    ): Promise<boolean> => {
      if (codexGoalMutationInFlight.current) return false;
      if (!codexGoalThreadStarted) {
        Alert.alert(
          "Start the Codex thread first",
          "Send a message before managing its native Goal.",
        );
        return false;
      }
      const submittedThreadKey = selectedThreadKey;
      const stillOnSubmittedThread = () => selectedThreadKeyRef.current === submittedThreadKey;
      codexGoalMutationInFlight.current = true;
      setCodexGoalBusy(true);
      try {
        const result =
          mutation.kind === "clear"
            ? await clearCodexGoal({
                environmentId: props.environmentId,
                input: { threadId: props.selectedThread.id },
              })
            : await setCodexGoal({ environmentId: props.environmentId, input: mutation.input });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result) && stillOnSubmittedThread()) {
            Alert.alert(
              "Codex Goal operation failed",
              formatCodexGoalError(squashAtomCommandFailure(result)),
            );
          }
          return false;
        }
        return stillOnSubmittedThread();
      } finally {
        codexGoalMutationInFlight.current = false;
        setCodexGoalBusy(false);
      }
    },
    [
      clearCodexGoal,
      codexGoalThreadStarted,
      props.environmentId,
      props.selectedThread.id,
      selectedThreadKey,
      setCodexGoal,
    ],
  );
  const handleCodexGoalStatusAction = useCallback(
    (action: "pause" | "resume" | "continue") => {
      void runCodexGoalMutation({
        kind: "set",
        input: {
          threadId: props.selectedThread.id,
          status: action === "pause" ? "paused" : "active",
        },
      });
    },
    [props.selectedThread.id, runCodexGoalMutation],
  );
  const handleCodexGoalClear = useCallback(() => {
    const title = "Clear this goal?";
    const message =
      "Codex stops pursuing the objective and forgets its usage. The conversation stays.";
    const onConfirm = () => void runCodexGoalMutation({ kind: "clear" });
    if (Platform.OS === "android") {
      showConfirmDialog({
        title,
        message,
        confirmText: "Clear goal",
        destructive: true,
        onConfirm,
      });
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear goal", style: "destructive", onPress: onConfirm },
    ]);
  }, [runCodexGoalMutation]);
  const handleCodexGoalEditorSubmit = useCallback(
    async (submission: CodexGoalEditorSubmission) => {
      const saved = await runCodexGoalMutation({
        kind: "set",
        input: {
          threadId: props.selectedThread.id,
          objective: submission.objective,
          ...(submission.tokenBudget !== undefined ? { tokenBudget: submission.tokenBudget } : {}),
          // A new objective on a fresh or completed goal starts pursuit;
          // editing a live goal leaves Codex's status alone.
          ...(codexGoal === null || codexGoal.status === "complete"
            ? { status: "active" as const }
            : {}),
        },
      });
      if (saved) setCodexGoalEditorOpen(false);
    },
    [codexGoal, props.selectedThread.id, runCodexGoalMutation],
  );
  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
    setCodexGoalEditorOpen(false);
  }, [selectedThreadKey, showContent]);
  const handleGoalCommand = useCallback(
    (
      draftMessage: string,
      hasAttachments: boolean,
      clearDraft: () => void,
    ): boolean | Promise<boolean> => {
      const draftGoalCommand = !hasAttachments ? parseCodexGoalCommand(draftMessage) : null;
      if (draftGoalCommand !== null && selectedProvider === undefined) {
        Alert.alert("Provider still loading", "Wait for the provider list to finish loading.");
        return true;
      }
      const goalCommand = selectedProvider?.driver === "codex" ? draftGoalCommand : null;
      if (goalCommand !== null) {
        if (goalCommand.action === "invalid") {
          Alert.alert("Invalid Goal command", goalCommand.message);
          return true;
        }
        if (props.selectedThread.session === null) {
          Alert.alert(
            "Start the Codex thread first",
            "Send a message before managing its native Goal.",
          );
          return true;
        }
        const submittedThreadKey = selectedThreadKey;
        const stillOnSubmittedThread = () => selectedThreadKeyRef.current === submittedThreadKey;
        const clearSubmittedGoalCommandDraft = () => {
          if (stillOnSubmittedThread()) clearDraft();
        };
        if (goalCommand.action === "edit") {
          clearSubmittedGoalCommandDraft();
          setCodexGoalEditorOpen(true);
          return true;
        }
        if (goalCommand.action === "status") {
          clearSubmittedGoalCommandDraft();
          Alert.alert(
            codexGoal === null
              ? "No active Codex Goal"
              : `Goal ${formatCodexGoalStatus(codexGoal.status)}`,
            codexGoal === null ? undefined : formatCodexGoalDescription(codexGoal),
          );
          return true;
        }
        return runCodexGoalMutation(
          goalCommand.action === "clear"
            ? { kind: "clear" }
            : { kind: "set", input: toCodexGoalSetInput(props.selectedThread.id, goalCommand) },
        ).then((applied) => {
          if (applied) clearSubmittedGoalCommandDraft();
          return true;
        });
      }
      return false;
    },
    [
      selectedProvider,
      props.selectedThread.session,
      props.selectedThread.id,
      selectedThreadKey,
      codexGoal,
      runCodexGoalMutation,
    ],
  );
  return {
    handleGoalCommand,
    controls: (
      <>
        {codexGoal !== null ? (
          <View className="mx-3 mb-2 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2">
            <Text className="text-xs font-t3-bold text-foreground">
              Goal {formatCodexGoalStatus(codexGoal.status)}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={2}>
              {codexGoal.objective}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {describeCodexGoalStatus(codexGoal, codexGoalActivity)}{" "}
              {formatCodexGoalUsage(codexGoal)}
            </Text>
            <View className="mt-2 flex-row gap-2">
              {(() => {
                const action = codexGoalStatusAction(codexGoal, codexGoalActivity);
                return action === null ? null : (
                  <ControlPill
                    label={
                      action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Continue"
                    }
                    variant="primary"
                    disabled={codexGoalBusy}
                    onPress={() => handleCodexGoalStatusAction(action)}
                  />
                );
              })()}
              <ControlPill
                label="Edit"
                variant="pill"
                disabled={codexGoalBusy}
                onPress={() => setCodexGoalEditorOpen(true)}
              />
              <ControlPill
                label="Clear"
                variant="pill"
                disabled={codexGoalBusy}
                onPress={handleCodexGoalClear}
              />
            </View>
          </View>
        ) : null}
        <CodexGoalEditorModal
          visible={codexGoalEditorOpen}
          goal={codexGoal}
          saving={codexGoalBusy}
          onClose={() => setCodexGoalEditorOpen(false)}
          onSubmit={handleCodexGoalEditorSubmit}
        />
      </>
    ),
  };
}
