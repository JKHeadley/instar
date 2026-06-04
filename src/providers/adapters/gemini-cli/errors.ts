/**
 * Adapter-specific error helpers for gemini-cli.
 *
 * Maps raw failures (gemini CLI non-zero exit, timeout/abort) to the
 * canonical ProviderError hierarchy. Mirrors openai-codex/errors.ts but
 * scoped to the minimal-body surface.
 */

import {
  AbortError,
  AuthError,
  NetworkError,
  QuotaError,
  RateLimitError,
  TimeoutError,
  UnexpectedError,
  type ProviderError,
} from '../../errors.js';
import type { ProviderId } from '../../types.js';
import { parseGeminiRetryAfterMs } from './observability/geminiCapacityPolicy.js';

export const GEMINI_CLI_ID = 'gemini-cli' as ProviderId;

/**
 * Map a raw spawn-style error from spawning `gemini` into a canonical
 * provider error. Stderr is inspected for auth / rate-limit / quota /
 * network signatures (the same classification shape codex uses) so the
 * circuit breaker's rate-limit classifier can see usage/limit language.
 */
export function mapExecError(
  err: Error & { code?: string | number; signal?: string; killed?: boolean; path?: string },
  stderr = '',
): ProviderError {
  if (err.name === 'AbortError') {
    return new AbortError('Gemini exec aborted', GEMINI_CLI_ID, err);
  }
  if (err.signal === 'SIGTERM' || err.killed) {
    return new TimeoutError(
      `gemini CLI killed: ${err.message}`,
      GEMINI_CLI_ID,
      0,
      { cause: err },
    );
  }
  if (err.code === 'ENOENT') {
    return new UnexpectedError(
      `gemini CLI binary not found: ${err.path ?? '(unknown)'}`,
      GEMINI_CLI_ID,
      err,
    );
  }
  const message = stderr ? stderr.slice(0, 500) : err.message;
  if (/unauthor|forbidden|invalid.*token|invalid.*key|401|403/i.test(stderr)) {
    return new AuthError(message, GEMINI_CLI_ID, err);
  }
  const retryAfterMs = parseGeminiRetryAfterMs(stderr);
  if (/rate.?limit|429|too many requests|resource.?exhausted/i.test(stderr)) {
    return new RateLimitError(message, GEMINI_CLI_ID, { retryAfterMs, cause: err });
  }
  if (/quota|usage.?limit/i.test(stderr)) {
    return new QuotaError(message, GEMINI_CLI_ID, { retryAfterMs, limitKind: 'unknown', cause: err });
  }
  if (/network|ECONN|ETIMEDOUT|dns/i.test(stderr)) {
    return new NetworkError(message, GEMINI_CLI_ID, err);
  }
  return new UnexpectedError(message, GEMINI_CLI_ID, err);
}
