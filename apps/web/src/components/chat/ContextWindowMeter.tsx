import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { ServerProviderUsageLimits, TimestampFormat } from "@t3tools/contracts";
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { formatResetsIn, limitsNotice } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";

const TRACK_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";
const FILL_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
const OVERLOADED_PERCENT = 90;

function fillColor(percent: number): string {
  return percent > OVERLOADED_PERCENT ? "var(--color-error)" : FILL_COLOR;
}

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
 * The composer's context control: a ring for the thread's context window and
 * a popover that adds the signed-in account's subscription limits, so the
 * user can tell "this thread is full" from "this account is nearly out" in
 * one place. Limits render with the same bar as the context window. The
 * popover is a glance, not a page: no actions, since manual compaction is
 * the `/compact` command in the composer.
 *
 * `usageLimits` undefined leaves the limits section out entirely; `null`
 * means the selected provider reports none.
 */
export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  usageLimits?: ServerProviderUsageLimits | null;
  accountLabel?: string | null;
  timestampFormat?: TimestampFormat;
}) {
  const { usage, usageLimits } = props;
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const usageColor = fillColor(normalizedPercentage);
  const hasBoundedUsage = usage !== null && usage.maxTokens !== null && usedPercentage !== null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            data-composer-context-control
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage === null
                ? "Context window and usage limits"
                : hasBoundedUsage
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
                  stroke={TRACK_COLOR}
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
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-72 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            <div className="text-secondary-label text-[11px] tabular-nums">
              {usage === null ? (
                "Not reported yet"
              ) : hasBoundedUsage ? (
                <>
                  <span>{usedPercentage}</span>
                  <span className="mx-1">·</span>
                  <span>
                    {formatContextWindowTokens(usage.usedTokens)}/
                    {formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </>
              ) : (
                formatContextWindowTokens(usage.usedTokens)
              )}
            </div>
          </div>
          {hasBoundedUsage ? (
            <UsageBar label="Context window usage" percent={normalizedPercentage} />
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usageLimits !== undefined ? (
            <ContextUsageLimits
              limits={usageLimits}
              accountLabel={props.accountLabel ?? null}
              timestampFormat={props.timestampFormat ?? "locale"}
            />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function UsageBar({ label, percent }: { label: string; percent: number }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${percent}%`, backgroundColor: fillColor(percent) }}
      />
    </div>
  );
}

/**
 * The account's quota windows, one row each: label and "used · countdown"
 * above a bar filled by how much is used, matching the context bar. The
 * absolute reset time sits in a tooltip on the countdown; the Usage page has
 * the long form. The popover unmounts its content when closed, so the minute
 * clock only has a subscriber while this is visible.
 */
export function ContextUsageLimits({
  limits,
  accountLabel,
  timestampFormat,
}: {
  limits: ServerProviderUsageLimits | null;
  accountLabel: string | null;
  timestampFormat: TimestampFormat;
}) {
  const minute = useNowMinute();
  const now = Date.parse(`${minute}:00Z`);
  const notice = limits
    ? limitsNotice(limits)
    : "Usage limits are not available for this provider.";
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Usage Limits</div>
        <Link
          to="/usage"
          search={{ view: "limits" }}
          className="shrink-0 text-[11px] text-secondary-label hover:text-foreground"
        >
          Details
        </Link>
      </div>
      {accountLabel ? (
        <div className="-mt-1 truncate text-[11px] leading-4 text-secondary-label">
          {accountLabel}
        </div>
      ) : null}
      {notice ? (
        <div className="text-pretty text-secondary-label text-[11px]">{notice}</div>
      ) : (
        limits?.windows.map((window) => {
          const used = Math.max(0, Math.min(100, window.usedPercent));
          const countdown = formatResetsIn(window, now);
          const resetAt = window.resetsAt
            ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
            : null;
          return (
            <div key={window.id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="truncate text-secondary-label">{window.label}</span>
                <span className="shrink-0 tabular-nums text-secondary-label">
                  <span>{Math.round(used)}% used</span>
                  {countdown ? (
                    <>
                      <span className="mx-1">·</span>
                      {resetAt ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={<time dateTime={window.resetsAt}>{countdown}</time>}
                          />
                          <TooltipPopup side="top">Resets {resetAt}</TooltipPopup>
                        </Tooltip>
                      ) : (
                        <span>{countdown}</span>
                      )}
                    </>
                  ) : null}
                </span>
              </div>
              <UsageBar label={`${window.label} usage`} percent={used} />
            </div>
          );
        })
      )}
    </div>
  );
}
