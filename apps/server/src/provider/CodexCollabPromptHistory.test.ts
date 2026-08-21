// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { scanNativeCollabPromptRollout } from "./CodexCollabPromptHistory.ts";

const fixturePath = NodePath.join(
  import.meta.dirname,
  `.native-collab-prompts-${process.pid}.jsonl`,
);

afterEach(() => NodeFS.rmSync(fixturePath, { force: true }));

function line(payload: unknown, type: "response_item" | "event_msg"): string {
  return JSON.stringify({ type, payload });
}

describe("native Codex collaboration prompt history", () => {
  it("correlates the exact spawn message with the child activity", async () => {
    const rows = [
      line(
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-1",
          arguments: JSON.stringify({
            task_name: "reviewer",
            message: "  Review the exact diff.\n\n",
          }),
        },
        "response_item",
      ),
      // Native Codex appends the activity before the function-call output.
      line(
        {
          type: "sub_agent_activity",
          agent_thread_id: "child-1",
          agent_path: "/root/reviewer",
          kind: "started",
        },
        "event_msg",
      ),
      line(
        {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ task_name: "/root/reviewer" }),
        },
        "response_item",
      ),
    ];
    NodeFS.writeFileSync(fixturePath, `${rows.join("\n")}\n`, "utf8");

    const scanned = await scanNativeCollabPromptRollout(fixturePath);

    expect(scanned?.links).toEqual([
      { receiverThreadId: "child-1", prompt: "  Review the exact diff.\n\n" },
    ]);
  });

  it("recovers encrypted rollout arguments as prompt linkage", async () => {
    const rows = [
      line(
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-encrypted",
          arguments: JSON.stringify({
            task_name: "reviewer",
            message: `gAAAAA${"x".repeat(90)}`,
          }),
        },
        "response_item",
      ),
      line(
        {
          type: "sub_agent_activity",
          agent_thread_id: "child-encrypted",
          agent_path: "/root/reviewer",
          kind: "started",
        },
        "event_msg",
      ),
    ];
    NodeFS.writeFileSync(fixturePath, `${rows.join("\n")}\n`, "utf8");

    const scanned = await scanNativeCollabPromptRollout(fixturePath);

    // The client turns ciphertext into a placeholder row: dropping it here
    // left a reopened transcript with no sign an instruction was ever sent.
    expect(scanned?.links).toEqual([
      { receiverThreadId: "child-encrypted", prompt: `gAAAAA${"x".repeat(90)}` },
    ]);
  });

  it("keeps repeated task paths paired when outputs are interleaved", async () => {
    const spawn = (callId: string, message: string) =>
      line(
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({ task_name: "reviewer", message }),
        },
        "response_item",
      );
    const activity = (agentThreadId: string) =>
      line(
        {
          type: "sub_agent_activity",
          agent_thread_id: agentThreadId,
          agent_path: "/root/reviewer",
          kind: "started",
        },
        "event_msg",
      );
    const output = (callId: string) =>
      line(
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ task_name: "/root/reviewer" }),
        },
        "response_item",
      );
    NodeFS.writeFileSync(
      fixturePath,
      `${[
        spawn("call-a", "Prompt A"),
        spawn("call-b", "Prompt B"),
        activity("child-a"),
        activity("child-b"),
        output("call-b"),
        output("call-a"),
      ].join("\n")}\n`,
      "utf8",
    );

    const scanned = await scanNativeCollabPromptRollout(fixturePath);

    expect(scanned?.links).toEqual([
      { receiverThreadId: "child-a", prompt: "Prompt A" },
      { receiverThreadId: "child-b", prompt: "Prompt B" },
    ]);
  });

  it("keeps spawn order when reversed outputs precede same-path activities", async () => {
    const spawn = (callId: string, message: string) =>
      line(
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({ task_name: "reviewer", message }),
        },
        "response_item",
      );
    const output = (callId: string) =>
      line(
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ task_name: "/root/reviewer" }),
        },
        "response_item",
      );
    const activity = (agentThreadId: string) =>
      line(
        {
          type: "sub_agent_activity",
          agent_thread_id: agentThreadId,
          agent_path: "/root/reviewer",
          kind: "started",
        },
        "event_msg",
      );
    NodeFS.writeFileSync(
      fixturePath,
      `${[
        spawn("call-a", "Prompt A"),
        spawn("call-b", "Prompt B"),
        output("call-b"),
        output("call-a"),
        activity("child-a"),
        activity("child-b"),
      ].join("\n")}\n`,
      "utf8",
    );

    const scanned = await scanNativeCollabPromptRollout(fixturePath);

    expect(scanned?.links).toEqual([
      { receiverThreadId: "child-a", prompt: "Prompt A" },
      { receiverThreadId: "child-b", prompt: "Prompt B" },
    ]);
  });

  it("pairs an output that arrives before its child activity", async () => {
    const rows = [
      line(
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-output-first",
          arguments: JSON.stringify({ message: "Output first prompt" }),
        },
        "response_item",
      ),
      line(
        {
          type: "function_call_output",
          call_id: "call-output-first",
          output: JSON.stringify({ task_name: "/root/output_first" }),
        },
        "response_item",
      ),
      line(
        {
          type: "sub_agent_activity",
          agent_thread_id: "child-output-first",
          agent_path: "/root/output_first",
          kind: "started",
        },
        "event_msg",
      ),
    ];
    NodeFS.writeFileSync(fixturePath, `${rows.join("\n")}\n`, "utf8");

    const scanned = await scanNativeCollabPromptRollout(fixturePath);

    expect(scanned?.links).toEqual([
      { receiverThreadId: "child-output-first", prompt: "Output first prompt" },
    ]);
  });

  it("resumes after the last complete line without losing an active write", async () => {
    const spawn = line(
      {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call-2",
        arguments: JSON.stringify({ task_name: "auditor", message: "Audit the mobile crash." }),
      },
      "response_item",
    );
    const activity = line(
      {
        type: "sub_agent_activity",
        agent_thread_id: "child-2",
        agent_path: "/root/auditor",
        kind: "started",
      },
      "event_msg",
    );
    NodeFS.writeFileSync(fixturePath, `${spawn}\n${activity}`, "utf8");

    const first = await scanNativeCollabPromptRollout(fixturePath);
    expect(first?.links).toEqual([]);

    NodeFS.appendFileSync(fixturePath, "\n", "utf8");
    const second = await scanNativeCollabPromptRollout(fixturePath, first?.cursor);

    expect(second?.links).toEqual([
      { receiverThreadId: "child-2", prompt: "Audit the mobile crash." },
    ]);
    expect(second?.cursor.offset).toBe(NodeFS.statSync(fixturePath).size);
  });

  it("restarts when a rollout is replaced and regrown past the saved offset", async () => {
    const rows = (callId: string, childId: string, prompt: string) => [
      line(
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({ task_name: "reviewer", message: prompt }),
        },
        "response_item",
      ),
      line(
        {
          type: "sub_agent_activity",
          agent_thread_id: childId,
          agent_path: "/root/reviewer",
          kind: "started",
        },
        "event_msg",
      ),
    ];
    NodeFS.writeFileSync(fixturePath, `${rows("old-call", "old-child", "Old").join("\n")}\n`);
    const first = await scanNativeCollabPromptRollout(fixturePath);
    expect(first?.links).toEqual([{ receiverThreadId: "old-child", prompt: "Old" }]);

    const replacement = rows(
      "replacement-call-with-a-longer-id",
      "replacement-child",
      "Replacement prompt that makes the rewritten rollout longer than the old cursor",
    );
    NodeFS.writeFileSync(fixturePath, `${replacement.join("\n")}\n`, "utf8");
    expect(NodeFS.statSync(fixturePath).size).toBeGreaterThan(first?.cursor.offset ?? 0);

    const second = await scanNativeCollabPromptRollout(fixturePath, first?.cursor);

    expect(second?.links).toEqual([
      {
        receiverThreadId: "replacement-child",
        prompt: "Replacement prompt that makes the rewritten rollout longer than the old cursor",
      },
    ]);
  });
});
