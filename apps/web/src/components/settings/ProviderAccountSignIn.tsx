import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { lazy, Suspense, useRef, useState } from "react";

import { providerAccountLoginCommand } from "./providerAccountSetup";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ProviderTerminalSession } from "./ProviderSetupTerminal";

const ProviderSetupTerminal = lazy(() =>
  import("./ProviderSetupTerminal").then((module) => ({ default: module.ProviderSetupTerminal })),
);

/** Login and all credential storage run on the selected environment. */
export function ProviderAccountSignIn({
  environmentId,
  environmentLabel,
  provider,
  readOnly,
  initialSession,
  onAuthenticated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly initialSession?: ProviderTerminalSession;
  readonly onAuthenticated?: () => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [session, setSession] = useState<ProviderTerminalSession | null>(initialSession ?? null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const checkingRef = useRef(false);
  const driver = provider?.driver ?? initialSession?.driver;
  const accountName = provider?.displayName ?? "this account";
  const canSignIn =
    !readOnly &&
    provider !== undefined &&
    provider.availability !== "unavailable" &&
    config !== null;

  const startSignIn = (deviceCode: boolean) => {
    if (!canSignIn || !provider || !config || session || checkingRef.current) return;
    if (driver !== "codex" && driver !== "claudeAgent") return;
    let command: string;
    try {
      command = providerAccountLoginCommand(
        provider,
        config.settings,
        config.environment.platform.os,
        deviceCode,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not start sign-in.");
      return;
    }
    setMessage(null);
    setSession({
      environmentId,
      driver: driver === "codex" ? "codex" : "claudeAgent",
      providerInstanceId: provider.instanceId,
      cwd: config.cwd,
      command,
      keybindings: config.keybindings,
    });
  };

  const finishSignIn = async () => {
    const instanceId = session?.providerInstanceId ?? provider?.instanceId;
    if (!instanceId || checkingRef.current) return;
    checkingRef.current = true;
    setSession(null);
    setChecking(true);
    const result = await refreshProviders({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
    const refreshed =
      result._tag === "Success"
        ? result.value.providers.find((entry) => entry.instanceId === instanceId)
        : undefined;
    checkingRef.current = false;
    setChecking(false);
    if (
      refreshed?.auth.status === "authenticated" &&
      !refreshed.auth.stale &&
      (refreshed.status === "ready" || refreshed.checkedAt !== provider?.checkedAt)
    ) {
      setMessage(
        `Signed in${refreshed.auth.email ? ` as ${refreshed.auth.email}` : ""}. Ready to use.`,
      );
      onAuthenticated?.();
    } else {
      setMessage(refreshed?.message ?? "Sign-in was not confirmed. You can try again.");
    }
  };

  return (
    <section aria-label="Account sign-in" className="grid gap-3 text-xs">
      <p>
        Sign in to {accountName} on {environmentLabel}.
      </p>
      {session && !readOnly ? (
        <Suspense fallback={<p className="text-muted-foreground">Opening sign-in…</p>}>
          <ProviderSetupTerminal session={session} autoRun onClose={() => void finishSignIn()} />
        </Suspense>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!canSignIn || checking}
            onClick={() => startSignIn(false)}
          >
            {checking
              ? "Checking sign-in…"
              : provider?.installed
                ? "Sign in"
                : "Install and sign in"}
          </Button>
          {driver === "codex" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canSignIn || checking}
              onClick={() => startSignIn(true)}
            >
              Use device code
            </Button>
          ) : null}
        </div>
      )}
      {message ? <p role="status">{message}</p> : null}
      <p className="text-muted-foreground">
        {driver === "codex"
          ? "Use the matching ChatGPT account. For remote connections, use a device code and open the link on this device."
          : "Use the matching Claude account. If the browser opens on another computer, open the sign-in link here and enter the returned code in the panel."}
      </p>
    </section>
  );
}
