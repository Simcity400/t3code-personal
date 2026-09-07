import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
import { describe, expect, it } from "vite-plus/test";
import { buildProviderAccount, providerAccountLoginCommand } from "./providerAccountSetup";

const accountId = ProviderInstanceId.make("codex_account_new");
const baseId = ProviderInstanceId.make("codex_work");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [baseId]: {
      driver: ProviderDriverKind.make("codex"),
      config: {
        binaryPath: "/tools/codex",
        homePath: "/shared/codex",
        shadowHomePath: "/private/work",
      },
      environment: [{ name: "OPENAI_API_KEY", value: "other-account-secret", sensitive: true }],
    },
  },
};

describe("buildProviderAccount", () => {
  it("uses server-resolved conversation storage when the environment inherits a custom home", () => {
    const account = buildProviderAccount(
      DEFAULT_SERVER_SETTINGS,
      "claudeAgent",
      accountId,
      "Personal",
      undefined,
      "/mounted/claude",
    );
    const config = decodeClaudeSettings(account.config);
    expect(config.sharedHomePath).toBe("/mounted/claude");
    expect(config.homePath).toBe(`/mounted/claude/../.t3-claude-accounts/${accountId}`);
  });
  it("shares the selected Codex conversation home while isolating login and secrets", () => {
    const account = buildProviderAccount(settings, "codex", accountId, "Personal", baseId);
    const config = decodeCodexSettings(account.config);
    expect(config.binaryPath).toBe("/tools/codex");
    expect(config.homePath).toBe("/shared/codex");
    expect(config.shadowHomePath).toBe("/shared/codex/../.t3-codex-accounts/codex_account_new");
    expect(account.environment).toBeUndefined();
    expect(account.displayName).toBe("Personal");
  });

  it("gives repeated accounts distinct homes without disturbing the normal Codex login", () => {
    const first = buildProviderAccount(DEFAULT_SERVER_SETTINGS, "codex", accountId, "First");
    const second = buildProviderAccount(
      DEFAULT_SERVER_SETTINGS,
      "codex",
      ProviderInstanceId.make("codex_second"),
      "Second",
    );
    const decode = Schema.decodeUnknownSync(CodexSettings);
    expect(decode(first.config).homePath).toBe("~/.codex");
    expect(decode(second.config).homePath).toBe(decode(first.config).homePath);
    expect(decode(second.config).shadowHomePath).not.toBe(decode(first.config).shadowHomePath);
  });

  it("follows Claude's shared conversation home on the same Windows drive", () => {
    const claudeId = ProviderInstanceId.make("claude_work");
    const claudeSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: {
            homePath: "D:\\accounts\\work",
            sharedHomePath: "D:\\conversations\\claude",
          },
        },
      },
    };
    const account = buildProviderAccount(
      claudeSettings,
      "claudeAgent",
      ProviderInstanceId.make("claude_personal"),
      "Personal",
      claudeId,
    );
    const config = decodeClaudeSettings(account.config);
    expect(config.sharedHomePath).toBe("D:\\conversations\\claude");
    expect(config.homePath).toBe("D:/conversations/claude/../.t3-claude-accounts/claude_personal");
    expect(account.environment).toBeUndefined();
  });

  it("rejects a removed or different-provider source", () => {
    expect(() => buildProviderAccount(settings, "claudeAgent", accountId, "New", baseId)).toThrow(
      "same provider",
    );
    expect(() =>
      buildProviderAccount(settings, "codex", accountId, "New", ProviderInstanceId.make("missing")),
    ).toThrow("no longer exists");
  });
});

function provider(driver: "codex" | "claudeAgent", installed: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed,
    version: null,
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-09-07T00:00:00Z",
    models: [],
    skills: [],
    slashCommands: [],
  };
}

describe("providerAccountLoginCommand", () => {
  it("installs missing providers and only proceeds to login when installation succeeds", () => {
    expect(
      providerAccountLoginCommand(provider("codex", false), DEFAULT_SERVER_SETTINGS, "linux", true),
    ).toBe("npm install -g @openai/codex && codex login --device-auth && exit");
    expect(
      providerAccountLoginCommand(
        provider("claudeAgent", false),
        DEFAULT_SERVER_SETTINGS,
        "darwin",
      ),
    ).toBe("npm install -g @anthropic-ai/claude-code && claude auth login && exit");
  });

  it("preserves failures in Windows terminals and uses application shims", () => {
    const command = providerAccountLoginCommand(
      provider("claudeAgent", false),
      DEFAULT_SERVER_SETTINGS,
      "windows",
    );
    expect(command).toContain(
      "npm.cmd install -g @anthropic-ai/claude-code; if ($LASTEXITCODE -eq 0)",
    );
    expect(command).toContain("Get-Command claude -CommandType Application");
    expect(command).toContain("auth login; if ($LASTEXITCODE -eq 0) { exit }");
  });

  it("uses private file credentials for Codex shadow accounts", () => {
    const account = buildProviderAccount(DEFAULT_SERVER_SETTINGS, "codex", accountId, "Personal");
    expect(
      providerAccountLoginCommand(
        { ...provider("codex", true), instanceId: accountId },
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [accountId]: account },
        },
        "linux",
      ),
    ).toBe("codex login --config cli_auth_credentials_store=file && exit");
  });

  it("does not install an unrelated global executable when a custom binary is missing", () => {
    expect(() =>
      providerAccountLoginCommand(
        { ...provider("codex", false), instanceId: baseId },
        settings,
        "linux",
      ),
    ).toThrow("configured executable /tools/codex");
  });
});
