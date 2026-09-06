import {
  codexGoalStatusAction,
  describeCodexGoalStatus,
  formatCodexGoalStatus,
  formatCodexGoalUsage,
  type CodexGoalSessionActivity,
} from "@t3tools/client-runtime/state/threads";
import {
  CODEX_GOAL_OBJECTIVE_MAX_CHARS,
  type MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadGoal,
} from "@t3tools/contracts";
import { TargetIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export type CodexGoalStatusAction = NonNullable<ReturnType<typeof codexGoalStatusAction>>;

const STATUS_ACTION_LABELS: Record<CodexGoalStatusAction, string> = {
  pause: "Pause",
  resume: "Resume",
  continue: "Continue",
};

const REPORT_EXCERPT_MAX_CHARS = 240;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= REPORT_EXCERPT_MAX_CHARS
    ? flat
    : `${flat.slice(0, REPORT_EXCERPT_MAX_CHARS - 1).trimEnd()}…`;
}

export interface CodexGoalBannerInput {
  readonly id: string;
  readonly goal: OrchestrationThreadGoal;
  readonly activity: CodexGoalSessionActivity;
  /** The assistant message that ended the turn Codex last reported from. */
  readonly reportMessage: OrchestrationMessage | null;
  readonly busy: boolean;
  readonly onStatusAction: (action: CodexGoalStatusAction) => void;
  readonly onEdit: () => void;
  readonly onClear: () => void;
  readonly onShowMessage: (messageId: MessageId) => void;
}

/**
 * The goal notice above the composer: Codex's own status wording, the
 * objective, what Codex is doing about it, and every control the native
 * client offers (pause or resume, edit, clear). A stalled goal also quotes
 * the message that explains the blocker.
 */
export function buildCodexGoalBannerItem(input: CodexGoalBannerInput): ComposerBannerStackItem {
  const { goal, activity, reportMessage, busy } = input;
  const statusAction = codexGoalStatusAction(goal, activity);
  const halted =
    goal.status === "blocked" || goal.status === "usageLimited" || goal.status === "budgetLimited";
  const showReport = goal.status === "blocked" && reportMessage !== null;
  return {
    id: input.id,
    variant: halted ? "warning" : goal.status === "complete" ? "success" : "info",
    icon: <TargetIcon />,
    title: `Goal ${formatCodexGoalStatus(goal.status)}`,
    description: (
      <Tooltip>
        <TooltipTrigger render={<span>{goal.objective}</span>} />
        <TooltipPopup side="top" className="max-w-96 whitespace-normal">
          {goal.objective}
        </TooltipPopup>
      </Tooltip>
    ),
    children: (
      <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        <span>
          {describeCodexGoalStatus(goal, activity)}{" "}
          <span className="tabular-nums">{formatCodexGoalUsage(goal)}</span>
        </span>
        {showReport ? (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 text-pretty text-foreground">
              “{excerpt(reportMessage.text)}”
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => input.onShowMessage(reportMessage.id)}
            >
              Show message
            </Button>
          </span>
        ) : null}
      </div>
    ),
    actions: (
      <span className="flex items-center gap-1">
        {statusAction !== null ? (
          <Button
            type="button"
            size="xs"
            variant={halted || activity === "stopped" ? "default" : "ghost"}
            disabled={busy}
            onClick={() => input.onStatusAction(statusAction)}
          >
            {STATUS_ACTION_LABELS[statusAction]}
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={input.onEdit}>
          Edit
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={input.onClear}>
          Clear
        </Button>
      </span>
    ),
  };
}

export interface CodexGoalEditorSubmission {
  readonly objective: string;
  /** `null` removes the budget. Absent when unchanged. */
  readonly tokenBudget?: number | null;
}

function parseTokenBudget(raw: string): number | null | "invalid" {
  const trimmed = raw.replace(/[,\s_]/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : "invalid";
}

export function CodexGoalEditorDialog(props: {
  readonly open: boolean;
  /** The goal being edited, or `null` when creating one. */
  readonly goal: OrchestrationThreadGoal | null;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (submission: CodexGoalEditorSubmission) => void;
}) {
  const isEditing = props.goal !== null;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit goal" : "Set a goal"}</DialogTitle>
          <DialogDescription>
            Codex keeps working across turns until it can verify the objective is done, and stops to
            ask you when it is stuck.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on the goal record so the form seeds from the live goal each
            time it opens; a stale draft must not overwrite an objective Codex
            changed since. */}
        {props.open ? (
          <CodexGoalEditorForm
            key={props.goal === null ? "new" : `${props.goal.createdAt}:${props.goal.updatedAt}`}
            goal={props.goal}
            saving={props.saving}
            onClose={props.onClose}
            onSubmit={props.onSubmit}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function CodexGoalEditorForm(props: {
  readonly goal: OrchestrationThreadGoal | null;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (submission: CodexGoalEditorSubmission) => void;
}) {
  const formId = useId();
  const [objective, setObjective] = useState(props.goal?.objective ?? "");
  const [tokenBudget, setTokenBudget] = useState(
    props.goal?.tokenBudget == null ? "" : String(props.goal.tokenBudget),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const isEditing = props.goal !== null;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedObjective = objective.trim();
    if (trimmedObjective.length === 0) {
      setValidationError("Give the goal an objective.");
      return;
    }
    if (Array.from(trimmedObjective).length > CODEX_GOAL_OBJECTIVE_MAX_CHARS) {
      setValidationError(
        `Keep the objective under ${CODEX_GOAL_OBJECTIVE_MAX_CHARS.toLocaleString()} characters.`,
      );
      return;
    }
    const budget = parseTokenBudget(tokenBudget);
    if (budget === "invalid") {
      setValidationError("The token budget must be a whole number above zero, or empty.");
      return;
    }
    const previousBudget = props.goal?.tokenBudget ?? null;
    props.onSubmit({
      objective: trimmedObjective,
      ...(budget === previousBudget ? {} : { tokenBudget: budget }),
    });
  };

  return (
    <>
      <DialogPanel>
        <form id={formId} className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-objective`}>Objective</Label>
            <Textarea
              id={`${formId}-objective`}
              autoFocus
              placeholder="Make the test suite pass on CI and open a pull request"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-budget`}>Token budget (optional)</Label>
            <Input
              id={`${formId}-budget`}
              inputMode="numeric"
              placeholder="No limit"
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Codex stops the goal once it has used this many tokens.
            </p>
          </div>
          {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
        </form>
      </DialogPanel>
      <DialogFooter className="dark:border-transparent dark:bg-transparent">
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={props.saving}>
          {props.saving ? "Saving..." : isEditing ? "Save goal" : "Start goal"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function CodexGoalClearDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear this goal?</AlertDialogTitle>
          <AlertDialogDescription>
            Codex stops pursuing the objective and forgets its usage. The conversation stays.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              props.onOpenChange(false);
              props.onConfirm();
            }}
          >
            Clear goal
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
