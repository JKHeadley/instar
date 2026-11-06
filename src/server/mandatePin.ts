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
    const now = Date.now();
    if (store?.blocked(ip)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return false;
    }
    let entry = attempts.get(ip);
    if (entry && now > entry.resetAt) { attempts.delete(ip); entry = undefined; }
    if (entry && entry.count >= MANDATE_PIN_MAX_ATTEMPTS) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return false;
    }
    const pin = opts.pinOverride ?? ((req.body ?? {}) as { pin?: unknown }).pin;
    if (!pin || typeof pin !== 'string') {
      res.status(403).json({ error: opts.message ?? MANDATE_PIN_DEFAULT_MESSAGE });
      return false;
    }
    const ha = createHash('sha256').update(pin).digest();
    const hb = createHash('sha256').update(expected).digest();
    if (ha.length !== hb.length || !timingSafeEqual(ha, hb)) {
      if (!entry) { entry = { count: 0, resetAt: now + MANDATE_PIN_WINDOW_MS }; attempts.set(ip, entry); }
      entry.count++;
      const durableRemaining = store?.recordFailure(ip);
      res.status(403).json({ error: 'Incorrect PIN', attemptsRemaining: durableRemaining ?? (MANDATE_PIN_MAX_ATTEMPTS - entry.count) });
      return false;
    }
    attempts.delete(ip);
    store?.recordSuccess(ip);
    return true;
  };
}
