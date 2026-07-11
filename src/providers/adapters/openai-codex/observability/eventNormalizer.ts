/**
 * Codex JSONL event normalizer.
 *
 * Codex `--json` emits a stream of JSONL events with these shapes (per
 * the deep-dive in specs/provider-portability/02-codex-deep-dive.md §C
 * and empirical probing 2026-05-15):
 *
 *   {"type":"thread.started","thread_id":"<uuid-v7>"}
 *   {"type":"turn.started"}
 *   {"type":"turn.completed","usage":{...}}
 *   {"type":"turn.failed","error":{"message":"..."}}
 *   {"type":"item.started","item":{...}}
 *   {"type":"item.completed","item":{...}}
 *   {"type":"item.agentMessage.delta","delta":"..."}
 *   {"type":"item.commandExecution.requestApproval","item":{...}}
 *   {"type":"item.commandExecution.outputDelta","delta":"..."}
 *   {"type":"error","message":"..."}
 *
 * RULE 3.1 RATIONALE
 *   Criticality: critical (silent corruption if a new Codex event type isn't recognized)
 *   Frequency:   per-event (per-prompt during a session)
 *   Stability:   unstable — Codex CLI changes event vocabulary across versions
 *   Fallback:    emit ProviderRawEvent for unrecognized types, never drop silently
 *   Verdict:     deterministic JSON parse + canary (canary lives at canary/codexEventNormalizerCanary.ts)
 *
 * Drift risk: high — every Codex CLI minor version may add new event types
 * or change existing payload shapes. The canary verifies the recognized
 * vocabulary by issuing a known-shape prompt and asserting the expected
 * event sequence appears.
 */

import type { CanonicalEvent } from '../../../events.js';
import type { UsageReport } from '../../../types.js';
import { OPENAI_CODEX_ID } from '../errors.js';

/**
 * Parse a single line of Codex `--json` output and return a CanonicalEvent.
 * Returns `null` when the line is not a recognizable JSON object (e.g.,
 * blank lines, status bar fragments, ANSI noise from tmux capture).
 *
 * Unknown event types are emitted as `ProviderRawEvent` so the consumer
 * sees them but with explicit "this isn't a canonical event" framing.
 */
export function normalizeCodexJsonlEvent(line: string): CanonicalEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = String(parsed['type'] ?? '');
  const timestamp = new Date().toISOString();
  const base = { timestamp, providerId: OPENAI_CODEX_ID } as const;

  switch (type) {
    case 'thread.started': {
      return {
        ...base,
        type: 'session-lifecycle',
        lifecycleKind: 'started',
        providerSpecific: { [OPENAI_CODEX_ID]: { threadId: parsed['thread_id'] } },
      } as CanonicalEvent;
    }

    case 'turn.started': {
      return null;
    }

    case 'turn.completed': {
      const usage = parsed['usage'] as Record<string, unknown> | undefined;
      const usageReport: UsageReport | null = usage
        ? {
            inputTokens: Number(usage['input_tokens'] ?? 0),
            outputTokens: Number(usage['output_tokens'] ?? 0),
            cachedTokens: usage['cached_input_tokens'] != null ? Number(usage['cached_input_tokens']) : undefined,
            reasoningTokens: usage['reasoning_tokens'] != null ? Number(usage['reasoning_tokens']) : undefined,
          }
        : null;
      return {
        ...base,
        type: 'turn-end',
        stopReason: 'end-of-turn',
        usage: usageReport,
      };
    }

    case 'turn.failed': {
      const err = parsed['error'] as Record<string, unknown> | undefined;
      const message = String(err?.['message'] ?? 'turn failed');
      return {
        ...base,
        type: 'error',
        message,
        recoverable: false,
        errorKind: classifyCodexErrorMessage(message),
      };
    }

    case 'error': {
      const message = String(parsed['message'] ?? 'codex error');
      return {
        ...base,
        type: 'error',
        message,
        recoverable: true,
        errorKind: classifyCodexErrorMessage(message),
      };
    }

    case 'item.agentMessage.delta': {
      const delta = String(parsed['delta'] ?? '');
      if (!delta) return null;
      return { ...base, type: 'message-delta', delta };
    }

    case 'item.commandExecution.requestApproval': {
      const item = parsed['item'] as Record<string, unknown> | undefined;
      const command = String(item?.['command'] ?? '');
      return {
        ...base,
        type: 'interactive-prompt',
        promptKind: 'permission',
        summary: command ? `Approve command: ${command.slice(0, 200)}` : 'Approve command',
        source: 'structured',
      };
    }

    case 'item.commandExecution.started':
    case 'item.commandExecution.completed':
    case 'item.commandExecution.outputDelta': {
      const item = parsed['item'] as Record<string, unknown> | undefined;
      const command = String(item?.['command'] ?? parsed['delta'] ?? '');
      const toolCallId = String(item?.['id'] ?? '');
      if (type === 'item.commandExecution.completed') {
        return {
          ...base,
          type: 'tool-result',
          toolCallId,
          result: item?.['output'] ?? '',
          isError: Boolean(item?.['is_error']),
        };
      }
      if (type === 'item.commandExecution.started') {
        return {
          ...base,
          type: 'tool-call',
          toolCallId,
          toolName: 'bash',
          arguments: { command },
        };
      }
      // outputDelta — fold into provider-raw, callers wanting incremental
      // tool stdout subscribe via LiveOutputStream primitive instead.
      return null;
    }

    case 'item.started':
    case 'item.completed': {
      const item = parsed['item'] as Record<string, unknown> | undefined;
      const itemType = String(item?.['type'] ?? '');
      if (itemType === 'agent_message' && type === 'item.completed') {
        return null; // captured as deltas already
      }
      return {
        ...base,
        type: 'provider-raw',
        nativeName: type,
        payload: parsed,
      };
    }

    default: {
      // Unknown event — surface as provider-raw so we don't lose it silently.
      return {
        ...base,
        type: 'provider-raw',
        nativeName: type || 'unknown',
        payload: parsed,
      };
    }
  }
}

export function classifyCodexErrorMessage(message: string): 'auth' | 'quota' | 'rate-limit' | 'timeout' | 'network' | 'malformed-response' | 'unsupported' | 'unknown' {
  // This is Codex's specific ChatGPT-account model-retirement response. Keep
  // it ahead of generic auth classification: callers may safely retry this
  // one condition with a known-good model, but must surface every neighboring
  // 400/auth/rate-limit/network failure unchanged.
  if (/The '[^']+' model is not supported when using Codex with a ChatGPT account\.?/i.test(message)) return 'unsupported';
  if (/unauthorized|forbidden|401|403|invalid.*token/i.test(message)) return 'auth';
  if (/quota|insufficient_quota/i.test(message)) return 'quota';
  if (/rate.?limit|429/i.test(message)) return 'rate-limit';
  if (/timeout|408|504/i.test(message)) return 'timeout';
  if (/network|ECONN|ETIMEDOUT|dns/i.test(message)) return 'network';
  if (/malformed|parse|invalid JSON/i.test(message)) return 'malformed-response';
  return 'unknown';
}

/**
 * The set of Codex event-type strings this normalizer currently recognizes.
 * The canary uses this set to assert the recognized vocabulary hasn't
 * shrunk silently across Codex CLI upgrades.
 */
export const RECOGNIZED_CODEX_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'error',
  'item.agentMessage.delta',
  'item.started',
  'item.completed',
  'item.commandExecution.started',
  'item.commandExecution.completed',
  'item.commandExecution.outputDelta',
  'item.commandExecution.requestApproval',
]);
