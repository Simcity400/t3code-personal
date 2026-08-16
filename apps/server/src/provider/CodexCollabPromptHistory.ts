// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Schema from "effect/Schema";

const SpawnArguments = Schema.Struct({
  task_name: Schema.optionalKey(Schema.String),
  message: Schema.String,
});
const SpawnOutput = Schema.Struct({ task_name: Schema.String });
const SpawnCallRow = Schema.Struct({
  type: Schema.Literal("response_item"),
  payload: Schema.Struct({
    type: Schema.Literal("function_call"),
    name: Schema.Literal("spawn_agent"),
    call_id: Schema.String,
    arguments: Schema.String,
  }),
});
const SpawnCallOutputRow = Schema.Struct({
  type: Schema.Literal("response_item"),
  payload: Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.String,
  }),
});
const SubAgentActivityRow = Schema.Struct({
  type: Schema.Literal("event_msg"),
  payload: Schema.Struct({
    type: Schema.Literal("sub_agent_activity"),
    agent_thread_id: Schema.String,
    agent_path: Schema.String,
  }),
});
const isSpawnArguments = Schema.is(SpawnArguments);
const isSpawnOutput = Schema.is(SpawnOutput);
const isSpawnCallRow = Schema.is(SpawnCallRow);
const isSpawnCallOutputRow = Schema.is(SpawnCallOutputRow);
const isSubAgentActivityRow = Schema.is(SubAgentActivityRow);

interface PendingSpawn {
  readonly prompt: string;
  readonly taskName: string | undefined;
  readonly sequence: number;
  readonly agentThreadId?: string;
}

interface NativeCollabPromptParserState {
  nextSpawnSequence: number;
  readonly pendingSpawns: Map<string, PendingSpawn>;
  readonly completedSpawnsByPath: Map<string, ReadonlyArray<PendingSpawn>>;
  readonly unpairedAgentsByPath: Map<string, ReadonlyArray<string>>;
  readonly promptByAgent: Map<string, string>;
}

export interface NativeCollabPromptRolloutCursor {
  readonly offset: number;
  readonly device: number;
  readonly inode: number;
  readonly birthtimeMs: number;
  readonly boundaryHash: string;
  readonly state: NativeCollabPromptParserState;
}

export interface NativeCollabPromptLink {
  readonly receiverThreadId: string;
  readonly prompt: string;
}

function makeParserState(): NativeCollabPromptParserState {
  return {
    nextSpawnSequence: 0,
    pendingSpawns: new Map(),
    completedSpawnsByPath: new Map(),
    unpairedAgentsByPath: new Map(),
    promptByAgent: new Map(),
  };
}

function cloneParserState(state: NativeCollabPromptParserState): NativeCollabPromptParserState {
  return {
    nextSpawnSequence: state.nextSpawnSequence,
    pendingSpawns: new Map(state.pendingSpawns),
    completedSpawnsByPath: new Map(
      Array.from(state.completedSpawnsByPath, ([path, spawns]) => [path, [...spawns]]),
    ),
    unpairedAgentsByPath: new Map(
      Array.from(state.unpairedAgentsByPath, ([path, agents]) => [path, [...agents]]),
    ),
    promptByAgent: new Map(state.promptByAgent),
  };
}

