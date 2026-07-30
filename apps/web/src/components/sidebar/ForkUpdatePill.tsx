import { DownloadIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import { useForkUpdateState } from "../../hooks/useForkUpdate";
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
    const confirmed = window.confirm(
      "T3 Code will merge the latest official changes with your customizations, rebuild, and restart. This can take a few minutes. Update now?",
    );
    if (!confirmed) return;
    void bridge.applyForkUpdate().catch(() => undefined);
  }, []);

  if (!isElectron || !state?.supported || dismissed) return null;

  if (state.status === "conflict" || state.status === "error") {
    return (
      <Alert
        variant="warning"
        className="relative rounded-2xl border-warning/40 bg-warning/8 text-xs"
      >
        <TriangleAlertIcon />
        <AlertTitle>
          {state.status === "conflict" ? "Update needs attention" : "Update failed"}
        </AlertTitle>
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

  // Official part: commitsBehind 0 with update-available means a nightly
  // release shipped without new upstream commits (updating re-pins the
  // version). Personal part: commits another machine pushed to the private
  // backup repo.
  const parts: string[] = [];
  if (state.commitsBehind > 0) {
    parts.push(
      state.commitsBehind === 1
        ? "1 new official change"
        : `${state.commitsBehind} new official changes`,
    );
  }
  if (state.personalCommitsBehind > 0) {
    parts.push(
      state.personalCommitsBehind === 1
        ? "1 change from your other computer"
        : `${state.personalCommitsBehind} changes from your other computer`,
    );
  }
  const changeCount = parts.length > 0 ? parts.join(" and ") : "New official release";
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
              <span>
                {state.commitsBehind === 0 && state.personalCommitsBehind > 0
                  ? "Update from your other computer"
                  : "Official update available"}
              </span>
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
