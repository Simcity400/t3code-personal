import type { LegendListRef } from "@legendapp/list/react";
import { selectAgentTranscript } from "@t3tools/client-runtime/state/agent-transcripts";
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import { useMemo, useRef, useState, type ComponentProps } from "react";

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
> & {
  agentId: string;
  messages: readonly OrchestrationMessage[];
  activities: readonly OrchestrationThreadActivity[];
};

/** Reuse the main transcript's virtualized text, reasoning and tool renderers. */
export function AgentTranscript({ agentId, messages, activities, ...props }: AgentTranscriptProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const timelineEntries = useMemo(() => {
    const scoped = selectAgentTranscript(messages, activities, agentId);
    return deriveTimelineEntries(scoped.messages, [], deriveWorkLogEntries(scoped.activities));
  }, [messages, activities, agentId]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {timelineEntries.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          <p>No stored transcript in the loaded history for this agent.</p>
          {props.loadEarlier ? (
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={props.loadEarlier.loading}
              onClick={props.loadEarlier.onLoadEarlier}
            >
              {props.loadEarlier.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <MessagesTimeline
        {...props}
        listRef={listRef}
        timelineEntries={timelineEntries}
        isWorking={false}
        activeTurnStartedAt={null}
        latestTurn={null}
        runningTurnId={null}
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
        hideEmptyPlaceholder
      />
    </div>
  );
}
