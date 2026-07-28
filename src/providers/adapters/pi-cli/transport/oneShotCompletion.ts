/**
 * OneShotCompletion implementation for the pi-cli adapter.
 *
 * Spawns the CANONICAL one-shot argv (buildPiOneShotArgv):
 *   pi -p --mode json --no-session --offline [--model <pattern>] <prompt>
 * and parses pi's typed JSONL event stream from stdout, extracting the
 * completion text + usage from the assistant's `message_end` event.
 *
 * The argv and the event-stream shape (`message_end` with
 * `message.role==='assistant'`, `message.content[]` text entries,
 * `message.usage`) were verified HANDS-ON in the P0.1 eval (pi 0.78.1,
 * docs/specs/_drafts/pi-eval-report.md) — ground truth, not inferred.
 *
 * SAFETY (pinned at the call site):
 *   - `--no-session` / `--offline` are part of the canonical argv; this
 *     primitive never writes a session file or fetches binaries.
 *   - The env unconditionally hard-deletes every billing-capable provider var
 *     (buildPiChildEnv) — the no-API-keys rule.
 *   - Output is byte-capped (spawnPiAndWait).
 *
 * Model/tier resolution is PASS-THROUGH for pi: a pi `provider/id` pattern
 * comes from `config.model` (or the per-call `options.model`). The abstract
 * ModelTier vocabulary (`fast`/`balanced`/`capable`) does NOT map to fixed pi
 * model names — tier vocabulary lives INSIDE the configured provider for pi.
 * So a ModelTier resolves to `config.model ?? undefined`, and when undefined
 * pi's own default model applies. (The §4.3 subscription guard — policy.ts —
 * is the gate that refuses Anthropic-routed patterns; it is not invoked from
 * this file.)
 */

import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import type { ModelTier, UsageReport } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError, UnexpectedError } from '../../../errors.js';
import type { PiCliConfig } from '../config.js';
import { PI_CLI_ID, mapExecError } from '../errors.js';
import { assertPiProviderAllowed } from '../policy.js';
import {
  buildPiChildEnv,
  buildPiOneShotArgv,
  spawnPiAndWait,
} from './piSpawn.js';

/** The abstract tiers — pass-through for pi (tier lives in the provider). */
const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>(['fast', 'balanced', 'capable']);

/**
 * Resolve a per-call model selector to a concrete pi `--model` pattern.
 *
 * - A concrete pattern (a `provider/id` string or bare id) passes through.
 * - An abstract ModelTier resolves to `config.model` (pi tiers live in the
 *   configured provider, not in a fixed name map) — and to `undefined` when no
 *   config.model is set, in which case pi's own default model applies.
 */
function resolvePiModel(
  selector: string | ModelTier | undefined,
  configModel: string | undefined,
): string | undefined {
  if (selector && !MODEL_TIERS.has(selector)) {
    return selector;
  }
  return configModel;
}

interface PiTextContent {
  type?: string;
  text?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: { total?: number };
}

interface PiMessage {
  role?: string;
  content?: PiTextContent[];
  usage?: PiUsage;
}

interface PiEvent {
  type?: string;
  message?: PiMessage;
}

/**
 * Parse pi's JSONL event stream and return the LAST assistant `message_end`
 * event, or null if none is present. Non-JSON / malformed lines are skipped
 * (pi may interleave a benign non-JSON banner line on stdout).
 */
function lastAssistantMessageEnd(stdout: string): PiMessage | null {
  let found: PiMessage | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: PiEvent;
    try {
      event = JSON.parse(trimmed) as PiEvent;
    } catch {
      continue;
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      found = event.message;
    }
  }
  return found;
}

/** Concatenate the `text` of every `type==='text'` content entry. */
function textFromContent(content: PiTextContent[] | undefined): string {
  if (!content) return '';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/** Map pi's `message.usage` onto the canonical UsageReport, or null. */
function usageFromMessage(usage: PiUsage | undefined): UsageReport | null {
  if (!usage) return null;
  const report: UsageReport = {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
  };
  if (usage.cacheRead !== undefined) report.cachedTokens = usage.cacheRead;
  if (usage.cost?.total !== undefined) report.estimatedCostUsd = usage.cost.total;
  return report;
}

class PiCliOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: PiCliConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs ?? 60_000;
    const model = resolvePiModel(options?.model, this.config.model);

    // STRUCTURAL SUBSCRIPTION GUARD (PI-HARNESS-INTEGRATION-SPEC §4.3):
    // refuse Anthropic-routed model patterns BEFORE any process spawns —
    // every pi call-construction path enforces this, not just the RPC face.
    assertPiProviderAllowed(model, {
      ...(this.config.allowAnthropicProviders !== undefined
        ? { allowAnthropicProviders: this.config.allowAnthropicProviders }
        : {}),
    });

    // System prompt is prepended to the user prompt (pi's one-shot `-p` takes a
    // single prompt; there's no separate system flag on this path).
    const effectivePrompt = options?.system
      ? `${options.system}\n\n${prompt}`
      : prompt;

    const childEnv = buildPiChildEnv();

    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', PI_CLI_ID);
    }

    try {
      const args = buildPiOneShotArgv(model, effectivePrompt);
      const result = await spawnPiAndWait(this.config.piPath, args, {
        timeoutMs,
        env: childEnv,
        ...(abortSignal ? { signal: abortSignal } : {}),
        ...(this.config.maxOutputBytes !== undefined
          ? { maxOutputBytes: this.config.maxOutputBytes }
          : {}),
      });

      if (result.exitCode !== 0) {
        throw mapExecError(
          new Error(`Pi exited ${result.exitCode}`) as Error & { code?: number },
          result.stderr,
        );
      }

      const message = lastAssistantMessageEnd(result.stdout);
      if (!message) {
        throw new UnexpectedError(
          `pi produced no assistant message_end event` +
            (result.stderr ? `: ${result.stderr.slice(0, 500)}` : ''),
          PI_CLI_ID,
        );
      }

      return {
        text: textFromContent(message.content).trim(),
        usage: usageFromMessage(message.usage),
        providerSpecific: {
          [PI_CLI_ID]: { model: model ?? null, truncated: result.truncated },
        },
      };
    } catch (err) {
      if (err instanceof UnexpectedError) throw err;
      const error = err as Error & { name: string };
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw new AbortError('Aborted during execution', PI_CLI_ID, err);
      }
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      throw mapExecError(
        error as unknown as Error & {
          code?: string | number;
          signal?: string;
          killed?: boolean;
          path?: string;
        },
        stderr,
      );
    }
  }
}

export function createOneShotCompletion(config: PiCliConfig): OneShotCompletion {
  return new PiCliOneShotCompletion(config);
}
