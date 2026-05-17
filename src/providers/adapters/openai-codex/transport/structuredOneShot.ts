/**
 * StructuredOneShot implementation for the openai-codex adapter.
 *
 * Codex supports native structured output via `codex exec --output-schema
 * <file.json>` (per `codex exec --help`). The adapter writes the caller's
 * JSON schema to a temp file, passes it to the CLI for provider-side
 * enforcement, and still runs the caller's validator on the returned text
 * for consistency with adapters that lack provider-side enforcement.
 *
 * Retries on validation failure with a corrective follow-up prompt, up to
 * options.maxRetries times (default 1, matching the Anthropic adapter).
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  StructuredOneShot,
  StructuredOneShotOptions,
  StructuredOneShotResult,
  SchemaValidator,
} from '../../../primitives/transport/structuredOneShot.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError, UnexpectedError } from '../../../errors.js';
import type { OpenAiCodexConfig } from '../config.js';
import { OPENAI_CODEX_ID, mapExecError } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';
import { buildCodexChildEnv, spawnCodexAndWait } from './codexSpawn.js';

class OpenAiCodexStructuredOneShot implements StructuredOneShot {
  readonly capability = CapabilityFlag.StructuredOneShot;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async evaluate<T>(
    prompt: string,
    validate: SchemaValidator<T>,
    options?: StructuredOneShotOptions,
  ): Promise<StructuredOneShotResult<T>> {
    const timeoutMs = options?.timeoutMs ?? this.config.defaultOneShotTimeoutMs ?? 60_000;
    const model = resolveCliModelFlag(options?.model ?? this.config.defaultModel);
    const sandbox = this.config.defaultSandboxMode ?? 'read-only';
    const maxRetries = options?.maxRetries ?? 1;

    const runId = randomBytes(8).toString('hex');
    const outFile = path.join(tmpdir(), `codex-structured-${runId}.txt`);
    const schemaFile = options?.jsonSchema
      ? path.join(tmpdir(), `codex-schema-${runId}.json`)
      : null;

    if (schemaFile && options?.jsonSchema) {
      await fs.writeFile(schemaFile, JSON.stringify(options.jsonSchema), 'utf-8');
    }

    // Rule 1a: env-scrubbing at exec time. See spec
    // specs/provider-portability/12-openai-path-constraints.md.
    const childEnv = buildCodexChildEnv({
      apiKey: this.config.apiKey,
      codexHome: this.config.codexHome,
    });

    let attempts = 0;
    let lastError = '';
    let lastRaw = '';

    // See oneShotCompletion.ts for why --ephemeral is omitted (Codex CLI
    // 0.130.0 hang under ChatGPT-account auth).
    const baseArgs = [
      'exec',
      '--skip-git-repo-check',
      '-s',
      sandbox,
      '-m',
      model,
      '--output-last-message',
      outFile,
    ];
    if (schemaFile) baseArgs.push('--output-schema', schemaFile);
    if (options?.system) baseArgs.push('-c', `instructions=${JSON.stringify(options.system)}`);

    try {
      while (attempts <= maxRetries) {
        attempts++;
        const promptForAttempt = attempts === 1
          ? prompt
          : `${prompt}\n\nYour previous response failed schema validation:\n${lastError}\n\nRespond again with valid output.`;

        if (options?.signal?.aborted) {
          throw new AbortError('Aborted before attempt', OPENAI_CODEX_ID);
        }

        try {
          const result = await spawnCodexAndWait(
            this.config.codexPath,
            [...baseArgs, promptForAttempt],
            { timeoutMs, env: childEnv, signal: options?.signal },
          );
          if (result.exitCode !== 0) {
            throw mapExecError(
              new Error(`Codex exited ${result.exitCode}`) as Error & { code?: number },
              result.stderr,
            );
          }
        } catch (err) {
          const error = err as Error & { name: string };
          if (error.name === 'AbortError' || options?.signal?.aborted) {
            throw new AbortError('Aborted during execution', OPENAI_CODEX_ID, err);
          }
          const stderr = String((error as { stderr?: unknown }).stderr ?? '');
          throw mapExecError(
            error as unknown as Error & { code?: string | number; signal?: string; killed?: boolean; path?: string },
            stderr,
          );
        }

        const raw = (await fs.readFile(outFile, 'utf-8').catch(() => '')).trim();
        lastRaw = raw;
        const result = validate(raw);
        if (result.ok) {
          return {
            value: result.value,
            raw,
            attempts,
            usage: null,
            providerSpecific: { [OPENAI_CODEX_ID]: { model, sandbox, schemaEnforced: Boolean(schemaFile) } },
          };
        }
        lastError = result.error;
      }
      throw new UnexpectedError(
        `Schema validation failed after ${attempts} attempts: ${lastError}. Last raw response: ${lastRaw.slice(0, 200)}`,
        OPENAI_CODEX_ID,
      );
    } finally {
      fs.unlink(outFile).catch(() => undefined);
      if (schemaFile) fs.unlink(schemaFile).catch(() => undefined);
    }
  }
}

export function createStructuredOneShot(config: OpenAiCodexConfig): StructuredOneShot {
  return new OpenAiCodexStructuredOneShot(config);
}
