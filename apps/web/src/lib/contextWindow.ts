import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

/**
 * Latest context-window usage for ONE conversation.
 *
 * `agentId` says whose meter this is: `null` for the parent thread, or a
 * subagent's id for that agent's own meter. Rows a subagent produced are
 * stamped with its id and the parent skips them — otherwise the parent's meter
 * shows whichever conversation reported last, which on a thread with busy
 * subagents is almost never the parent.
 *
 * Passing a transcript already scoped to one agent (attribution stripped) with
 * `agentId` left at `null` is equivalent, and is how the Agents panel drives
 * the identical meter component per subagent.
 */
export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  agentId: string | null = null,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }
    const rowAgentId = contextWindowActivityOwner(activity);
    if (rowAgentId !== agentId) {
      continue;
    }
    const snapshot = contextWindowSnapshotFromActivity(activity);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}

/** Owner of a context-window row: a subagent, or the parent thread (null). */
function contextWindowActivityOwner(activity: OrchestrationThreadActivity): string | null {
  const agentId = asRecord(activity.payload)?.agentId;
  return typeof agentId === "string" ? agentId : null;
}

/** Reads one row into a snapshot, or null when it carries no usable usage. */
function contextWindowSnapshotFromActivity(
  activity: OrchestrationThreadActivity,
): ContextWindowSnapshot | null {
  {
    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      return null;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      updatedAt: activity.createdAt,
    };
  }
}

/**
 * Every conversation's latest context-window snapshot in ONE pass, keyed by
 * agent id (the parent thread under `null`).
 *
 * Calling `deriveLatestContextWindowSnapshot` per agent re-walks the whole
 * activity list each time, so a 100-agent roster did roughly
 * `agents x activities` work on every streaming update.
 */
export function deriveContextWindowSnapshotsByAgent(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string | null, ContextWindowSnapshot> {
  const byOwner = new Map<string | null, ContextWindowSnapshot>();
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const owner = typeof payload?.agentId === "string" ? payload.agentId : null;
    if (byOwner.has(owner)) {
      continue;
    }
    const snapshot = contextWindowSnapshotFromActivity(activity);
    if (snapshot) {
      byOwner.set(owner, snapshot);
    }
  }
  return byOwner;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
