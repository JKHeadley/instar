/**
 * OneShotCompletion implementation for the openai-codex adapter.
 *
 * Spawns `codex exec PROMPT --skip-git-repo-check --ephemeral -s read-only
 * --output-last-message <tmpfile>` and reads the final agent message from
 * the file. Direct analog of `claude -p` for the headless Anthropic adapter.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError } from '../../../errors.js';
import type { OpenAiCodexConfig } from '../config.js';
import { OPENAI_CODEX_ID, mapExecError } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';
import { buildCodexChildEnv, spawnCodexAndWait } from './codexSpawn.js';

class OpenAiCodexOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const timeoutMs = options?.timeoutMs ?? this.config.defaultOneShotTimeoutMs ?? 60_000;
    const model = resolveCliModelFlag(options?.model ?? this.config.defaultModel);
    const sandbox = this.config.defaultSandboxMode ?? 'read-only';

    const outFile = path.join(tmpdir(), `codex-oneshot-${randomBytes(8).toString('hex')}.txt`);

    // NOTE: Codex CLI 0.130.0 + ChatGPT-account auth hangs silently with
    // `--ephemeral`; without it the call completes in ~5s. Probed
    // empirically 2026-05-15. The trade-off is that each one-shot call
    // leaves a session rollout under ~/.codex/sessions/. Cleanup is a
    // Phase 5 follow-up (we can prune sessions older than N days, or
    // re-introduce --ephemeral when Codex fixes the underlying bug).
    const args = [
      'exec',
      '--skip-git-repo-check',
      '-s',
      sandbox,
      '-m',
      model,
      '--output-last-message',
      outFile,
    ];

    if (options?.system) {
      args.push('-c', `instructions=${JSON.stringify(options.system)}`);
    }
    if (this.config.defaultProfile) {
      args.push('-p', this.config.defaultProfile);
    }

    args.push(prompt);

    // Rule 1a: env-scrubbing at exec time. See spec
    // specs/provider-portability/12-openai-path-constraints.md.
    const childEnv = buildCodexChildEnv({
      apiKey: this.config.apiKey,
      codexHome: this.config.codexHome,
    });

    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', OPENAI_CODEX_ID);
    }

    try {
      const result = await spawnCodexAndWait(this.config.codexPath, args, {
        timeoutMs,
        env: childEnv,
        signal: abortSignal,
      });
      if (result.exitCode !== 0) {
        throw mapExecError(
          new Error(`Codex exited ${result.exitCode}`) as Error & { code?: number },
          result.stderr,
        );
      }
      const text = await fs.readFile(outFile, 'utf-8').catch(() => '');
      return {
        text: text.trim(),
        usage: null,
        providerSpecific: { [OPENAI_CODEX_ID]: { model, sandbox } },
      };
    } catch (err) {
      const error = err as Error & { name: string };
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw new AbortError('Aborted during execution', OPENAI_CODEX_ID, err);
      }
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      throw mapExecError(
        error as unknown as Error & { code?: string | number; signal?: string; killed?: boolean; path?: string },
        stderr,
      );
    } finally {
      fs.unlink(outFile).catch(() => undefined);
    }
  }
}

export function createOneShotCompletion(config: OpenAiCodexConfig): OneShotCompletion {
  return new OpenAiCodexOneShotCompletion(config);
}
