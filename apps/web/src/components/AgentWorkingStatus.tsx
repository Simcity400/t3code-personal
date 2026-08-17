import {
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { useEffect, useRef } from "react";

import { startWorkingDotsAnimation } from "./AgentsPanel.logic";

export function AgentStatusLabel({
  status,
  settledLabel,
}: {
  readonly status: RuntimeSubagent["status"];
  readonly settledLabel: string;
}) {
  const dotsRef = useRef<HTMLSpanElement>(null);
  const working = isActiveSubagentStatus(status);

  useEffect(() => {
    if (!working || !dotsRef.current) return;
    return startWorkingDotsAnimation({
      motionPreference: window.matchMedia("(prefers-reduced-motion: reduce)"),
      writeDots: (value) => {
        if (dotsRef.current) dotsRef.current.textContent = value;
      },
      setInterval,
      clearInterval,
    });
  }, [working]);

  if (!working) return settledLabel;
  return (
    <span aria-label="Working">
      Working
      <span ref={dotsRef} aria-hidden className="inline-block w-[1.8em] font-mono text-left" />
    </span>
  );
}

export function AgentRowActivity({
  status,
  activity,
  settledLabel,
}: {
  readonly status: RuntimeSubagent["status"];
  readonly activity: string | null;
  readonly settledLabel: string;
}) {
  if (!isActiveSubagentStatus(status)) return activity ?? settledLabel;
  const detailedActivity =
    activity !== null && activity.trim().toLocaleLowerCase() !== "working" ? activity : null;
  return (
    <>
      <AgentStatusLabel status={status} settledLabel={settledLabel} />
      {detailedActivity ? ` \u00b7 ${detailedActivity}` : null}
    </>
  );
}
