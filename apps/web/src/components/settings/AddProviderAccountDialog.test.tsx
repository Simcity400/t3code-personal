import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  defaultInstanceIdForDriver,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  providers: [] as Array<ServerProvider>,
  save: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void) => state.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "providers"
      ? state.providers
      : {
          settings: DEFAULT_SERVER_SETTINGS,
          cwd: "/workspace",
          keybindings: [],
          environment: { platform: { os: "linux" } },
        },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    providersValueAtom: () => "providers",
    updateSettings: "save",
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("./ProviderAccountSignIn", () => ({ ProviderAccountSignIn: () => null }));

import { AddProviderAccountDialog } from "./AddProviderAccountDialog";
import { ProviderAccountSignIn } from "./ProviderAccountSignIn";

const environmentId = EnvironmentId.make("other-computer");
const onCreated = vi.fn();
const onClose = vi.fn();
function render() {
  hooks.beginRender();
  state.effects = [];
  const view = AddProviderAccountDialog({
    environmentId,
    environmentLabel: "Other computer",
    onCreated,
    onClose,
  });
  for (const effect of state.effects) effect();
  return view;
}
function clickAdd(view: ReturnType<typeof render>) {
  const button = visitElements(
    view,
    (element) => element.props.children === "Add account and sign in",
  );
  if (!button) throw new Error("Add account button not found");
  (button.props.onClick as () => void)();
}
async function settleSave() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  state.providers = [sourceProvider];
  vi.clearAllMocks();
  state.save.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { ...DEFAULT_SERVER_SETTINGS, ...input.patch },
  }));
});

it("saves once on the selected computer and waits for registry preparation before sign-in", async () => {
  const view = render();
  clickAdd(view);
  clickAdd(view);
  await settleSave();
  expect(state.save).toHaveBeenCalledTimes(1);
  expect(state.save.mock.calls[0]?.[0].environmentId).toBe(environmentId);
  const instanceId = onCreated.mock.calls[0]?.[0];
  expect(instanceId).toMatch(/^codex_account_/);
  expect(visitElements(render(), (element) => element.type === ProviderAccountSignIn)).toBeNull();
  state.providers = [
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      checkedAt: "2026-09-07T00:00:00Z",
      models: [],
      skills: [],
      slashCommands: [],
    },
  ];
  render();
  expect(visitElements(render(), (element) => element.type === ProviderAccountSignIn)).toBeNull();
  state.providers = [
    {
      ...state.providers[0]!,
      installed: true,
      status: "error",
      auth: { status: "unauthenticated" },
    },
  ];
  render();
  expect(
    visitElements(render(), (element) => element.type === ProviderAccountSignIn),
  ).not.toBeNull();
  const saved = state.save.mock.calls[0]?.[0].input.patch.providerInstances[instanceId];
  expect(saved.config.homePath).toBe("/server/custom-codex");
  expect(saved.config.shadowHomePath).toContain(instanceId);
});

it("keeps the form retryable after a failed settings write without launching login", async () => {
  state.save.mockResolvedValueOnce({ _tag: "Failure" });
  clickAdd(render());
  await settleSave();
  const failed = render();
  expect(
    visitElements(failed, (element) => element.props.role === "alert")?.props.children,
  ).toContain("Could not save");
  expect(onCreated).not.toHaveBeenCalled();
  expect(visitElements(failed, (element) => element.type === ProviderAccountSignIn)).toBeNull();
  clickAdd(failed);
  await settleSave();
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(Object.keys(state.save.mock.calls[1]?.[0].input.patch.providerInstances)).toEqual(
    Object.keys(state.save.mock.calls[0]?.[0].input.patch.providerInstances),
  );
});

const sourceProvider: ServerProvider = {
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-07T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  continuation: { groupKey: "codex:custom", conversationHomePath: "/server/custom-codex" },
};

it("waits for a new preparation result instead of consuming the old failure on retry", async () => {
  clickAdd(render());
  await settleSave();
  const instanceId = ProviderInstanceId.make(onCreated.mock.calls[0]?.[0]);
  const failed: ServerProvider = {
    ...sourceProvider,
    instanceId,
    availability: "unavailable",
    message: "Preparation failed",
  };
  state.providers = [sourceProvider, failed];
  render();
  clickAdd(render());
  await settleSave();
  render();
  const waiting = render();
  expect(visitElements(waiting, (element) => element.props.role === "alert")).toBeNull();
  expect(visitElements(waiting, (element) => element.type === ProviderAccountSignIn)).toBeNull();
  state.providers = [
    sourceProvider,
    { ...sourceProvider, instanceId, checkedAt: "2026-09-07T00:00:01Z" },
  ];
  render();
  expect(
    visitElements(render(), (element) => element.type === ProviderAccountSignIn),
  ).not.toBeNull();
  expect(onCreated.mock.calls[1]?.[0]).toBe(instanceId);
});

it("does not guess another computer's conversation directory before it is known", async () => {
  state.providers = [];
  clickAdd(render());
  await settleSave();
  expect(state.save).not.toHaveBeenCalled();
  expect(
    visitElements(render(), (element) => element.props.role === "alert")?.props.children,
  ).toContain("Conversation storage is not ready");
});