function parseJson(text: string): unknown {
  try {
    // Rollout JSONL is Codex-owned input. The narrow schemas below validate
    // every value before it participates in transcript recovery.
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function pathMatchesTaskName(agentPath: string, taskName: string): boolean {
  return agentPath === taskName || agentPath.endsWith(`/${taskName}`);
}

function rememberAgentPrompt(
  state: NativeCollabPromptParserState,
  agentThreadId: string,
  prompt: string,
): void {
  if (prompt.trim().length > 0) {
    state.promptByAgent.set(agentThreadId, prompt);
  }
}

function shiftQueue<T>(queues: Map<string, ReadonlyArray<T>>, key: string): T | undefined {
  const queue = queues.get(key);
  const value = queue?.[0];
  if (!queue || value === undefined) {
    return undefined;
  }
  if (queue.length === 1) {
    queues.delete(key);
  } else {
    queues.set(key, queue.slice(1));
  }
  return value;
}

function pushQueue<T>(queues: Map<string, ReadonlyArray<T>>, key: string, value: T): void {
  queues.set(key, [...(queues.get(key) ?? []), value]);
}

function pushCompletedSpawn(
  queues: Map<string, ReadonlyArray<PendingSpawn>>,
  key: string,
  value: PendingSpawn,
): void {
  const ordered = [...(queues.get(key) ?? []), value];
  ordered.sort((left, right) => left.sequence - right.sequence);
  queues.set(key, ordered);
}

/**
 * Reduces one native Codex rollout line into stable child-thread prompt links.
 *
 * Current Codex multi-agent v2 rollouts persist `spawn_agent` as a raw
 * function call and the child identity as a separate `sub_agent_activity`.
 * App-server's high-level thread history intentionally omits the raw function
 * call, so this is the lossless fallback for both live and reopened threads.
 */
function reduceNativeCollabPromptRolloutLine(
  state: NativeCollabPromptParserState,
  line: string,
): void {
  if (
    !line.includes('"spawn_agent"') &&
    !line.includes('"function_call_output"') &&
    !line.includes('"sub_agent_activity"')
  ) {
    return;
  }

  const row = parseJson(line);
  if (isSpawnCallRow(row)) {
    const args = parseJson(row.payload.arguments);
    if (!isSpawnArguments(args)) {
      return;
    }
    const prompt = args.message;
    if (prompt.trim().length === 0) {
      return;
    }
    state.pendingSpawns.set(row.payload.call_id, {
      prompt,
      taskName: args.task_name?.trim() || undefined,
      sequence: state.nextSpawnSequence,
    });
    state.nextSpawnSequence += 1;
    return;
  }

  if (isSubAgentActivityRow(row)) {
    const agentThreadId = row.payload.agent_thread_id;
    const agentPath = row.payload.agent_path;
    if (state.promptByAgent.has(agentThreadId)) {
      return;
    }

    // `started` is normally appended before the matching function-call
    // output. Bind duplicate task paths in call order and retain that binding
    // through delayed or interleaved outputs so a newer child can never
    // rewrite an older child's launch prompt.
    const pendingEntry = Array.from(state.pendingSpawns).find(
      ([, spawn]) =>
        spawn.agentThreadId === undefined &&
        spawn.taskName !== undefined &&
        pathMatchesTaskName(agentPath, spawn.taskName),
    );
    if (pendingEntry) {
      const [callId, pending] = pendingEntry;
      state.pendingSpawns.set(callId, { ...pending, agentThreadId });
      rememberAgentPrompt(state, agentThreadId, pending.prompt);
      return;
    }

    const completed = shiftQueue(state.completedSpawnsByPath, agentPath);
    if (completed) {
      rememberAgentPrompt(state, agentThreadId, completed.prompt);
      return;
    }
    pushQueue(state.unpairedAgentsByPath, agentPath, agentThreadId);
    return;
  }

  if (!isSpawnCallOutputRow(row)) {
    return;
  }
  const pending = state.pendingSpawns.get(row.payload.call_id);
  if (!pending) {
    return;
  }
  state.pendingSpawns.delete(row.payload.call_id);
  const output = parseJson(row.payload.output);
  if (!isSpawnOutput(output)) {
    return;
  }
  const agentPath = output.task_name.trim();
  if (agentPath.length === 0) {
    return;
  }
  const agentThreadId = pending.agentThreadId ?? shiftQueue(state.unpairedAgentsByPath, agentPath);
  if (agentThreadId) {
    rememberAgentPrompt(state, agentThreadId, pending.prompt);
    return;
  }
  pushCompletedSpawn(state.completedSpawnsByPath, agentPath, pending);
}

function linksFromState(
  state: NativeCollabPromptParserState,
): ReadonlyArray<NativeCollabPromptLink> {
  return Array.from(state.promptByAgent, ([receiverThreadId, prompt]) => ({
    receiverThreadId,
    prompt,
  }));
}

const BOUNDARY_BYTES = 4096;

async function readBoundaryHash(filePath: string, offset: number): Promise<string> {
  if (offset === 0) {
    return NodeCrypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  }
  const start = Math.max(0, offset - BOUNDARY_BYTES);
  const buffer = Buffer.alloc(offset - start);
  const handle = await NodeFSP.open(filePath, "r");
  try {
    let readOffset = 0;
    while (readOffset < buffer.length) {
      const result = await handle.read(
        buffer,
        readOffset,
        buffer.length - readOffset,
        start + readOffset,
      );
      if (result.bytesRead === 0) {
        break;
      }
      readOffset += result.bytesRead;
    }
    return NodeCrypto.createHash("sha256").update(buffer.subarray(0, readOffset)).digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Incrementally scans an append-only Codex rollout without materializing it.
 * The cursor stops after the last complete newline, so a concurrently-written
 * final record is retried on the next scan instead of being discarded.
 */
export async function scanNativeCollabPromptRollout(
  filePath: string,
  previous?: NativeCollabPromptRolloutCursor,
): Promise<
  | {
      readonly cursor: NativeCollabPromptRolloutCursor;
      readonly links: ReadonlyArray<NativeCollabPromptLink>;
    }
  | undefined
> {
  try {
    const stats = await NodeFSP.stat(filePath);
    const sameFile =
      previous !== undefined &&
      previous.device === stats.dev &&
      previous.inode === stats.ino &&
      previous.birthtimeMs === stats.birthtimeMs;
    const canContinue =
      sameFile &&
      previous.offset <= stats.size &&
      previous.boundaryHash === (await readBoundaryHash(filePath, previous.offset));
    const startOffset = canContinue ? previous.offset : 0;
    const state = canContinue ? cloneParserState(previous.state) : makeParserState();
    if (startOffset === stats.size) {
      return {
        cursor: {
          offset: startOffset,
          device: stats.dev,
          inode: stats.ino,
          birthtimeMs: stats.birthtimeMs,
          boundaryHash: await readBoundaryHash(filePath, startOffset),
          state,
        },
        links: linksFromState(state),
      };
    }

    let bytesRead = 0;
    let trailing = Buffer.alloc(0);
    const stream = NodeFS.createReadStream(filePath, { start: startOffset });
    for await (const chunkValue of stream) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      bytesRead += chunk.length;
      const data = trailing.length === 0 ? chunk : Buffer.concat([trailing, chunk]);
      const lastNewline = data.lastIndexOf(10);
      if (lastNewline < 0) {
        trailing = data;
        continue;
      }
      const complete = data.subarray(0, lastNewline).toString("utf8");
      for (const rawLine of complete.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        reduceNativeCollabPromptRolloutLine(state, line);
      }
      trailing = data.subarray(lastNewline + 1);
    }

    const offset = startOffset + bytesRead - trailing.length;
    return {
      cursor: {
        offset,
        device: stats.dev,
        inode: stats.ino,
        birthtimeMs: stats.birthtimeMs,
        boundaryHash: await readBoundaryHash(filePath, offset),
        state,
      },
      links: linksFromState(state),
    };
  } catch {
    return undefined;
  }
}
