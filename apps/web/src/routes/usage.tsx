import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/usage")({
  validateSearch: (raw: Record<string, unknown>): { view?: "limits" } =>
    raw.view === "limits" ? { view: "limits" } : {},
  component: UsageRoute,
});

function UsageRoute() {
  const { view } = Route.useSearch();
  return <UsagePage key={view ?? "cost"} initialMetric={view ?? "cost"} />;
}
