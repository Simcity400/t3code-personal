import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
  type AgentPanelWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { Atom } from "effect/unstable/reactivity";

// Preserve each thread's disclosure choice when switching panel surfaces.
export const idleAgentsOpenAtom = Atom.family((_threadKey: string | null) =>
  Atom.make(true).pipe(Atom.keepAlive),
);

type SubagentPanelSection = "active" | "idle";

export function subagentPanelSection(status: RuntimeSubagent["status"]): SubagentPanelSection {
  return isActiveSubagentStatus(status) ? "active" : "idle";
}

function workflowSliceStatus(
  members: ReadonlyArray<RuntimeSubagent>,
  section: SubagentPanelSection,
): RuntimeSubagent["status"] {
  if (section === "active") {
    if (members.some((member) => member.status === "running")) return "running";
    if (members.some((member) => member.status === "waiting")) return "waiting";
    return "pending";
  }
  if (members.some((member) => member.status === "failed")) return "failed";
  if (members.some((member) => member.status === "idle")) return "idle";
  if (members.some((member) => member.status === "interrupted")) return "interrupted";
  if (members.some((member) => member.status === "cancelled")) return "cancelled";
  return "completed";
}

/**
 * Projects one workflow into a panel section without flattening its phase
 * shape. A mixed workflow can therefore appear in both sections while every
 * individual member remains hideable under the correct disclosure.
 */
export function filterWorkflowForPanelSection(
  group: AgentPanelWorkflowGroup,
  section: SubagentPanelSection,
): AgentPanelWorkflowGroup | null {
  const allMembers = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  if (allMembers.length === 0) {
    return subagentPanelSection(group.workflow.status) === section ? group : null;
  }

  const phases = group.phases.flatMap<AgentPanelWorkflowGroup["phases"][number]>((phase) => {
    const members = phase.members.filter(
      (member) => subagentPanelSection(member.status) === section,
    );
    if (members.length === 0) return [];
    const activeCount = members.filter(
      (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
    ).length;
    const settledCount = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
    return [
      {
        ...phase,
        members,
        state: activeCount > 0 ? "running" : settledCount === members.length ? "done" : "pending",
        activeCount,
        settledCount,
      },
    ];
  });
  const unphasedMembers = group.unphasedMembers.filter(
    (member) => subagentPanelSection(member.status) === section,
  );
  const members = [...phases.flatMap((phase) => phase.members), ...unphasedMembers];
  if (members.length === 0) return null;

  return {
    ...group,
    workflow: { ...group.workflow, status: workflowSliceStatus(members, section) },
    phases,
    unphasedMembers,
  };
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
