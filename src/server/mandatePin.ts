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
    const buckets = opts.forwardedBucketKey && opts.forwardedBucketKey !== ip ? [ip, opts.forwardedBucketKey] : [ip];
    const now = Date.now();
    for (const bucket of buckets) {
      if (store?.blocked(bucket)) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return false;
      }
      let e = attempts.get(bucket);
      if (e && now > e.resetAt) { attempts.delete(bucket); e = undefined; }
      if (e && e.count >= MANDATE_PIN_MAX_ATTEMPTS) {
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
      let remaining = MANDATE_PIN_MAX_ATTEMPTS;
      for (const bucket of buckets) {
        let e = attempts.get(bucket);
        if (!e) { e = { count: 0, resetAt: now + MANDATE_PIN_WINDOW_MS }; attempts.set(bucket, e); }
        e.count++;
        const durableRemaining = store?.recordFailure(bucket);
        remaining = Math.min(remaining, durableRemaining ?? (MANDATE_PIN_MAX_ATTEMPTS - e.count));
      }
      res.status(403).json({ error: 'Incorrect PIN', attemptsRemaining: remaining });
      return false;
    }
    for (const bucket of buckets) { attempts.delete(bucket); store?.recordSuccess(bucket); }
    return true;
  };
}
