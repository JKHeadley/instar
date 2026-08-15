/**
 * Adapter-specific error helpers for grok-build (xAI Grok Build CLI).
 *
 * Maps raw failures (grok CLI non-zero exit, timeout/abort) to the canonical
 * ProviderError hierarchy. Mirrors pi-cli/errors.ts, plus the two
 * grok-specific error classes the auth policy needs (grok-build framework
 * integration spec §3.1):
 *
 *   - GrokApiKeyForbiddenError — thrown by policy.ts when an API/deployment
 *     key is present in the environment. The spec's billing rule: a run must
 *     bill against the subscription session, never fall back to a metered
 *     key, and a key ANYWHERE in the environment is refused even alongside a
 *     valid session (review-1 finding 3: the CLI itself may prefer/fall back
 *     in ways we cannot enumerate, so the adapter refuses the whole state).
 *   - GrokSessionExpiredError — thrown by policy.ts when ~/.grok/auth.json
 *     exists but its stored expiry has passed. "File exists" is NOT "session
 *     active" (review-1 finding 3); proceeding on an expired session invites
 *     the CLI's own silent API-key fallback.
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

/** Stable provider id for the Grok Build adapter. */
export const GROK_BUILD_ID: ProviderId = providerId('grok-build');

/**
 * Billing-guard error (spec §3.1): an API/deployment key is present in the
 * environment. Refused BEFORE spawn regardless of session state — the CLI's
 * key-fallback behaviour under every session condition is not fully
 * characterized, and a silent fallback inverts the subscription economics
 * with no signal. AuthError subclass so existing callers branch uniformly.
 */
export class GrokApiKeyForbiddenError extends AuthError {
  /** The offending env var NAME (never its value). */
  readonly envVar: string;

  constructor(envVar: string) {
    super(
      `grok-build refuses to run with ${envVar} set: a metered API key in the ` +
        `environment can silently become the billing path instead of the ` +
        `subscription session (grok-auth-apikey-forbidden). Unset it, or use ` +
        `the xAI API adapter path deliberately.`,
      GROK_BUILD_ID,
    );
    this.name = 'GrokApiKeyForbiddenError';
    this.envVar = envVar;
    Object.setPrototypeOf(this, GrokApiKeyForbiddenError.prototype);
  }
}

/**
 * A credential-bearing key was found in the grok CLI's own `config.toml`.
 *
 * Round-21: the env sweep above was the WHOLE refusal, but the vendor's
 * shipped README (v1.0.4, "Credential resolution order") puts a config-file
 * `api_key` FIRST — ahead of the session token — and documents
 * `[model.<name>] api_key = "…"` as a supported override. `env_key` is the
 * same hole one indirection out: it names an arbitrary env var to read, so it
 * escapes a fixed forbidden-name list by construction.
 *
 * The adapter already parsed this exact file line-by-line looking for the
 * login-policy key, so the credential sat in a file we were reading and
 * not looking at. That is why this is a distinct error from the env one: the
 * remedy is "remove the key from the file", not "unset the variable".
 *
 * `location` carries the TOML section and the KEY NAME only — never a value.
 */
export class GrokConfigCredentialForbiddenError extends AuthError {
  /** TOML section + key NAME (never the value). */
  readonly location: string;

  constructor(location: string) {
    super(
      `grok-build refuses to run: a credential key is present in the grok ` +
        `config file at ${location}. The vendor resolves a config-file api_key ` +
        `AHEAD of the subscription session token, so this can silently become ` +
        `the billing path (grok-auth-apikey-forbidden). Remove the key, or use ` +
        `the xAI API adapter path deliberately.`,
      GROK_BUILD_ID,
    );
    this.name = 'GrokConfigCredentialForbiddenError';
    this.location = location;
    Object.setPrototypeOf(this, GrokConfigCredentialForbiddenError.prototype);
  }
}

/**
 * Login-policy error (spec §3.1.1): the vendor's `disable_api_key_auth`
 * policy is not verifiably in force for the grok home. Refused at the spawn
 * chokepoint — the primary billing control must hold on EVERY path, not
 * only the reviewer detection probe (adversarial round-4 finding 2).
 */
