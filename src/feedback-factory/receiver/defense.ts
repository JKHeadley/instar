/**
 * defense.ts — framework-agnostic port of the feedback receiver's intake defenses.
 *
 * Ports the six defense-in-depth layers of `the-portal/pages/api/instar/feedback.ts`
 * (rate-limit, agent fingerprint, honeypot, HMAC signature, input validation,
 * dedup-key/type) out of the Next.js handler into pure/injectable functions, so the
 * canonical front (whatever framework hosts it) reuses the exact same logic. The
 * HTTP wiring + the app/framework placement is deliberately NOT here (it is the
 * architecture decision in the spec's blocked list); this is the reusable core.
 *
 * Reference is TypeScript, so equivalence is by faithful transcription + exhaustive
 * both-sides-of-boundary unit tests (not a cross-runtime parity harness — those
 * apply to the Python processor ports). `now` is injected everywhere the reference
 * used `Date.now()`, so tests are deterministic.
 *
 * Convergence finding folded in: `normalizeWebhookSecret` trims the secret at load
 * so a trailing newline can't silently break the HMAC (the reference relied on a
 * "use printf not echo" warning; this makes it structural).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const VALID_TYPES = ['bug', 'feature', 'improvement', 'question', 'hallucination', 'other'] as const;
export type FeedbackType = typeof VALID_TYPES[number];

export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
export const FEEDBACK_ID_RE = /^fb-[a-z0-9-]{6,36}$/;
export const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,98}[a-zA-Z0-9]$/;
export const NODE_VERSION_RE = /^v?\d+\.\d+\.\d+$/;

export const RATE_LIMITS = {
  perHour: 10,
  perDay: 50,
  windowHourMs: 60 * 60 * 1000,
  windowDayMs: 24 * 60 * 60 * 1000,
};

/** Trim the webhook secret so a trailing newline can't silently break the HMAC (convergence finding). */
export function normalizeWebhookSecret(secret: string | undefined): string | undefined {
  return secret == null ? secret : secret.trim();
}

export function isValidType(type: unknown): type is FeedbackType {
  return typeof type === 'string' && (VALID_TYPES as readonly string[]).includes(type);
}

/** Port of extractSourceIp: first x-forwarded-for hop, else remoteAddress, else 'unknown'. */
export function extractSourceIp(headers: Record<string, string | string[] | undefined>, remoteAddress?: string): string {
  const xff = headers['x-forwarded-for'];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  return xffStr?.split(',')[0]?.trim() || remoteAddress || 'unknown';
}

/** Port of validateAgentFingerprint: UA must contain "instar/"; version header, if present, must be semver. */
export function validateAgentFingerprint(userAgent: string | undefined, headerVersion?: string): { valid: boolean; reason?: string } {
  const ua = userAgent || '';
  if (!ua.toLowerCase().includes('instar/')) {
    return { valid: false, reason: 'missing-ua' };
  }
  if (headerVersion && !SEMVER_RE.test(headerVersion)) {
    return { valid: false, reason: 'invalid-version-header' };
  }
  return { valid: true };
}

/** Port of checkHoneypot: real agents never send `website`/`email`; presence ⇒ bot. */
export function checkHoneypot(body: Record<string, unknown>): boolean {
  return Boolean(body.website || body.email);
}

/**
 * Port of verifySignature. HMAC-SHA256 over `${timestamp}.${JSON.stringify(body)}`,
 * timing-safe compare, with a +5min / −1min replay window. `now` injected (ms).
 */
export function verifySignature(args: {
  signature?: string;
  timestamp?: string;
  body: unknown;
  secret: string | undefined;
  now: number;
}): boolean {
  const { signature, timestamp, body, secret, now } = args;
  if (!signature || !timestamp || !secret) return false;

  const age = now - parseInt(timestamp, 10);
  if (isNaN(age) || age > 300_000 || age < -60_000) return false;

  const payload = `${timestamp}.${JSON.stringify(body)}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(new Uint8Array(sigBuf), new Uint8Array(expBuf));
  } catch {
    return false;
  }
}

// NOTE: an earlier `validateFeedbackInput` helper lived here but diverged from the
// reference handleSubmit — it REJECTED an invalid `type` (the reference DEFAULTS it
// to 'other'), used a generic error message instead of the reference's specific
// per-field messages, and omitted the agentName/nodeVersion format checks. The
// faithful validation now lives inline in `handleFeedbackSubmit` (handlers.ts),
// which reproduces handleSubmit's exact order, messages, and type-default. The
// imperfect helper was removed to avoid two divergent validators.

/**
 * Port of the in-memory sliding-window rate limiter (checkRateLimit + prune) as an
 * injectable class. `now()` is injectable for deterministic tests; defaults to Date.now.
 */
export class RateLimiter {
  private store = new Map<string, { timestamps: number[] }>();
  private lastPrune = 0;
  private readonly pruneIntervalMs = 10 * 60 * 1000;

  constructor(
    private readonly limits = RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < this.pruneIntervalMs) return;
    this.lastPrune = now;
    const cutoff = now - this.limits.windowDayMs;
    this.store.forEach((entry, key) => {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) this.store.delete(key);
    });
  }

  check(ip: string): { allowed: boolean; retryAfterSec?: number } {
    this.prune();
    const now = this.now();
    const entry = this.store.get(ip) || { timestamps: [] };
    const hourAgo = now - this.limits.windowHourMs;
    const dayAgo = now - this.limits.windowDayMs;
    const hourCount = entry.timestamps.filter(t => t > hourAgo).length;
    const dayCount = entry.timestamps.filter(t => t > dayAgo).length;

    if (hourCount >= this.limits.perHour) {
      const oldest = entry.timestamps.filter(t => t > hourAgo).sort()[0];
      return { allowed: false, retryAfterSec: Math.ceil((oldest + this.limits.windowHourMs - now) / 1000) };
    }
    if (dayCount >= this.limits.perDay) {
      const oldest = entry.timestamps.filter(t => t > dayAgo).sort()[0];
      return { allowed: false, retryAfterSec: Math.ceil((oldest + this.limits.windowDayMs - now) / 1000) };
    }

    entry.timestamps.push(now);
    this.store.set(ip, entry);
    return { allowed: true };
  }
}
