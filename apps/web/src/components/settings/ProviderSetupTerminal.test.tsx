import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | void>,
  open: vi.fn(async (_input: unknown) => ({ _tag: "Success" as const })),
  write: vi.fn(async (_input: unknown) => ({ _tag: "Success" as const })),
  close: vi.fn(async (_input: unknown) => ({ _tag: "Success" as const })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => (() => void) | void) => state.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false] }));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write", close: "close" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "open" | "write" | "close") => state[name],
}));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));

import { ProviderSetupTerminal, type ProviderTerminalSession } from "./ProviderSetupTerminal";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const session: ProviderTerminalSession = {
  environmentId: EnvironmentId.make("remote-host"),
  driver: "codex",
  providerInstanceId: ProviderInstanceId.make("codex_work"),
  cwd: "/workspace",
  command: "codex login --device-auth",
  keybindings: [],
};

beforeEach(() => {
  hooks.reset();
  state.effects = [];
  vi.clearAllMocks();
});

describe("ProviderSetupTerminal", () => {
  it.each([false, true])(
    "opens the selected account and submits only when autoRun=%s",
    async (autoRun) => {
      const wrote = deferred<void>();
      const closed = deferred<void>();
      state.write.mockImplementationOnce(async () => {
        wrote.resolve();
        return { _tag: "Success" };
      });
      state.close.mockImplementationOnce(async () => {
        closed.resolve();
        return { _tag: "Success" };
      });
      hooks.beginRender();
      ProviderSetupTerminal({ session, autoRun, onClose: vi.fn() });
      const cleanup = state.effects[0]!();
      await wrote.promise;
      expect(state.open).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: session.environmentId,
          input: expect.objectContaining({
            providerInstanceId: session.providerInstanceId,
            cwd: session.cwd,
          }),
        }),
      );
      expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: session.environmentId,
          input: expect.objectContaining({
            data: autoRun ? `${session.command}\r` : session.command,
          }),
        }),
      );
      cleanup?.();
      await closed.promise;
      expect(state.close).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: session.environmentId,
          input: expect.objectContaining({ deleteHistory: true }),
        }),
      );
    },
  );

  it("cancels a pending open before submitting and serializes the replacement login", async () => {
    const started = deferred<void>();
    const opened = deferred<{ _tag: "Success" }>();
    const wrote = deferred<void>();
    state.open.mockImplementationOnce(() => {
      started.resolve();
      return opened.promise;
    });
    state.write.mockImplementationOnce(async () => {
      wrote.resolve();
      return { _tag: "Success" };
    });
    hooks.beginRender();
    ProviderSetupTerminal({ session, autoRun: true, onClose: vi.fn() });
    const setup = state.effects[0]!;
    const cleanup = setup();
    await started.promise;
    cleanup?.();
    const replacementCleanup = setup();
    opened.resolve({ _tag: "Success" });
    await wrote.promise;
    expect(state.open).toHaveBeenCalledTimes(2);
    expect(state.close).toHaveBeenCalledTimes(1);
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.close.mock.invocationCallOrder[0]).toBeLessThan(
      state.open.mock.invocationCallOrder[1]!,
    );
    replacementCleanup?.();
  });
});
