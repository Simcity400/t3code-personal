import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ settings: DEFAULT_SERVER_SETTINGS }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config", refreshProviders: "refresh" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));

import { ProviderAccountSignIn } from "./ProviderAccountSignIn";

const environmentId = EnvironmentId.make("other-computer");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude_personal"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "previous@example.test" },
  checkedAt: "2026-09-07T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
};
const onAuthenticated = vi.fn();
function render() {
  hooks.beginRender();
  return ProviderAccountSignIn({
    environmentId,
    environmentLabel: "Other computer",
    provider,
    readOnly: false,
    onAuthenticated,
    initialSession: {
      environmentId,
      driver: "claudeAgent",
      providerInstanceId: provider.instanceId,
      cwd: "/workspace",
      command: "claude auth login",
      keybindings: [],
    },
  });
}
async function finish() {
  const terminal = visitElements(render(), (element) => element.props.autoRun === true);
  if (!terminal) throw new Error("Expected active login terminal");
  (terminal.props.onClose as () => void)();
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});

it("confirms the freshly probed account on the selected environment", async () => {
  state.refresh.mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [
        { ...provider, auth: { status: "authenticated", email: "personal@example.test" } },
      ],
    },
  });
  await finish();
  expect(state.refresh).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId: provider.instanceId, refreshModels: true },
  });
  expect(onAuthenticated).toHaveBeenCalledOnce();
  expect(
    visitElements(render(), (element) => element.props.role === "status")?.props.children,
  ).toContain("personal@example.test");
});

it("does not confirm a retained authenticated snapshot after an inconclusive probe", async () => {
  state.refresh.mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [{ ...provider, status: "warning", message: "Could not verify authentication" }],
    },
  });
  await finish();
  expect(onAuthenticated).not.toHaveBeenCalled();
  expect(
    visitElements(render(), (element) => element.props.role === "status")?.props.children,
  ).toContain("Could not verify");
});

it("rejects stale authentication even when an intermediate cached check has a newer timestamp", async () => {
  state.refresh.mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [
        {
          ...provider,
          status: "warning",
          checkedAt: "2026-09-07T00:00:02Z",
          auth: { ...provider.auth, stale: true },
          message: "Could not verify authentication",
        },
      ],
    },
  });
  await finish();
  expect(onAuthenticated).not.toHaveBeenCalled();
});
