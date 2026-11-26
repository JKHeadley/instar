/**
 * The operator-PIN gate shared by every route that a human, never an agent, may call
 * (mandate issuance/revocation, authorization-request approve/deny, skill-learning
 * proposal verdicts, ...). Extracted from the `checkMandatePin` closure in routes.ts so a
 * route module can run the SAME check with a route-specific message
 * (skill-learning-sentinel §3.10, decision 11: "a message override is a needed change").
 *
 * Verification mirrors /dashboard/unlock: sha256 + timingSafeEqual + a per-IP attempt
 * limit. The lockout counters write through to the durable PinAttemptStore when one is
 * available (S2-1 hardening: a server restart no longer resets brute-force lockout); the
 * in-memory map remains the fallback. One `createMandatePinCheck()` instance holds one
 * in-memory map, so every caller on a server shares the lockout by passing the same check.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PinAttemptStore } from '../core/PinAttemptStore.js';

export const MANDATE_PIN_MAX_ATTEMPTS = 5;
export const MANDATE_PIN_WINDOW_MS = 5 * 60 * 1000;
export const MANDATE_PIN_DEFAULT_MESSAGE = 'Operator PIN required — mandate issuance/revocation is a human action, not an agent action';

export interface MandatePinDeps {
  /** Read live: the config object can be swapped under a running server. */
  dashboardPin: () => string | undefined;
  pinAttemptStore?: () => PinAttemptStore | null | undefined;
  /**
   * identity-security-piece1c: the signed-in source of a guess (see ownerPinSource.ts). When given,
   * the budget is keyed on the credential that authenticated the request, not the socket address
   * (127.0.0.1 for every tunnel caller). The forwarded machine key, if any, is passed through.
   */
  pinSource?: (req: Request, forwardedBucketKey?: string) => string;
  /** Wrong guesses allowed per bucket per window (default MANDATE_PIN_MAX_ATTEMPTS). */
  maxAttempts?: number;
  /**
   * Whether a right PIN clears the bucket (default true). False for a SHARED bucket (the strangers'
   * public cap): one caller's success must never hand everyone a fresh budget (identity-security-piece1c).
   */
  clearOnSuccess?: boolean;
}

export interface MandatePinOptions {
  /** A PIN taken from somewhere other than `req.body.pin` (e.g. a query or header adapter). */
  pinOverride?: string;
  /** The 403 wording when no PIN was supplied; routes name the human action they guard. */
  message?: string;
  /**
   * A SECOND lockout bucket, charged and checked IN ADDITION to the caller's IP bucket. A request a
   * standby FORWARDED to the lease holder arrives from the standby's address, so every forwarded tap
   * would otherwise share one IP bucket (skill-learning-sentinel deviation (y)); the holder adds a
   * bucket for the forwarding machine. The route must only pass a value it has verified names a
   * roster machine — this check never trusts the key, it only charges it; a lockout on EITHER bucket
   * refuses.
   */
  forwardedBucketKey?: string;
}

/** `(req, res, opts?) → boolean`: true when the PIN is valid; otherwise the response is already sent (503/429/403). */
export type MandatePinCheck = (req: Request, res: Response, opts?: MandatePinOptions) => boolean;

