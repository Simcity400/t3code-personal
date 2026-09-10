import { EventId, TurnId, type ServerProviderUsageLimits } from "@t3tools/contracts";
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

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
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

const limits: ServerProviderUsageLimits = {
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
};

describe("ContextWindowMeter", () => {
  it("shows the context reading and total processed tokens", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain(">16%<");
    expect(markup).toContain("159k/1m");
    expect(markup).toContain("4.8m");
    expect(markup).not.toContain("Usage Limits");
  });

  it("renders the control before the thread has reported any context", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={null} usageLimits={limits} />);

    expect(markup).toContain('aria-label="Context window and usage limits"');
    expect(markup).toContain("Not reported yet");
    expect(markup).toContain("Usage Limits");
  });
});

describe("ContextUsageLimits", () => {
  it("renders each window with a bar, used percent, and countdown", () => {
    const markup = renderToStaticMarkup(
      <ContextUsageLimits
        limits={limits}
        accountLabel="Claude Max Subscription"
        timestampFormat="locale"
      />,
    );

    expect(markup).toContain(">Usage Limits<");
    expect(markup).toContain(">Claude Max Subscription<");
    expect(markup).toContain(">Session<");
    expect(markup).toContain(">29% used<");
    expect(markup).toContain(">resets in 2h 22m<");
    expect(markup).toContain(">Weekly<");
    expect(markup).toContain(">86% used<");
    expect(markup).toContain('aria-valuenow="29" aria-label="Session usage"');
    expect(markup).toContain('aria-valuenow="86" aria-label="Weekly usage"');
    expect(markup).toContain(">Details<");
  });

  it("explains when a provider reports no limits", () => {
    const markup = renderToStaticMarkup(
      <ContextUsageLimits limits={null} accountLabel={null} timestampFormat="locale" />,
    );

    expect(markup).toContain("Usage limits are not available for this provider.");
    expect(markup).not.toContain('role="progressbar"');
  });
});
