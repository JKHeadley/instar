import { describe, it, expect } from 'vitest';
import { detectDeferralShape } from '../../src/core/deferral-floor.js';

describe('detectDeferralShape — premature-deferral recognizer', () => {
  // ── DETECTS: an operational action deferred to the operator the agent could take itself ──
  it('flags the canonical 2026-07-22 miss (asking the operator to start/grant instead of self-serving)', () => {
    const r = detectDeferralShape('You start Codey on the laptop, or set me up with access and I will do it.');
    expect(r.detected).toBe(true);
    expect(r.requestMatch).toBeTruthy();
    expect(r.actionMatch).toBeTruthy();
  });

  it('flags "can you restart …"', () => {
    expect(detectDeferralShape('Can you restart Codey on the laptop for me?').detected).toBe(true);
  });

  it('flags "you\'ll need to install …"', () => {
    expect(detectDeferralShape("You'll need to install the key on the laptop.").detected).toBe(true);
  });

  it('flags "grant me … access …"', () => {
    expect(detectDeferralShape('Grant me SSH access and I can take it from there.').detected).toBe(true);
  });

  it('flags "please restart it yourself"', () => {
    expect(detectDeferralShape('Please restart it yourself when you get a chance.').detected).toBe(true);
  });

  // ── DOES NOT flag: a genuine DECISION only the operator can make, or an operator-only CREDENTIAL ──
  it('does NOT flag a genuine design decision (which model?)', () => {
    expect(detectDeferralShape('Which promotion model do you want — auto-climb or per-step operator-trigger?').detected).toBe(false);
  });

  it('does NOT flag an approval request for an irreversible action', () => {
    expect(detectDeferralShape('Do you approve deploying this to production?').detected).toBe(false);
  });

  it('does NOT flag a genuine operator-only credential ask (Rung 2)', () => {
    expect(detectDeferralShape('I need your password to unlock the vault — no other path to it.').detected).toBe(false);
  });

  it('does NOT flag a "which approach" decision', () => {
    expect(detectDeferralShape('Which approach should we take here?').detected).toBe(false);
  });

  // ── DOES NOT flag: the agent reporting its OWN action (no user-directed request) ──
  it('does NOT flag the agent reporting work it did itself', () => {
    expect(detectDeferralShape('I restarted the service and it is healthy now.').detected).toBe(false);
  });

  it('does NOT flag incidental advice mentioning an action but no request-to-act', () => {
    // "you can restart" is not in the request-marker set on purpose (advice, not a deferral).
    expect(detectDeferralShape('You can restart your machine anytime; it will not affect the run.').detected).toBe(false);
  });

  it('empty / whitespace is never flagged', () => {
    expect(detectDeferralShape('').detected).toBe(false);
    expect(detectDeferralShape('   ').detected).toBe(false);
  });
});
