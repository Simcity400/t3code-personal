import { useAtomValue } from "@effect/atom-react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ProviderAccountSignIn } from "./ProviderAccountSignIn";
import {
  buildProviderAccount,
  providerAccountLoginCommand,
  type AccountDriver,
} from "./providerAccountSetup";
import type { ProviderTerminalSession } from "./ProviderSetupTerminal";

export function AddProviderAccountDialog({
  environmentId,
  environmentLabel,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onCreated: (instanceId: ProviderInstanceId) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [driver, setDriver] = useState<AccountDriver>("codex");
  const [name, setName] = useState("");
  const [shareWith, setShareWith] = useState<ProviderInstanceId | undefined>();
  const [deviceCode, setDeviceCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    provider: ServerProvider;
    session: ProviderTerminalSession;
  } | null>(null);
  const [savedAccount, setSavedAccount] = useState<{
    instanceId: ProviderInstanceId;
    settings: ServerSettings;
    previousUnavailableCheckedAt?: string;
  } | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [createdId, setCreatedId] = useState<ProviderInstanceId | null>(null);
  const accounts = providers.filter((provider) => provider.driver === driver);

  const addAccount = async () => {
    if (!config || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Keep the same ID on retries after a save or refresh failure.
      const instanceId = createdId ?? ProviderInstanceId.make(`${driver}_account_${randomUUID()}`);
      const sourceId = shareWith ?? defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
      const conversationHomePath = providers.find((entry) => entry.instanceId === sourceId)
        ?.continuation?.conversationHomePath;
      if (!conversationHomePath) {
        throw new Error(
          "Conversation storage is not ready. Refresh providers and try again. Older environments may need an update.",
        );
      }
      const instance = buildProviderAccount(
        config.settings,
        driver,
        instanceId,
        name,
        shareWith,
        conversationHomePath,
      );
      const previous = providers.find((entry) => entry.instanceId === instanceId);
      // The server may persist the write even if its acknowledgement is lost.
      setCreatedId(instanceId);
      const saved = await saveSettings({
        environmentId,
        input: {
          patch: {
            providerInstances: { ...config.settings.providerInstances, [instanceId]: instance },
          },
        },
      });
      if (saved._tag !== "Success") throw new Error("Could not save the account. Try again.");
      onCreated(instanceId);
      setSavedAccount({
        instanceId,
        settings: saved.value,
        ...(previous?.availability === "unavailable"
          ? { previousUnavailableCheckedAt: previous.checkedAt }
          : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account setup failed. Try again.");
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Provider snapshots arrive after registry reconciliation. Wait on that stream,
  // rather than racing a settings acknowledgement with a new login process.
  useEffect(() => {
    if (!savedAccount || created || !config) return;
    const provider = providers.find((entry) => entry.instanceId === savedAccount.instanceId);
    if (!provider || (!provider.installed && provider.status === "warning")) return;
    if (
      provider.availability === "unavailable" &&
      provider.checkedAt === savedAccount.previousUnavailableCheckedAt
    )
      return;
    try {
      if (provider.availability === "unavailable") {
        throw new Error(provider.message ?? "Account preparation failed.");
      }
      const command = providerAccountLoginCommand(
        provider,
        savedAccount.settings,
        config.environment.platform.os,
        deviceCode,
      );
      setCreated({
        provider,
        session: {
          environmentId,
          driver,
          providerInstanceId: savedAccount.instanceId,
          cwd: config.cwd,
          command,
          keybindings: config.keybindings,
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account preparation failed.");
      setSavedAccount(null);
    }
    busyRef.current = false;
    setBusy(false);
  }, [savedAccount, created, config, providers, environmentId, driver, deviceCode]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!busyRef.current || savedAccount)) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{created ? "Sign in to your account" : "Add account"}</DialogTitle>
          <DialogDescription>
            Add an account on {environmentLabel}. T3 keeps its login separate and lets it continue
            your existing conversations.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-4">
          {created ? (
            <ProviderAccountSignIn
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              provider={
                providers.find((entry) => entry.instanceId === created.provider.instanceId) ??
                created.provider
              }
              readOnly={false}
              initialSession={created.session}
              onAuthenticated={() => setAuthenticated(true)}
            />
          ) : (
            <fieldset disabled={busy} className="grid gap-4">
              <div className="flex gap-2" aria-label="Provider">
                {(["codex", "claudeAgent"] as const).map((option) => (
                  <Button
                    key={option}
                    variant={driver === option ? "default" : "outline"}
                    disabled={createdId !== null}
                    onClick={() => {
                      setDriver(option);
                      setShareWith(undefined);
                    }}
                  >
                    {option === "codex" ? "Codex" : "Claude"}
                  </Button>
                ))}
              </div>
              <label className="grid gap-2 text-sm">
                Account name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Personal or Work"
                />
              </label>
              {accounts.length > 1 ? (
                <label className="grid gap-2 text-sm">
                  Continue conversations from
                  <select
                    disabled={createdId !== null}
                    className="rounded-md border bg-background p-2"
                    value={shareWith ?? ""}
                    onChange={(event) =>
                      setShareWith(
                        event.target.value
                          ? ProviderInstanceId.make(event.target.value)
                          : undefined,
                      )
                    }
                  >
                    <option value="">
                      Default {driver === "codex" ? "Codex" : "Claude"} account
                    </option>
                    {accounts
                      .filter((account) => config?.settings.providerInstances[account.instanceId])
                      .map((account) => (
                        <option key={account.instanceId} value={account.instanceId}>
                          {account.displayName ?? account.instanceId}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              {driver === "codex" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={deviceCode}
                    onChange={(event) => setDeviceCode(event.target.checked)}
                  />
                  Use a device code for a remote computer
                </label>
              ) : null}
            </fieldset>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy && !savedAccount} onClick={onClose}>
            {authenticated ? "Done" : "Close"}
          </Button>
          {!created ? (
            <Button disabled={!config || busy} onClick={() => void addAccount()}>
              {busy ? "Preparing account…" : "Add account and sign in"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
