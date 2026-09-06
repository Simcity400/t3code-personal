import { EventId, TurnId, type ServerProvider } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextUsageLimits, ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactNode }) => render,
}));

vi.mock("~/hooks/useNowMinute", () => ({
  useNowMinute: () => "2026-09-06T17:17",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/usage?view=limits">{children}</a>,
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 159_000, maxTokens: 1_000_000, totalProcessedTokens: 4_800_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

const provider = {
  auth: { label: "Claude Max Subscription" },
  usageLimits: {
    checkedAt: "2026-09-06T17:00:00.000Z",
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: 29,
        resetsAt: "2026-09-06T19:39:00.000Z",
        windowDurationMins: 300,
      },
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 86 },
    ],
  },
} as unknown as ServerProvider;

describe("ContextWindowMeter", () => {
  it("shows the reading on one line and offers no compact control", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain("159k/1m · 16%");
    expect(markup).toContain("4.8m processed in total");
    expect(markup).not.toContain("Compact context");
  });
});

describe("ContextUsageLimits", () => {
  it("renders each window as one row with a short label and countdown", () => {
    const markup = renderToStaticMarkup(
      <ContextUsageLimits provider={provider} timestampFormat="locale" />,
    );

    expect(markup).toContain("Limits · Claude Max Subscription");
    expect(markup).toContain(">5-hour<");
    expect(markup).toContain(">in 2h 22m<");
    expect(markup).toContain(">29%<");
    expect(markup).toContain(">86%<");
    // The absolute reset time lives in the tooltip, not the row text.
    expect(markup).not.toContain(">Resets ");
    expect(markup).toContain(">—<");
    expect(markup).toContain(">Details<");
  });

  it("explains when a provider reports no limits", () => {
    const markup = renderToStaticMarkup(
      <ContextUsageLimits provider={null} timestampFormat="locale" />,
    );

    expect(markup).toContain("Usage limits are not available for this provider.");
  });
});
