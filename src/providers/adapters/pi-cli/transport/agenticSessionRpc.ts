/**
 * pi-cli AgenticSessionRpc — the "data cable" primitive
 * (PI-HARNESS-INTEGRATION-SPEC §4.1-4.2).
 *
 * pi's RPC mode is a NATIVE structured-control channel (stdio JSONL with
 * prompt / mid-stream steer / abort), so this is a direct mapping rather
 * than a facade: start() spawns `pi --mode rpc`, startTurn() sends `prompt`,
 * steerTurn() sends `steer`, interruptTurn() sends `abort`, close() ends
 * the process. pi events normalize to the canonical vocabulary:
 *
 *   message_update(text_delta)      → message-delta
 *   tool_execution_start            → tool-call
 *   tool_execution_end              → tool-result
 *   turn_end                        → turn-end (usage from message.usage)
 *   agent_start / agent_end / rest  → provider-raw (pi run boundaries)
 *
 * The subscription guard (policy.ts) runs at start(): an Anthropic-routed
 * model pattern throws PiAnthropicRouteError before any process spawns.
 *
 * Protocol facts verified hands-on in the P0.1 eval (pi 0.78.1):
 * docs/specs/_drafts/pi-eval-report.md.
 */

import { randomUUID } from 'node:crypto';
import type { CanonicalEvent } from '../../../events.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { sessionHandle, type SessionHandle } from '../../../types.js';
import type {
  AgenticSessionRpc,
  AgenticSessionRpcHandle,
  AgenticSessionRpcOptions,
  TurnRequest,
} from '../../../primitives/transport/agenticSessionRpc.js';
import type { CancellationOptions, UsageReport } from '../../../types.js';
import { PI_CLI_ID } from '../errors.js';
import { UnexpectedError } from '../../../errors.js';
import type { PiCliConfig } from '../config.js';
import { assertPiProviderAllowed } from '../policy.js';
import { PiRpcClient, type PiRpcEvent } from './rpcClient.js';

