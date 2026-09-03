/**
 * Web-side context-window helpers. The derivations themselves are shared with
 * mobile in `@t3tools/client-runtime/state/contextWindow`; only the provider
 * display wording is web-specific.
 */
export {
  deriveContextWindowSnapshotsByAgent,
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/contextWindow";

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
