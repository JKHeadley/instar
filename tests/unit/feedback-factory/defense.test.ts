/**
 * Unit tests (Tier 1) — feedback receiver intake defenses.
 *
 * The reference is TypeScript (the-portal/pages/api/instar/feedback.ts), so
 * equivalence is by faithful transcription + exhaustive both-sides-of-boundary
 * tests here (not a cross-runtime parity harness). `now` is injected for
 * determinism.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  normalizeWebhookSecret, isValidType, extractSourceIp, validateAgentFingerprint,
  checkHoneypot, verifySignature, RateLimiter, RATE_LIMITS,
} from '../../../src/feedback-factory/receiver/defense.js';

describe('normalizeWebhookSecret', () => {
  it('trims a trailing newline (the trailing-newline guard)', () => {
    expect(normalizeWebhookSecret('instar-rising-tide-v1\n')).toBe('instar-rising-tide-v1');
    expect(normalizeWebhookSecret('  s  ')).toBe('s');
    expect(normalizeWebhookSecret(undefined)).toBeUndefined();
  });
});

describe('isValidType', () => {
  it('accepts valid types, rejects others', () => {
    expect(isValidType('bug')).toBe(true);
    expect(isValidType('hallucination')).toBe(true);
    expect(isValidType('nonsense')).toBe(false);
    expect(isValidType(42)).toBe(false);
  });
});

describe('extractSourceIp', () => {
  it('takes the first x-forwarded-for hop, then remoteAddress, then unknown', () => {
    expect(extractSourceIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })).toBe('1.1.1.1');
    expect(extractSourceIp({}, '3.3.3.3')).toBe('3.3.3.3');
    expect(extractSourceIp({})).toBe('unknown');
  });
});

describe('validateAgentFingerprint', () => {
  it('requires instar/ in the UA', () => {
    expect(validateAgentFingerprint('instar/1.3.0').valid).toBe(true);
    expect(validateAgentFingerprint('curl/8.0')).toEqual({ valid: false, reason: 'missing-ua' });
    expect(validateAgentFingerprint(undefined)).toEqual({ valid: false, reason: 'missing-ua' });
  });
  it('rejects a malformed version header but allows absent', () => {
    expect(validateAgentFingerprint('instar/1.3.0', '1.3.0').valid).toBe(true);
    expect(validateAgentFingerprint('instar/1.3.0', 'not-semver')).toEqual({ valid: false, reason: 'invalid-version-header' });
    expect(validateAgentFingerprint('instar/1.3.0', undefined).valid).toBe(true);
  });
});

describe('checkHoneypot', () => {
  it('flags presence of website/email as a bot', () => {
    expect(checkHoneypot({ website: 'x' })).toBe(true);
    expect(checkHoneypot({ email: 'x@y' })).toBe(true);
    expect(checkHoneypot({ title: 'real' })).toBe(false);
  });
});

describe('verifySignature', () => {
  const secret = 'test-secret';
  const body = { type: 'bug', title: 'hello' };
  const now = 1_000_000_000_000;
  const sign = (ts: number) => createHmac('sha256', secret).update(`${ts}.${JSON.stringify(body)}`).digest('hex');

  it('accepts a valid signature inside the replay window', () => {
    const ts = now - 1000;
    expect(verifySignature({ signature: sign(ts), timestamp: String(ts), body, secret, now })).toBe(true);
  });
  it('rejects a wrong signature', () => {
    const ts = now - 1000;
    expect(verifySignature({ signature: 'deadbeef', timestamp: String(ts), body, secret, now })).toBe(false);
  });
  it('rejects missing fields / secret', () => {
    expect(verifySignature({ timestamp: '1', body, secret, now })).toBe(false);
    expect(verifySignature({ signature: 'x', body, secret, now })).toBe(false);
    expect(verifySignature({ signature: 'x', timestamp: '1', body, secret: undefined, now })).toBe(false);
  });
  it('enforces the replay window (+5min / -1min)', () => {
    const tooOld = now - 300_001; // age > 300_000 → reject
    expect(verifySignature({ signature: sign(tooOld), timestamp: String(tooOld), body, secret, now })).toBe(false);
    const tooFuture = now + 60_001; // age < -60_000 → reject
    expect(verifySignature({ signature: sign(tooFuture), timestamp: String(tooFuture), body, secret, now })).toBe(false);
    const justInside = now - 299_000;
    expect(verifySignature({ signature: sign(justInside), timestamp: String(justInside), body, secret, now })).toBe(true);
  });
});


describe('RateLimiter', () => {
  it('allows up to perHour then blocks with a retryAfter', () => {
    let t = 1_000_000_000_000;
    const rl = new RateLimiter(RATE_LIMITS, () => t);
    for (let i = 0; i < RATE_LIMITS.perHour; i++) {
      expect(rl.check('ip').allowed).toBe(true);
    }
    const blocked = rl.check('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });
  it('lets the window slide — after an hour the count resets', () => {
    let t = 1_000_000_000_000;
    const rl = new RateLimiter(RATE_LIMITS, () => t);
    for (let i = 0; i < RATE_LIMITS.perHour; i++) rl.check('ip');
    expect(rl.check('ip').allowed).toBe(false);
    t += RATE_LIMITS.windowHourMs + 1; // slide past the hour window
    expect(rl.check('ip').allowed).toBe(true);
  });
  it('isolates limits per IP', () => {
    let t = 1_000_000_000_000;
    const rl = new RateLimiter(RATE_LIMITS, () => t);
    for (let i = 0; i < RATE_LIMITS.perHour; i++) rl.check('ipA');
    expect(rl.check('ipA').allowed).toBe(false);
    expect(rl.check('ipB').allowed).toBe(true);
  });
});
