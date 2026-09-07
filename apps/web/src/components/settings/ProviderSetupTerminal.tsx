import { useEffect, useMemo, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import {
  ThreadId,
  type EnvironmentId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";

const PROVIDER_SETUP_THREAD_ID = ThreadId.make("onboarding-agent-setup");

/** Capture the selected account and environment for the lifetime of a setup terminal. */
export interface ProviderTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: "codex" | "claudeAgent";
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

/**
 * Account-scoped setup terminal. Onboarding pre-types commands for review;
 * an explicit Settings sign-in action submits its login command immediately.
 */
export function ProviderSetupTerminal({
  session,
  onClose,
  autoRun = false,
}: {
  readonly session: ProviderTerminalSession;
  readonly autoRun?: boolean;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, PROVIDER_SETUP_THREAD_ID),
    [environmentId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close or pre-type
  // into the replacement session that shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: PROVIDER_SETUP_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;

      const wrote = await writeTerminal({
        environmentId,
        input: {
          threadId: PROVIDER_SETUP_THREAD_ID,
          terminalId,
          data: autoRun ? `${command}\r` : command,
        },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Closing setup or switching accounts unmounts the terminal. Serialize
    // cleanup with setup so a delayed open cannot leave a login running.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: PROVIDER_SETUP_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    autoRun,
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div className="thread-terminal-drawer mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            autoRun ? (
              "Complete sign-in below, then close to refresh account status."
            ) : (
              "Review the command, then press Enter to run it."
            )
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button size="xs" variant="ghost" onClick={() => setSetupAttempt((value) => value + 1)}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={PROVIDER_SETUP_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Setup ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
