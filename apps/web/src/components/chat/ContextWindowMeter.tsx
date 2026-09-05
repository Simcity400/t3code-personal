import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Minimize2Icon } from "lucide-react";
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

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  provider?: ServerProvider | null;
  timestampFormat?: TimestampFormat;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, provider, onCompact, compactDisabled, compactDisabledReason } = props;
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
        className="w-96 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage?.maxTokens != null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens)} ({usedPercentage})
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {usage
                  ? `${formatContextWindowTokens(usage.usedTokens)} tokens`
                  : "Not reported yet"}
              </div>
            )}
          </div>
          {usedPercentage !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {open && provider !== undefined ? (
            <UsageLimitsDetails
              provider={provider}
              timestampFormat={props.timestampFormat ?? "locale"}
            />
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function UsageLimitsDetails({
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
    <div className="flex flex-col gap-3 border-t border-border pt-3 text-xs">
      <div className="text-muted-foreground">
        Plan usage limits{provider?.auth.label ? ` · ${provider.auth.label}` : ""}
      </div>
      {notice ? (
        <p className="text-muted-foreground">{notice}</p>
      ) : (
        limits?.windows.map((window) => {
          const used = Math.max(0, Math.min(100, window.usedPercent));
          const countdown = formatResetsIn(window, now);
          const resetAt = window.resetsAt
            ? formatChatTimestampTooltip(window.resetsAt, timestampFormat)
            : "";
          const label =
            window.kind === "session" && window.windowDurationMins === 300
              ? "5-hour limit"
              : window.label;
          return (
            <div key={window.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{label}</span>
                <span className="tabular-nums text-muted-foreground">{Math.round(used)}%</span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={used}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${used}%`,
                    backgroundColor: used >= 90 ? "var(--color-error)" : usageAccentColor,
                  }}
                />
              </div>
              {resetAt && countdown ? (
                <div className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <time dateTime={window.resetsAt}>Resets {resetAt}</time>
                  <span className="tabular-nums">{countdown.replace(/^resets /, "")}</span>
                </div>
              ) : (
                <span className="text-[11px] text-muted-foreground">Reset time not reported</span>
              )}
            </div>
          );
        })
      )}
      <Link
        to="/usage"
        search={{ view: "limits" }}
        className="border-t border-border pt-3 text-muted-foreground hover:text-foreground"
      >
        See detailed breakdown
      </Link>
    </div>
  );
}
