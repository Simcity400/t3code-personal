import { DownloadIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import { useForkUpdateState } from "../../hooks/useForkUpdate";
import { ensureLocalApi } from "../../localApi";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// "Official update available" pill for the personal fork (source checkout).
// Sibling of SidebarUpdatePill, which only serves packaged builds and stays
// disabled when running from source.
export function ForkUpdatePill() {
  const state = useForkUpdateState();
  const [dismissed, setDismissed] = useState(false);

  const handleUpdate = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.applyForkUpdate !== "function") return;
    void ensureLocalApi()
      .dialogs.confirm(
        "T3 Code will merge the latest official changes with your customizations, rebuild, and restart. This can take a few minutes. Update now?",
      )
      .then((confirmed) => {
        if (confirmed) void bridge.applyForkUpdate().catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  const handleRetry = useCallback(() => {
    const bridge = window.desktopBridge;
    // Retry goes through the apply flow, not a re-check: after a failed
    // install/build the tree already matches origin/main, so a check would
    // see zero commits behind and clear the error without finishing. The
    // updater treats an apply from "error" as resume.
    if (!bridge || typeof bridge.applyForkUpdate !== "function") return;
    void ensureLocalApi()
      .dialogs.confirm("Retry the update? This resumes where it failed.")
      .then((confirmed) => {
        if (confirmed) void bridge.applyForkUpdate().catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  if (!isElectron || !state?.supported) return null;

  // The error branch deliberately ignores `dismissed`: a dismissal from an
  // earlier state must never hide the retry button that is the only recovery
  // path for a failed apply.
  if (state.status === "error") {
    return (
      <Alert
        variant="warning"
        className="relative rounded-2xl border-warning/40 bg-warning/8 text-xs"
      >
        <TriangleAlertIcon />
        <AlertTitle>Update failed</AlertTitle>
        <AlertDescription>
          {state.message ?? "Something went wrong while updating."}
        </AlertDescription>
        <button
          type="button"
          aria-label="Retry update"
          className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-md text-warning/70 transition-colors hover:text-warning"
          onClick={handleRetry}
        >
          <RotateCwIcon className="size-3.5" />
        </button>
      </Alert>
    );
  }

  if (dismissed) return null;

  if (state.status === "conflict") {
    return (
      <Alert
        variant="warning"
        className="relative rounded-2xl border-warning/40 bg-warning/8 text-xs"
      >
        <TriangleAlertIcon />
        <AlertTitle>Update needs attention</AlertTitle>
        <AlertDescription>
          {state.message ?? "Something went wrong while updating."}
        </AlertDescription>
        <button
          type="button"
          aria-label="Dismiss update message"
          className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-md text-warning/70 transition-colors hover:text-warning"
          onClick={() => setDismissed(true)}
        >
          <XIcon className="size-3.5" />
        </button>
      </Alert>
    );
  }

  if (state.status === "updating" || state.status === "restarting") {
    return (
      <div className="flex h-7 w-full items-center gap-2 rounded-lg bg-primary/15 px-2 text-xs font-medium text-primary">
        <RotateCwIcon className="size-3.5 animate-spin" />
        <span className="truncate">
          {state.status === "restarting" ? "Restarting…" : (state.step ?? "Updating…")}
        </span>
      </div>
    );
  }

  if (state.status !== "update-available") return null;

  const changeCount =
    state.commitsBehind === 1
      ? "1 new official change"
      : `${state.commitsBehind} new official changes`;
  const tooltip = `${changeCount}${
    state.latestSummary ? ` — latest: ${state.latestSummary}` : ""
  }. Click to update and restart.`;

  return (
    <div className="group/forkupdate relative flex h-7 w-full items-center rounded-lg bg-primary/15 text-xs font-medium text-primary">
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors group-has-[button.fork-update-main:hover]/forkupdate:bg-primary/22" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              className="fork-update-main relative flex h-full flex-1 cursor-pointer items-center gap-2 px-2"
              onClick={handleUpdate}
            >
              <DownloadIcon className="size-3.5" />
              <span>Official update available</span>
            </button>
          }
        />
        <TooltipPopup align="start" side="top">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Dismiss update"
              className="mr-1 inline-flex size-5 items-center justify-center rounded-md text-primary/60 transition-colors hover:text-primary"
              onClick={() => setDismissed(true)}
            >
              <XIcon className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">Dismiss until next launch</TooltipPopup>
      </Tooltip>
    </div>
  );
}
