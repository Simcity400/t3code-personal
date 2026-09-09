import {
  isActiveSubagentStatus,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "./subagentRuntime.ts";

/**
 * Presentation rules shared by the desktop Agents panel and the mobile Agents
 * screen, so a subagent reads the same on every client.
 */

export type SubagentPanelSection = "active" | "idle";

export function subagentPanelSection(status: RuntimeSubagentStatus): SubagentPanelSection {
  return isActiveSubagentStatus(status) ? "active" : "idle";
}

/**
 * Live states all read as "Working" (monitoring-pill design: detail belongs in
 * the activity line, and a waiting or queued subagent is still the fleet doing
 * its job). Only settled states differentiate. Idle reads as settled because a
 * resting Codex child looks done unless resumed.
 */
const SUBAGENT_STATUS_LABEL: Record<RuntimeSubagentStatus, string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export function subagentStatusLabel(agent: Pick<RuntimeSubagent, "kind" | "status">): string {
  return agent.kind === "subagent_batch" && agent.status === "idle"
    ? "Idle"
    : SUBAGENT_STATUS_LABEL[agent.status];
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
export function subagentActivityText(
  agent: Pick<RuntimeSubagent, "status" | "progress" | "lastToolName" | "result" | "error">,
): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  const tool = agent.lastToolName ? `▸ ${agent.lastToolName}` : null;
  if (live) {
    return agent.progress ?? tool ?? agent.result ?? agent.error;
  }
  return agent.error ?? agent.result ?? agent.progress ?? tool;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed time of one activation; empty when either timestamp is unreadable. */
export function formatSubagentElapsed(
  startedAt: string,
  endedAt: string | null,
  now: number,
): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

const SUBAGENT_TITLE_TERMS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  claude: "Claude",
  cli: "CLI",
  codex: "Codex",
  css: "CSS",
  e2e: "E2E",
  expo: "Expo",
  git: "Git",
  github: "GitHub",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  ios: "iOS",
  ipad: "iPad",
  iphone: "iPhone",
  js: "JS",
  json: "JSON",
  macos: "macOS",
  mcp: "MCP",
  pr: "PR",
  qa: "QA",
  sdk: "SDK",
  sql: "SQL",
  ssh: "SSH",
  t3: "T3",
  ts: "TS",
  ui: "UI",
  url: "URL",
  ux: "UX",
  ws: "WS",
  xcode: "Xcode",
  xml: "XML",
};

/**
 * Makes provider task keys pleasant to read without changing the stable key
 * used for transcript attribution. Explicit human-written titles are kept as
 * provided; only lowercase identifier-shaped titles are humanized.
 */
export function formatSubagentTitle(title: string): string {
  const trimmed = title.trim();
  if (
    trimmed.length === 0 ||
    !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(trimmed)
  ) {
    return trimmed;
  }

  return trimmed
    .split(/[_-]+/)
    .map((part, index) => {
      const knownTerm = Object.hasOwn(SUBAGENT_TITLE_TERMS, part)
        ? SUBAGENT_TITLE_TERMS[part]
        : undefined;
      if (knownTerm) return knownTerm;
      return index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part;
    })
    .join(" ");
}
