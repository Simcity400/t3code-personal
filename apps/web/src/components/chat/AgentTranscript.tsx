import type { LegendListRef } from "@legendapp/list/react";
import {
  deriveAgentTranscriptTurn,
  selectAgentTranscript,
} from "@t3tools/client-runtime/state/agent-transcripts";
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useRef, useState, type ComponentProps } from "react";
import * as Option from "effect/Option";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEnvironmentThread } from "../../state/threads";
import { useServerConfigs } from "../../state/entities";

import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import { Button } from "../ui/button";
import { MessagesTimeline } from "./MessagesTimeline";

const NOOP = () => {};
const EMPTY_DIFFS: ComponentProps<typeof MessagesTimeline>["turnDiffSummaries"] = [];

type AgentTranscriptProps = Pick<
  ComponentProps<typeof MessagesTimeline>,
  | "routeThreadKey"
  | "activeThreadEnvironmentId"
  | "markdownCwd"
  | "resolvedTheme"
  | "timestampFormat"
  | "workspaceRoot"
  | "loadEarlier"
  | "onImageExpand"
  | "onFileOpen"
  | "onFileDownload"
  | "onUseArtifactTemplate"
  | "skills"
> & {
  agent: RuntimeSubagent;
  messages: readonly OrchestrationMessage[];
  activities: readonly OrchestrationThreadActivity[];
};

/** Reuse the main transcript's virtualized text, reasoning and tool renderers. */
export function AgentTranscript({ agent, messages, activities, ...props }: AgentTranscriptProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const scoped = useMemo(
    () => selectAgentTranscript(messages, activities, agent.id),
    [messages, activities, agent.id],
  );
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(scoped.messages, [], deriveWorkLogEntries(scoped.activities)),
    [scoped],
  );
  const turn = useMemo(() => deriveAgentTranscriptTurn(scoped, agent), [scoped, agent]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MessagesTimeline
        {...props}
        listRef={listRef}
        timelineEntries={timelineEntries}
        {...turn}
        turnDiffSummaries={EMPTY_DIFFS}
        supportsConversationRollback={false}
        onOpenTurnDiff={NOOP}
        onRevertToTurnCount={NOOP}
        isRevertingCheckpoint={false}
        anchorMessageId={null}
        onAnchorReady={NOOP}
        contentInsetEndAdjustment={0}
        liveFollowEnabled={liveFollowEnabled}
        onIsAtEndChange={setLiveFollowEnabled}
        onManualNavigation={() => setLiveFollowEnabled(false)}
        hideEmptyPlaceholder={props.loadEarlier != null}
      />
      {!liveFollowEnabled && (
        <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
          <Button
            aria-label="Scroll to end"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setLiveFollowEnabled(true);
              void listRef.current?.scrollToEnd({ animated: true });
            }}
            className="pointer-events-auto gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
            size="xs"
            variant="glass"
          >
            <ChevronDownIcon className="size-3.5" />
            Scroll to end
          </Button>
        </div>
      )}
    </div>
  );
}

const EMPTY_MESSAGES: readonly OrchestrationMessage[] = [];
const EMPTY_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];

type ScopedAgentTranscriptProps = Omit<
  AgentTranscriptProps,
  "messages" | "activities" | "loadEarlier"
> & {
  environmentId: EnvironmentId;
  threadId: ThreadId;
};

/**
 * Opens the agent's own transcript scope on demand, so the root thread never
 * carries subagent tool output and a transcript loads only when it is viewed.
 */
export function ScopedAgentTranscript({
  environmentId,
  threadId,
  agent,
  ...props
}: ScopedAgentTranscriptProps) {
  // A server without scoping already streams every agent's rows on the root
  // thread; reading them there avoids a second full subscription per transcript.
  const scopedAgentId =
    useServerConfigs().get(environmentId)?.threadAgentScoping === true ? agent.id : undefined;
  const state = useEnvironmentThread(environmentId, threadId, scopedAgentId);
  const thread = Option.getOrNull(state.data);
  const loadEarlier = useMemo(() => {
    if (!threadHasOlderTurns(state)) return null;
    return {
      loading: state.page._tag === "Some" && state.page.value.loadingOlder,
      cursor: state.page._tag === "Some" ? state.page.value.beforeCursor : null,
      onLoadEarlier: () => {
        requestOlderThreadTurns(environmentId, threadId, scopedAgentId);
      },
    };
  }, [environmentId, scopedAgentId, state, threadId]);
  return (
    <AgentTranscript
      agent={agent}
      messages={thread?.messages ?? EMPTY_MESSAGES}
      activities={thread?.activities ?? EMPTY_ACTIVITIES}
      loadEarlier={loadEarlier}
      {...props}
    />
  );
}
