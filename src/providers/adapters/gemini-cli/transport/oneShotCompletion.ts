/**
 * OneShotCompletion implementation for the gemini-cli adapter.
 *
 * Spawns the CANONICAL one-shot argv:
 *   gemini -m <model> --approval-mode default -p <prompt>
 * and reads the trimmed final message from stdout. Unlike Codex's
 * `--output-last-message <file>` indirection, the verified Gemini one-shot
 * writes the final message to stdout directly (clean stdout, exit 0), so
 * this is simpler than Codex's tmpfile dance.
 *
 * SAFETY (pinned at the call site):
 *   - `--approval-mode default` is part of the canonical argv (buildGeminiOneShotArgv).
 *     `yolo`/`auto_edit`/`-y` are NEVER reachable from this primitive.
 *   - The env unconditionally hard-deletes the Google/Gemini billing vars.
 *   - Output is byte-capped (spawnGeminiAndWait) — improving on codex's
 *     unbounded Buffer.concat.
 */

import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError, QuotaError } from '../../../errors.js';
import type { GeminiCliConfig } from '../config.js';
import { GEMINI_CLI_ID, mapExecError } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';
import {
  decideGeminiCapacityPolicy,
  getGeminiCapacityGate,
  recordGeminiCapacityDeferral,
} from '../observability/geminiCapacityPolicy.js';
import {
  buildGeminiChildEnv,
  buildGeminiOneShotArgv,
  spawnGeminiAndWait,
} from './geminiSpawn.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class GeminiCliOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: GeminiCliConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const timeoutMs = options?.timeoutMs ?? this.config.defaultOneShotTimeoutMs ?? 60_000;
    const model = resolveCliModelFlag(options?.model ?? this.config.defaultModel);
    let currentModel = model;
    const gate = getGeminiCapacityGate();
    if (!gate.allow) {
      throw new QuotaError(
        `Gemini capacity deferred until ${new Date(gate.deferredUntil ?? Date.now()).toISOString()}` +
          (gate.reason ? `: ${gate.reason}` : ''),
        GEMINI_CLI_ID,
        { retryAfterMs: gate.retryAfterMs, limitKind: 'unknown' },
      );
    }

    // System prompt is prepended to the user prompt (Gemini's one-shot `-p`
    // takes a single string; there's no separate system flag on this path).
    const effectivePrompt = options?.system
      ? `${options.system}\n\n${prompt}`
      : prompt;

    const childEnv = buildGeminiChildEnv();

    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', GEMINI_CLI_ID);
    }

    try {
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
      const args = buildGeminiOneShotArgv(currentModel, effectivePrompt);
      const result = await spawnGeminiAndWait(this.config.geminiPath, args, {
        timeoutMs,
        env: childEnv,
        ...(abortSignal ? { signal: abortSignal } : {}),
        ...(this.config.maxOutputBytes !== undefined
          ? { maxOutputBytes: this.config.maxOutputBytes }
          : {}),
      });
      if (result.exitCode !== 0) {
        // Benign `Loaded cached credentials` stderr line is NOT a failure when
        // exit is 0; here exit is non-zero so surface the stderr.
        const mapped = mapExecError(
          new Error(`Gemini exited ${result.exitCode}`) as Error & { code?: number },
          result.stderr,
        );
        const capacity = decideGeminiCapacityPolicy({
          errorMessage: `${mapped.message}\n${result.stderr}`,
          attempt,
          model: currentModel,
          config: this.config.capacityPolicy,
        });
        if (capacity.action === 'retry' && capacity.retryAfterMs !== undefined) {
          currentModel = capacity.model;
          attempt += 1;
          await sleep(capacity.retryAfterMs);
          continue;
        }
        if (capacity.action === 'defer' && capacity.retryAfterMs !== undefined) {
          recordGeminiCapacityDeferral({
            retryAfterMs: capacity.retryAfterMs,
            reason: capacity.reason ?? mapped.message,
          });
          throw new QuotaError(
            `${capacity.reason}: ${mapped.message}`,
            GEMINI_CLI_ID,
            { retryAfterMs: capacity.retryAfterMs, limitKind: 'unknown', cause: mapped },
          );
        }
        throw mapped;
      }
      return {
        text: result.stdout.trim(),
        usage: null,
        providerSpecific: {
          [GEMINI_CLI_ID]: { model, approvalMode: 'default', truncated: result.truncated },
        },
      };
      }
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      const error = err as Error & { name: string };
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw new AbortError('Aborted during execution', GEMINI_CLI_ID, err);
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

export function createOneShotCompletion(config: GeminiCliConfig): OneShotCompletion {
  return new GeminiCliOneShotCompletion(config);
}
