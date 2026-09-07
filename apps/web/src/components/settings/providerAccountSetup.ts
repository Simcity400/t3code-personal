import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerProvider,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";

export type AccountDriver = "codex" | "claudeAgent";

/** A successful CLI login exits setup; failures remain visible for retry or cancellation. */
export function providerAccountLoginCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
  deviceCode = false,
): string {
  const login =
    resolveOnboardingProviderLoginCommand(provider, settings, platform) +
    (deviceCode && provider.driver === "codex" ? " --device-auth" : "");
  if (provider.installed) {
    return platform === "windows"
      ? `${login}; if ($LASTEXITCODE -eq 0) { exit }`
      : `${login} && exit`;
  }
  const instance = settings.providerInstances[provider.instanceId];
  const config =
    provider.driver === "codex"
      ? decodeCodexSettings(instance?.config ?? settings.providers.codex)
      : decodeClaudeSettings(instance?.config ?? settings.providers.claudeAgent);
  const defaultBinary = provider.driver === "codex" ? "codex" : "claude";
  if (config.binaryPath !== defaultBinary) {
    throw new Error(
      `The configured executable ${config.binaryPath} is unavailable. Update its binary path in provider settings.`,
    );
  }
  const install = resolveOnboardingProviderInstallCommand(
    provider.driver === "codex" ? "codex" : "claudeAgent",
    platform,
  );
  // Installers may exit their shell and update PATH only for future processes.
  // Run them in a child, then expose the native install directories before login.
  return platform === "windows"
    ? `powershell.exe -NoProfile -Command '${install}'; if ($LASTEXITCODE -eq 0) { $env:PATH = (Join-Path $env:USERPROFILE '.local\\bin') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:PATH; ${login}; if ($LASTEXITCODE -eq 0) { exit } }`
    : `bash -o pipefail -c '${install}' && export PATH="$HOME/.local/bin:$PATH" && ${login} && exit`;
}

/** Reuse conversation storage, never another account's credentials or environment secrets. */
export function buildProviderAccount(
  settings: ServerSettings,
  driver: AccountDriver,
  instanceId: ProviderInstanceId,
  name: string,
  shareWith?: ProviderInstanceId,
  conversationHomePath?: string,
): ProviderInstanceConfig {
  const driverKind = ProviderDriverKind.make(driver);
  const baseId = shareWith ?? defaultInstanceIdForDriver(driverKind);
  const base = settings.providerInstances[baseId];
  if (base && base.driver !== driverKind)
    throw new Error("Choose an account of the same provider.");
  if (shareWith && !base)
    throw new Error("The account to share conversations with no longer exists.");
  const environmentHome = (variable: string) =>
    base?.environment?.findLast((entry) => entry.name === variable)?.value.trim();

  if (driver === "codex") {
    const config = decodeCodexSettings(base ? (base.config ?? {}) : settings.providers.codex);
    const homePath =
      conversationHomePath || config.homePath || environmentHome("CODEX_HOME") || "~/.codex";
    return {
      driver: driverKind,
      displayName: name.trim() || "Codex account",
      enabled: true,
      config: {
        binaryPath: config.binaryPath,
        homePath,
        // A sibling stays on the same drive as the shared state on Windows.
        shadowHomePath: `${homePath.replaceAll("\\", "/").replace(/\/$/, "")}/../.t3-codex-accounts/${instanceId}`,
      },
    };
  }

  const config = decodeClaudeSettings(base ? (base.config ?? {}) : settings.providers.claudeAgent);
  const sharedHomePath =
    conversationHomePath ||
    config.sharedHomePath ||
    config.homePath ||
    environmentHome("CLAUDE_CONFIG_DIR") ||
    "~/.claude";
  return {
    driver: driverKind,
    displayName: name.trim() || "Claude account",
    enabled: true,
    config: {
      binaryPath: config.binaryPath,
      homePath: `${sharedHomePath.replaceAll("\\", "/").replace(/\/$/, "")}/../.t3-claude-accounts/${instanceId}`,
      sharedHomePath,
    },
  };
}
