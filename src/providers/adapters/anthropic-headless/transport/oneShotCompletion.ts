/**
 * OneShotCompletion implementation for the anthropic-headless adapter.
 *
 * Spawns `claude -p PROMPT --model X --max-turns 1 --output-format text`
 * and returns the captured stdout. Mirrors the existing
 * ClaudeCliIntelligenceProvider in src/core/ — Phase 3 refactor will
 * collapse the two paths once the adapter is wired into the rest of
 * Instar's source.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID, mapExecError } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';

const execFileAsync = promisify(execFile);

class AnthropicHeadlessOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const model = resolveCliModelFlag(options?.model ?? this.config.defaultModel ?? 'balanced');
    const timeoutMs = options?.timeoutMs ?? this.config.defaultOneShotTimeoutMs ?? 30_000;

    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--max-turns',
      '1',
      '--output-format',
      'text',
      // Exclude project/local CLAUDE.md to keep judgment calls clean.
      '--setting-sources',
      'user',
    ];

    if (options?.maxTokens !== undefined) {
      // Claude CLI doesn't accept max-tokens as a flag; the prompt or
      // system message controls length. Document and skip.
    }

    // Strip Claude-Code nested-session markers from child env so claude
    // doesn't refuse to run.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv['CLAUDECODE'];
    delete childEnv['CLAUDE_SESSION_ID'];

    // Inject auth credential if configured
    if (this.config.credential) {
      if (this.config.credential.startsWith('sk-ant-oat')) {
        childEnv['CLAUDE_CODE_OAUTH_TOKEN'] = this.config.credential;
        delete childEnv['ANTHROPIC_API_KEY'];
      } else {
        childEnv['ANTHROPIC_API_KEY'] = this.config.credential;
        delete childEnv['CLAUDE_CODE_OAUTH_TOKEN'];
      }
    }
    if (this.config.apiBaseUrl) {
      childEnv['ANTHROPIC_BASE_URL'] = this.config.apiBaseUrl;
    }
    if (this.config.configDir) {
      childEnv['CLAUDE_CONFIG_DIR'] = this.config.configDir;
    }

    // Set up abort signal wiring
    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', ANTHROPIC_HEADLESS_ID);
    }

    try {
      const { stdout } = await execFileAsync(this.config.claudePath, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1 MB
        env: childEnv,
        signal: abortSignal,
      });
      return {
        text: stdout.trim(),
        usage: null,
        providerSpecific: { [ANTHROPIC_HEADLESS_ID]: { model } },
      };
    } catch (err) {
      const error = err as ExecFileException;
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw new AbortError('Aborted during execution', ANTHROPIC_HEADLESS_ID, err);
      }
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      throw mapExecError(error as unknown as Error & { code?: string | number; signal?: string; killed?: boolean; path?: string }, stderr);
    }
  }
}

export function createOneShotCompletion(
  config: AnthropicHeadlessConfig,
): OneShotCompletion {
  return new AnthropicHeadlessOneShotCompletion(config);
}