export class GrokLoginPolicyUnverifiedError extends AuthError {
  constructor(grokHome: string) {
    super(
      `grok-build login policy is not verifiably in force for ${grokHome} ` +
        `(grok-login-policy-unverified). Set disable_api_key_auth = true under ` +
        `[auth] in config.toml (or export GROK_DISABLE_API_KEY_AUTH=1).`,
      GROK_BUILD_ID,
    );
    this.name = 'GrokLoginPolicyUnverifiedError';
    Object.setPrototypeOf(this, GrokLoginPolicyUnverifiedError.prototype);
  }
}

/**
 * Session-expiry error (spec §3.1 / review-1 finding 3): the auth file
 * exists but the session it stores is expired (or unreadable/malformed).
 * Refused BEFORE spawn: an expired session invites the CLI's own fallback
 * behaviour, and "auth.json exists" must never be read as "session active".
 */
export class GrokSessionExpiredError extends AuthError {
  constructor(detail: string) {
    super(
      `grok-build session token is not usable (${detail}). Re-run ` +
        `\`grok login --device-auth\` to mint a fresh session ` +
        `(grok-auth-expired).`,
      GROK_BUILD_ID,
    );
    this.name = 'GrokSessionExpiredError';
    Object.setPrototypeOf(this, GrokSessionExpiredError.prototype);
  }
}

/**
 * Redact credential-shaped material from CLI stderr before it can reach an
 * error message or log (security review round-3 finding 3: the AuthError
 * branch fires exactly when stderr matches invalid-token language — the case
 * where CLIs most commonly echo the offending credential fragment).
 * Redacts: JWT-shaped triplets (eyJ…), xai-/sk- style key prefixes, and any
 * base64url run long enough to be secret material.
 */
export function scrubStderr(stderr: string): string {
  return stderr
    .replace(/eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,}){0,2}/g, '[redacted-jwt]')
    .replace(/\b(xai|sk|dk|ghp|gho)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted-blob]');
}

/**
 * Map a raw spawn-style error from spawning `grok` into a canonical provider
 * error. Stderr is inspected for auth / rate-limit / quota / network
 * signatures (same classification shape as pi/gemini/codex) so the circuit
 * breaker's rate-limit classifier can see usage/limit language. All stderr
 * embedded into messages passes scrubStderr first.
 */
export function mapExecError(
  err: Error & { code?: string | number; signal?: string; killed?: boolean; path?: string },
  stderr = '',
): ProviderError {
  if (err.name === 'AbortError') {
    return new AbortError('grok exec aborted', GROK_BUILD_ID, err);
  }
  if (err.signal === 'SIGTERM' || err.killed) {
    return new TimeoutError(
      `grok CLI killed: ${err.message}`,
      GROK_BUILD_ID,
      0,
      { cause: err },
    );
  }
  if (err.code === 'ENOENT') {
    return new UnexpectedError(
      `grok CLI binary not found: ${err.path ?? '(unknown)'}`,
      GROK_BUILD_ID,
      err,
    );
  }
  const message = stderr ? scrubStderr(stderr).slice(0, 500) : err.message;
  if (/unauthor|forbidden|invalid.*token|invalid.*key|sign.?in|401|403/i.test(stderr)) {
    return new AuthError(message, GROK_BUILD_ID, err);
  }
  if (/rate.?limit|429|too many requests|resource.?exhausted/i.test(stderr)) {
    return new RateLimitError(message, GROK_BUILD_ID, { cause: err });
  }
  if (/quota|usage.?limit|weekly.?limit|out of usage/i.test(stderr)) {
    // The weekly pool is NOT observable in advance (spec §0.3 — 1.3M tokens
    // moved the counter 0%), so pool exhaustion arrives ONLY as this error
    // at call time. Terminal for the call; the caller must not blind-retry.
    return new QuotaError(message, GROK_BUILD_ID, { limitKind: 'unknown', cause: err });
  }
  if (/network|ECONN|ETIMEDOUT|dns/i.test(stderr)) {
    return new NetworkError(message, GROK_BUILD_ID, err);
  }
  return new UnexpectedError(message, GROK_BUILD_ID, err);
}
