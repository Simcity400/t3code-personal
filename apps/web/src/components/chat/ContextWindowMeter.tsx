import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { ServerProvider, TimestampFormat } from "@t3tools/contracts";
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatChatTimestampTooltip } from "~/timestampFormat";
import { formatResetsIn, limitsNotice } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

const usageAccentColor = "var(--app-theme-accent, var(--color-info))";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/**
 * The popover is a glance, not a page: one line per reading, bars inline,
 * and no actions. Manual compaction is `/compact` in the composer, so the
 * fork dropped upstream's "Compact context" button from here (2026-09-06).
 */
export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  provider?: ServerProvider | null;
  timestampFormat?: TimestampFormat;
}) {
  const { usage, provider } = props;
  const [open, setOpen] = useState(false);
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--color-error)" : usageAccentColor;
  const reading =
    usage === null
      ? "Not reported yet"
      : usage.maxTokens != null && usedPercentage
        ? `${formatContextWindowTokens(usage.usedTokens)}/${formatContextWindowTokens(usage.maxTokens)} · ${usedPercentage}`
        : `${formatContextWindowTokens(usage.usedTokens)} tokens`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            data-composer-context-control
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage === null
                ? "Context window and usage limits"
                : usedPercentage
                  ? `Context window ${usedPercentage} used`
                  : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="end"
        className="w-64 max-w-[calc(100vw-2rem)] p-2.5 text-left whitespace-normal"
      >
        <div className="flex flex-col gap-1.5 text-[11px] leading-4">
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-medium text-muted-foreground">Context</span>
            {usedPercentage !== null ? (
              <UsageBar
                className="min-w-8 flex-1"
                label="Context window usage"
                percent={normalizedPercentage}
                color={usageColor}
              />
            ) : (
              <span className="flex-1" />
            )}
            <span className="shrink-0 tabular-nums text-secondary-label">{reading}</span>
          </div>
          {showTotalProcessed ? (
            <div className="text-right tabular-nums text-secondary-label">
              {formatContextWindowTokens(totalProcessedTokens)} processed in total
            </div>
          ) : null}
          {open && provider !== undefined ? (
            <ContextUsageLimits
              provider={provider}
              timestampFormat={props.timestampFormat ?? "locale"}
            />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function UsageBar({
  label,
  percent,
  color,
  className,
}: {
  label: string;
  percent: number;
  color: string;
  className?: string;
}) {
  return (
    <div
      className={`h-1 overflow-hidden rounded-full bg-muted/60 ${className ?? ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div
        className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${percent}%`, backgroundColor: color }}
      />
    </div>
  );
}

/** One row per window: label, bar, percent, time to reset. The absolute reset
    time is a tooltip on the countdown; the Usage page has the long form. */
export function ContextUsageLimits({
  provider,
  timestampFormat,
}: {
  provider: ServerProvider | null;
  timestampFormat: TimestampFormat;
}) {
  const minute = useNowMinute();
  const now = Date.parse(`${minute}:00Z`);
  const limits = provider?.usageLimits;
  const notice = limits
    ? limitsNotice(limits)
    : "Usage limits are not available for this provider.";
  return (
    <div className="mt-0.5 flex flex-col gap-1.5 border-t border-border pt-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-muted-foreground">
          Limits{provider?.auth.label ? ` · ${provider.auth.label}` : ""}
        </span>
        <Link
          to="/usage"
          search={{ view: "limits" }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          Details
        </Link>
      </div>
      {notice ? (
        <p className="text-muted-foreground">{notice}</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,6rem)_1fr_2.25rem_auto] items-center gap-x-2 gap-y-1">
          {limits?.windows.map((window) => {
            const used = Math.max(0, Math.min(100, window.usedPercent));
            const countdown = formatResetsIn(window, now)?.replace(/^resets /, "") ?? null;
            const resetAt = window.resetsAt
              ? formatChatTimestampTooltip(window.resetsAt, timestampFormat)
              : null;
            const label =
              window.kind === "session" && window.windowDurationMins === 300
                ? "5-hour"
                : window.label;
            return (
              <div key={window.id} className="contents">
                <span className="truncate">{label}</span>
                <UsageBar
                  label={label}
                  percent={used}
                  color={used >= 90 ? "var(--color-error)" : usageAccentColor}
                />
                <span className="text-right tabular-nums text-muted-foreground">
                  {Math.round(used)}%
                </span>
                {countdown && resetAt ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <time
                          dateTime={window.resetsAt}
                          className="text-right tabular-nums text-muted-foreground"
                        >
                          {countdown}
                        </time>
                      }
                    />
                    <TooltipPopup side="top">Resets {resetAt}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span className="text-right tabular-nums text-muted-foreground">
                    {countdown ?? "—"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
