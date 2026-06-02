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
import { AbortError } from '../../../errors.js';
import type { GeminiCliConfig } from '../config.js';
import { GEMINI_CLI_ID, mapExecError } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';
import {
  buildGeminiChildEnv,
  buildGeminiOneShotArgv,
  spawnGeminiAndWait,
} from './geminiSpawn.js';

class GeminiCliOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: GeminiCliConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const timeoutMs = options?.timeoutMs ?? this.config.defaultOneShotTimeoutMs ?? 60_000;
    const model = resolveCliModelFlag(options?.model ?? this.config.defaultModel);

    // System prompt is prepended to the user prompt (Gemini's one-shot `-p`
    // takes a single string; there's no separate system flag on this path).
    const effectivePrompt = options?.system
      ? `${options.system}\n\n${prompt}`
      : prompt;

    // CANONICAL argv — the only form this primitive ever emits.
    // --approval-mode default is pinned here; the prompt is exactly one slot.
    const args = buildGeminiOneShotArgv(model, effectivePrompt);

    const childEnv = buildGeminiChildEnv();

    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', GEMINI_CLI_ID);
    }

    try {
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
        throw mapExecError(
          new Error(`Gemini exited ${result.exitCode}`) as Error & { code?: number },
          result.stderr,
        );
      }
      return {
        text: result.stdout.trim(),
        usage: null,
        providerSpecific: {
          [GEMINI_CLI_ID]: { model, approvalMode: 'default', truncated: result.truncated },
        },
      };
    } catch (err) {
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
