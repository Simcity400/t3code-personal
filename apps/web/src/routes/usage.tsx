import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/usage")({
  validateSearch: (raw: Record<string, unknown>): { view?: "limits" } =>
    raw.view === "limits" ? { view: "limits" } : {},
  component: UsageRoute,
});

function UsageRoute() {
  const { view } = Route.useSearch();
  // No `view` means the page opens on the metric the user last chose there.
  return <UsagePage key={view ?? "default"} initialMetric={view} />;
}