interface LiveSession {
  client: PiRpcClient;
  turnCounter: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Normalize one pi event line to a CanonicalEvent (always returns one). */
export function normalizePiEvent(event: PiRpcEvent, session: SessionHandle): CanonicalEvent {
  const base = { timestamp: nowIso(), providerId: PI_CLI_ID, session } as const;
  switch (event.type) {
    case 'message_update': {
      const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
      if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
        return { ...base, type: 'message-delta', delta: inner.delta };
      }
      return { ...base, type: 'provider-raw', nativeName: `message_update.${inner?.type ?? 'unknown'}`, payload: event };
    }
    case 'tool_execution_start': {
      const e = event as { id?: string; toolCallId?: string; toolName?: string; args?: unknown; arguments?: unknown };
      return {
        ...base,
        type: 'tool-call',
        toolCallId: String(e.toolCallId ?? e.id ?? 'unknown'),
        toolName: String(e.toolName ?? 'unknown'),
        arguments: e.args ?? e.arguments ?? null,
      };
    }
    case 'tool_execution_end': {
      const e = event as { id?: string; toolCallId?: string; result?: unknown; isError?: boolean };
      return {
        ...base,
        type: 'tool-result',
        toolCallId: String(e.toolCallId ?? e.id ?? 'unknown'),
        result: e.result ?? null,
        isError: e.isError === true,
      };
    }
    case 'turn_end': {
      const message = (event as { message?: { stopReason?: string; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message;
      const stop = message?.stopReason;
      const stopReason =
        stop === 'stop' ? 'end-of-turn'
        : stop === 'toolUse' || stop === 'tool_calls' || stop === 'tool_use' ? 'tool-use'
        : stop === 'maxTokens' || stop === 'max_tokens' ? 'max-tokens'
        : stop === 'aborted' || stop === 'interrupted' ? 'interrupted'
        : 'unknown';
      const usage: UsageReport | null = message?.usage
        ? {
            inputTokens: message.usage.input ?? 0,
            outputTokens: message.usage.output ?? 0,
            ...(message.usage.cacheRead !== undefined ? { cachedTokens: message.usage.cacheRead } : {}),
            ...(message.usage.cost?.total !== undefined ? { estimatedCostUsd: message.usage.cost.total } : {}),
          }
        : null;
      return { ...base, type: 'turn-end', stopReason, usage };
    }
    case 'error': {
      const e = event as { message?: string; error?: string };
      return {
        ...base,
        type: 'error',
        message: String(e.message ?? e.error ?? 'pi error event'),
        recoverable: true,
        errorKind: 'unknown',
      };
    }
    default:
      return { ...base, type: 'provider-raw', nativeName: String(event.type), payload: event };
  }
}

/**
 * Build the AgenticSessionRpc primitive for the pi adapter.
 */
export function createPiAgenticSessionRpc(config: PiCliConfig): AgenticSessionRpc {
  const sessions = new Map<string, LiveSession>();

  function requireSession(handle: SessionHandle): LiveSession {
    const live = sessions.get(String(handle));
    if (!live) {
      throw new UnexpectedError(`Unknown pi RPC session handle: ${String(handle)}`, PI_CLI_ID);
    }
    return live;
  }

  return {
    capability: CapabilityFlag.AgenticSessionRpc,

    async start(options: AgenticSessionRpcOptions): Promise<AgenticSessionRpcHandle> {
      if (options.transport !== 'stdio') {
        throw new UnexpectedError(`pi RPC supports only stdio transport (got "${options.transport}")`, PI_CLI_ID);
      }
      // STRUCTURAL SUBSCRIPTION GUARD (spec §4.3): refuse Anthropic-routed
      // models BEFORE any process exists. ModelTier values resolve to the
      // adapter's configured pattern — the pattern is what gets judged.
      const model = config.model;
      assertPiProviderAllowed(model, {
        ...(config.allowAnthropicProviders !== undefined
          ? { allowAnthropicProviders: config.allowAnthropicProviders }
          : {}),
      });

      const id = randomUUID();
      const client = PiRpcClient.spawn({
        binaryPath: config.piPath,
        ...(model ? { model } : {}),
        ...(config.sessionDir ? { sessionDir: config.sessionDir } : { noSession: true }),
        ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
      });
      client.assertSpawned();
      const handle = sessionHandle(`pi-rpc:${id}`);
      const live: LiveSession = { client, turnCounter: 0 };
      sessions.set(String(handle), live);

      const events: AsyncIterable<CanonicalEvent> = (async function* () {
        yield {
          type: 'session-lifecycle',
          lifecycleKind: 'started',
          timestamp: nowIso(),
          providerId: PI_CLI_ID,
          session: handle,
        } as CanonicalEvent;
        for await (const event of client.events()) {
          yield normalizePiEvent(event, handle);
        }
        yield {
          type: 'session-lifecycle',
          lifecycleKind: 'ended',
          timestamp: nowIso(),
          providerId: PI_CLI_ID,
          session: handle,
        } as CanonicalEvent;
      })();

      return {
        handle,
        events,
        // pi's RPC is a narrow agent-control channel; there is no codex-style
        // fs/command/plugin control plane behind it.
        hasControlPlane: false,
      };
    },

    async startTurn(
      handle: SessionHandle,
      turn: TurnRequest,
      _options?: CancellationOptions,
    ): Promise<{ turnId: string }> {
      const live = requireSession(handle);
      live.turnCounter += 1;
      const turnId = `turn-${live.turnCounter}`;
      const response = await live.client.prompt(turn.prompt);
      if (!response.success) {
        throw new UnexpectedError(`pi prompt rejected: ${response.error ?? 'unknown error'}`, PI_CLI_ID);
      }
      return { turnId };
    },

    async steerTurn(
      handle: SessionHandle,
      _turnId: string,
      input: string,
      _options?: CancellationOptions,
    ): Promise<void> {
      const live = requireSession(handle);
      const response = await live.client.steer(input);
      if (!response.success) {
        throw new UnexpectedError(`pi steer rejected: ${response.error ?? 'unknown error'}`, PI_CLI_ID);
      }
    },

    async interruptTurn(
      handle: SessionHandle,
      _turnId: string,
      _options?: CancellationOptions,
    ): Promise<void> {
      const live = requireSession(handle);
      const response = await live.client.abort();
      if (!response.success) {
        throw new UnexpectedError(`pi abort rejected: ${response.error ?? 'unknown error'}`, PI_CLI_ID);
      }
    },

    async close(handle: SessionHandle, _options?: CancellationOptions): Promise<void> {
      const live = sessions.get(String(handle));
      if (!live) return; // idempotent close
      sessions.delete(String(handle));
      await live.client.close();
    },
  };
}
