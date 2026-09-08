import type { LegendListRef } from "@legendapp/list/react";
import {
  deriveAgentTranscriptTurn,
  selectAgentTranscript,
} from "@t3tools/client-runtime/state/agent-transcripts";
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon } from "lucide-react";
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
