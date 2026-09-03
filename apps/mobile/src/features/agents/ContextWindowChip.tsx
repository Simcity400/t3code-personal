import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/contextWindow";
import { formatContextWindowTokens } from "@t3tools/client-runtime/state/contextWindow";
import { Text, View } from "react-native";

/**
 * Compact context-window readout: how full THIS conversation's window is.
 *
 * The phone has no room for the desktop's ring-and-popover meter, so the same
 * snapshot is rendered as a chip. It reads as a percentage whenever the
 * provider reports a window size and falls back to the raw occupancy when it
 * does not (OpenCode reports tokens but no limit) — never as a cumulative
 * total, which is a different number shown elsewhere.
 */
export function ContextWindowChip({
  usage,
  accessibilityPrefix = "Context window",
}: {
  readonly usage: ContextWindowSnapshot;
  readonly accessibilityPrefix?: string;
}) {
  const percentage =
    usage.usedPercentage !== null && Number.isFinite(usage.usedPercentage)
      ? Math.round(usage.usedPercentage)
      : null;
  const label =
    percentage !== null
      ? `${percentage}% ctx`
      : `${formatContextWindowTokens(usage.usedTokens)} ctx`;
  const maxTokens = usage.maxTokens ?? null;
  const detail =
    percentage !== null && maxTokens !== null
      ? `${accessibilityPrefix} ${percentage} percent used, ${formatContextWindowTokens(usage.usedTokens)} of ${formatContextWindowTokens(maxTokens)} tokens`
      : `${accessibilityPrefix} ${formatContextWindowTokens(usage.usedTokens)} tokens used`;

  return (
    <View
      accessible
      accessibilityLabel={detail}
      className="rounded-full bg-card px-2 py-0.5"
      // Over 90% the window is about to compact, which changes what the reader
      // should expect next.
      style={percentage !== null && percentage > 90 ? { opacity: 1 } : undefined}
    >
      <Text
        className={
          percentage !== null && percentage > 90
            ? "text-xs font-t3-medium tabular-nums text-destructive"
            : "text-xs font-t3-medium tabular-nums text-foreground-muted"
        }
      >
        {label}
      </Text>
    </View>
  );
}
