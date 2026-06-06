/**
 * Adapter-specific error helpers for pi-cli.
 *
 * Maps raw failures (pi CLI non-zero exit, timeout/abort) to the canonical
 * ProviderError hierarchy. Mirrors gemini-cli/errors.ts 1:1 but scoped to pi,
 * plus the one pi-specific error class the subscription guard needs
 * (`PiAnthropicRouteError`, PI-HARNESS-INTEGRATION-SPEC §4.3 — thrown by
 * policy.ts, NOT this file).
 */

import {
  AbortError,
  AuthError,
  NetworkError,
  ProviderError,
  QuotaError,
  RateLimitError,
  TimeoutError,
  UnexpectedError,
} from '../../errors.js';
import { providerId, type ProviderId } from '../../types.js';

/** Stable provider id for the pi coding agent adapter. */
export const PI_CLI_ID: ProviderId = providerId('pi-cli');

/**
 * The subscription-guard error (PI-HARNESS-INTEGRATION-SPEC §4.3).
 *
 * Thrown by `policy.ts` (`assertPiProviderAllowed`) — NOT by this file's
 * `mapExecError` — when a pi call is constructed against an Anthropic/Claude
 * provider without the explicit `piCli.allowAnthropicProviders` override.
 * Routing Claude work through pi bills as per-token EXTRA USAGE rather than
 * counting against plan limits, so the default is structural DENY. It lives
 * in the error hierarchy (an `AuthError` subclass — a credential/route
 * authorization refusal, distinct from a quota/rate failure) so callers that
 * already branch on `AuthError` surface it uniformly.
 */
export class PiAnthropicRouteError extends AuthError {
  /** The offending `--model` pattern (a `provider/id` string or bare id). */
  readonly modelPattern?: string;

  constructor(modelPattern?: string) {
    super(
      `pi-cli refuses to route to an Anthropic/Claude provider` +
        (modelPattern ? ` (model=${modelPattern})` : '') +
        `: third-party-harness usage bills as Anthropic EXTRA USAGE (per-token), ` +
        `not plan limits — use claude-code instead, or set ` +
        `piCli.allowAnthropicProviders=true to opt in.`,
      PI_CLI_ID,
    );
    this.name = 'PiAnthropicRouteError';
    this.modelPattern = modelPattern;
    Object.setPrototypeOf(this, PiAnthropicRouteError.prototype);
  }
}

/**
 * Map a raw spawn-style error from spawning `pi` into a canonical provider
 * error. Stderr is inspected for auth / rate-limit / quota / network
 * signatures (the same classification shape gemini/codex use) so the circuit
 * breaker's rate-limit classifier can see usage/limit language.
 */
export function mapExecError(
  err: Error & { code?: string | number; signal?: string; killed?: boolean; path?: string },
  stderr = '',
): ProviderError {
  if (err.name === 'AbortError') {
    return new AbortError('Pi exec aborted', PI_CLI_ID, err);
  }
  if (err.signal === 'SIGTERM' || err.killed) {
    return new TimeoutError(
      `pi CLI killed: ${err.message}`,
      PI_CLI_ID,
      0,
      { cause: err },
    );
  }
  if (err.code === 'ENOENT') {
    return new UnexpectedError(
      `pi CLI binary not found: ${err.path ?? '(unknown)'}`,
      PI_CLI_ID,
      err,
    );
  }
  const message = stderr ? stderr.slice(0, 500) : err.message;
  if (/unauthor|forbidden|invalid.*token|invalid.*key|401|403/i.test(stderr)) {
    return new AuthError(message, PI_CLI_ID, err);
  }
  if (/rate.?limit|429|too many requests|resource.?exhausted/i.test(stderr)) {
    return new RateLimitError(message, PI_CLI_ID, { cause: err });
  }
  if (/quota|usage.?limit/i.test(stderr)) {
    return new QuotaError(message, PI_CLI_ID, { limitKind: 'unknown', cause: err });
  }
  if (/network|ECONN|ETIMEDOUT|dns/i.test(stderr)) {
    return new NetworkError(message, PI_CLI_ID, err);
  }
  return new UnexpectedError(message, PI_CLI_ID, err);
}
