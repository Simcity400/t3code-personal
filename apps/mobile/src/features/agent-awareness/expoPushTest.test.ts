import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: () => Promise.resolve("device"),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createRuntimeCommand: (_runtime: unknown, options: unknown) => options,
}));

import { summarizePersonalExpoPushTest } from "./expoPushTest";

const home = EnvironmentId.make("home");
const office = EnvironmentId.make("office");
const label = (environmentId: EnvironmentId) => `${environmentId} PC`;

describe("summarizePersonalExpoPushTest", () => {
  it("explains each environment's answer and says when nothing was sent", () => {
    const summary = summarizePersonalExpoPushTest(
      [
        { environmentId: home, outcome: "unregistered", detail: null },
        {
          environmentId: office,
          outcome: "rejected",
          detail: "InvalidCredentials: no push key",
        },
      ],
      label,
    );
    expect(summary.title).toBe("Test alert not sent");
    expect(summary.body).toContain("home PC: this environment holds no push token");
    expect(summary.body).toContain("office PC: Expo rejected it (InvalidCredentials: no push key)");
  });
  it("reports a partial send when only some environments delivered", () => {
    const summary = summarizePersonalExpoPushTest(
      [
        { environmentId: home, outcome: "sent", detail: null },
        { environmentId: office, outcome: "unreachable", detail: null },
      ],
      label,
    );
    expect(summary.title).toBe("Test alert partly sent");
    expect(summary.body).toContain("office PC: not connected right now.");
  });
  it("asks for a connection when no environment is known", () => {
    expect(summarizePersonalExpoPushTest([], label).title).toBe("No environments");
  });
});