export function createMandatePinCheck(deps: MandatePinDeps): MandatePinCheck {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return function requireMandatePin(req: Request, res: Response, opts: MandatePinOptions = {}): boolean {
    const expected = deps.dashboardPin();
    if (!expected) {
      res.status(503).json({ error: 'PIN authentication not available (no dashboardPin configured)' });
      return false;
    }
    const store = deps.pinAttemptStore?.() ?? null;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const buckets = deps.pinSource
      ? [deps.pinSource(req, opts.forwardedBucketKey)]
      : (opts.forwardedBucketKey && opts.forwardedBucketKey !== ip ? [ip, opts.forwardedBucketKey] : [ip]);
    const now = Date.now();
    for (const bucket of buckets) {
      if (store?.blocked(bucket, deps.maxAttempts ?? MANDATE_PIN_MAX_ATTEMPTS)) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return false;
      }
      if (store) continue; // the durable store is the one counter; the in-memory map is only its fallback
      let e = attempts.get(bucket);
      if (e && now > e.resetAt) { attempts.delete(bucket); e = undefined; }
      if (e && e.count >= (deps.maxAttempts ?? MANDATE_PIN_MAX_ATTEMPTS)) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return false;
      }
    }
    const pin = opts.pinOverride ?? ((req.body ?? {}) as { pin?: unknown }).pin;
    if (!pin || typeof pin !== 'string') {
      res.status(403).json({ error: opts.message ?? MANDATE_PIN_DEFAULT_MESSAGE });
      return false;
    }
    const ha = createHash('sha256').update(pin).digest();
    const hb = createHash('sha256').update(expected).digest();
    if (ha.length !== hb.length || !timingSafeEqual(ha, hb)) {
      let remaining = deps.maxAttempts ?? MANDATE_PIN_MAX_ATTEMPTS;
      for (const bucket of buckets) {
        if (store) { remaining = Math.min(remaining, store.recordFailure(bucket, deps.maxAttempts ?? MANDATE_PIN_MAX_ATTEMPTS)); continue; }
        let e = attempts.get(bucket);
        if (!e) { e = { count: 0, resetAt: now + MANDATE_PIN_WINDOW_MS }; attempts.set(bucket, e); }
        e.count++;
        remaining = Math.min(remaining, (deps.maxAttempts ?? MANDATE_PIN_MAX_ATTEMPTS) - e.count);
      }
      res.status(403).json({ error: 'Incorrect PIN', attemptsRemaining: remaining });
      return false;
    }
    if (deps.clearOnSuccess !== false) for (const bucket of buckets) { attempts.delete(bucket); store?.recordSuccess(bucket); }
    return true;
  };
}

/**
 * identity-security-piece1c: the same signed-in budget as `createMandatePinCheck`, returning a
 * verdict instead of sending a response, for routes that keep their own response shape. Synchronous:
 * admission, the compare and the charge happen with no await between them.
 */
export type OwnerPinVerdict =
  | { ok: true }
  | { ok: false; reason: 'not-configured' | 'missing' | 'throttled' | 'wrong'; remaining?: number };

export function createOwnerPinVerdict(deps: MandatePinDeps): (req: Request, candidate: unknown, opts?: { forwardedBucketKey?: string }) => OwnerPinVerdict {
  const fallback = new Map<string, { count: number; resetAt: number }>();
  const max = deps.maxAttempts ?? MANDATE_PIN_MAX_ATTEMPTS;
  return (req, candidate, opts = {}) => {
    const expected = deps.dashboardPin();
    if (!expected) return { ok: false, reason: 'not-configured' };
    const store = deps.pinAttemptStore?.() ?? null;
    const bucket = deps.pinSource ? deps.pinSource(req, opts.forwardedBucketKey) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    if (store) {
      if (store.blocked(bucket, max)) return { ok: false, reason: 'throttled' };
    } else {
      const e = fallback.get(bucket);
      if (e && now > e.resetAt) fallback.delete(bucket);
      else if (e && e.count >= max) return { ok: false, reason: 'throttled' };
    }
    if (typeof candidate !== 'string' || !candidate) return { ok: false, reason: 'missing' };
    const ha = createHash('sha256').update(candidate).digest();
    const hb = createHash('sha256').update(expected).digest();
    if (ha.length !== hb.length || !timingSafeEqual(ha, hb)) {
      let remaining: number;
      if (store) remaining = store.recordFailure(bucket, max);
      else {
        let e = fallback.get(bucket);
        if (!e) { e = { count: 0, resetAt: now + MANDATE_PIN_WINDOW_MS }; fallback.set(bucket, e); }
        e.count++;
        remaining = Math.max(0, max - e.count);
      }
      return { ok: false, reason: 'wrong', remaining };
    }
    if (deps.clearOnSuccess !== false) { if (store) store.recordSuccess(bucket); else fallback.delete(bucket); }
    return { ok: true };
  };
}
