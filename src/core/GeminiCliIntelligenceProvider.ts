/**
 * GeminiCliIntelligenceProvider — IntelligenceProvider using the Gemini CLI.
 *
 * Sibling of ClaudeCliIntelligenceProvider + CodexCliIntelligenceProvider.
 * Routes judgment calls through the Gemini CLI's verified one-shot
 * (`gemini -m <model> --approval-mode default -p <prompt>`) for gemini-cli
 * installs. Same fast/balanced/capable tier mapping the Gemini adapter uses;
 * same timeout semantics; same fail-loudly behavior so callers can fall back.
 *
 * Apprenticeship Step 2 (keystone Face 1): this is the THIRD IntelligenceProvider
 * implementation and the ALIVE path for the gemini body. `server.ts` registers
 * no provider-registry adapters, so the registry adapter
 * (src/providers/adapters/gemini-cli/) is the parity-harness surface; THIS
 * class — constructed by `buildIntelligenceProvider({ framework: 'gemini-cli' })`
 * — is what reviewers, sentinels, reflect, and route actually call.
 *
 * It carries a thin parallel spawn (mirroring CodexCliIntelligenceProvider's
 * structure) but factors the security-critical pieces through the registry
 * adapter's single source of transport truth — the canonical argv builder
 * and the env allowlist + billing-var hard-delete live in
 * providers/adapters/gemini-cli/transport/geminiSpawn.ts, imported here so
 * the alive path and the registry adapter can never diverge on safety.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliModelFlag } from '../providers/adapters/gemini-cli/models.js';
import {
  buildGeminiChildEnv,
  buildGeminiOneShotArgv,
  spawnGeminiAndWait,
} from '../providers/adapters/gemini-cli/transport/geminiSpawn.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GeminiCliIntelligenceProviderOptions {
  /** Absolute path to the `gemini` CLI binary. */
  geminiPath: string;
  /**
   * Retained for API compatibility with the other providers' factories.
   * Gemini one-shot judgment calls don't depend on cwd content (the prompt
   * carries the full context), so this is currently unused — but the factory
   * forwards it, so it is accepted.
   */
  workingDirectory?: string;
  /** Optional override for the captured-output byte cap (per stream). */
  maxOutputBytes?: number;
}

export class GeminiCliIntelligenceProvider implements IntelligenceProvider {
  private readonly geminiPath: string;
  private readonly maxOutputBytes: number | undefined;

  constructor(options: GeminiCliIntelligenceProviderOptions) {
    this.geminiPath = options.geminiPath;
    this.maxOutputBytes = options.maxOutputBytes;
    // options.workingDirectory is intentionally not stored — one-shot judgment
    // calls carry their full context in the prompt and don't read cwd content.
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveCliModelFlag(options?.model);

    // CANONICAL argv — the only form this provider emits:
    //   gemini -m <model> --approval-mode default -p <prompt>
    // --approval-mode default is pinned (yolo/auto_edit never reachable here);
    // the prompt is exactly one argv element (the value of -p).
    const args = buildGeminiOneShotArgv(model, prompt);

    // Rule-1a analog: env allowlist + UNCONDITIONAL hard-delete of the
    // Google/Gemini billing vars (never inherit process.env wholesale).
    const childEnv = buildGeminiChildEnv();

    const result = await spawnGeminiAndWait(this.geminiPath, args, {
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: childEnv,
      ...(this.maxOutputBytes !== undefined ? { maxOutputBytes: this.maxOutputBytes } : {}),
    }).catch((err: Error & { stderr?: string }) => {
      // Generous stderr slice so the circuit breaker's rate-limit classifier
      // can see usage/limit language. Fail loudly so callers can fall back.
      const stderr = typeof err.stderr === 'string' ? err.stderr : '';
      throw new Error(
        `Gemini CLI error: ${err.message}` + (stderr ? ` — ${stderr.slice(0, 600)}` : ''),
      );
    });

    if (result.exitCode !== 0) {
      // The benign `Loaded cached credentials` stderr line only appears on a
      // SUCCESSFUL (exit 0) call; a non-zero exit means a real failure.
      throw new Error(
        `Gemini CLI exited ${result.exitCode}` +
          (result.stderr ? ` — ${result.stderr.slice(0, 600)}` : ''),
      );
    }

    return result.stdout.trim();
  }
}
