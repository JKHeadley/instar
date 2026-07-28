import { describe, it, expect } from 'vitest';
import {
  decideZombieRelinquish,
  ZombieRelinquishLedger,
  type ZombieRelinquishInput,
} from '../../src/core/zombieRelinquish.js';

// A healthy active holder; override per case.
function base(over: Partial<ZombieRelinquishInput> = {}): ZombieRelinquishInput {
  return {
    holdsLease: true,
    isActiveLeaseRole: true,
    pending: false,
    pollAttemptedFresh: true,
    pollSucceededFresh: true,
    serveProgressedFresh: true,
    staleConfirmed: true,
    peerConfirmsGlobalOutage: false,
    ...over,
  };
}

describe('decideZombieRelinquish — G1 three-signal lease↔job binding', () => {
  it('not a holder → not-applicable (never relinquishes)', () => {
    const d = decideZombieRelinquish(base({ holdsLease: false }));
    expect(d.action).toBe('not-applicable');
    expect(d.relinquish).toBe(false);
  });

  it('holder but observe-only/deferential (not active role) → not-applicable (F3 owns it)', () => {
    const d = decideZombieRelinquish(base({ isActiveLeaseRole: false }));
    expect(d.action).toBe('not-applicable');
  });

  it('idle + poll succeeding → healthy', () => {
    const d = decideZombieRelinquish(base({ pending: false, pollSucceededFresh: true }));
    expect(d.action).toBe('healthy');
    expect(d.relinquish).toBe(false);
  });

  it('pending + serve progressing → healthy (serve signal is what matters when pending)', () => {
    // poll-success STALE but serve progressing while pending → still healthy.
    const d = decideZombieRelinquish(base({ pending: true, serveProgressedFresh: true, pollSucceededFresh: false }));
    expect(d.action).toBe('healthy');
    expect(d.reason).toBe('serve-progressing');
  });

  it('idle keys on pollSucceeded — serve stale while idle is NOT a zombie', () => {
    // idle (no pending work): a stale serveProgressed is irrelevant; poll fresh → healthy.
    const d = decideZombieRelinquish(base({ pending: false, pollSucceededFresh: true, serveProgressedFresh: false }));
    expect(d.action).toBe('healthy');
    expect(d.reason).toBe('poll-succeeding');
  });

  it('relevant-stale but not yet confirmed across ticks → await-confirm (no relinquish)', () => {
    const d = decideZombieRelinquish(base({ pending: false, pollSucceededFresh: false, staleConfirmed: false }));
    expect(d.action).toBe('await-confirm');
    expect(d.relinquish).toBe(false);
  });

  it('confirmed-stale + poll loop WEDGED (pollAttempted stale) → relinquish-wedged (unconditional)', () => {
    const d = decideZombieRelinquish(base({
      pending: false, pollSucceededFresh: false, staleConfirmed: true, pollAttemptedFresh: false,
    }));
    expect(d.action).toBe('relinquish-wedged');
    expect(d.relinquish).toBe(true);
  });

  it('confirmed-stale + trying + peer CONFIRMS global outage → hold-global (do NOT relinquish)', () => {
    const d = decideZombieRelinquish(base({
      pending: false, pollSucceededFresh: false, staleConfirmed: true,
      pollAttemptedFresh: true, peerConfirmsGlobalOutage: true,
    }));
    expect(d.action).toBe('hold-global');
    expect(d.relinquish).toBe(false);
  });

  it('confirmed-stale + trying + NO peer evidence → relinquish (LOCAL failure, safe direction)', () => {
    // "I can't hear any peer" ≠ global outage: peerConfirmsGlobalOutage stays false →
    // relinquish so G2 picks a server (never HOLD on unproven global blindness).
    const d = decideZombieRelinquish(base({
      pending: false, pollSucceededFresh: false, staleConfirmed: true,
      pollAttemptedFresh: true, peerConfirmsGlobalOutage: false,
    }));
    expect(d.action).toBe('relinquish');
    expect(d.relinquish).toBe(true);
  });

  it('pending + serve STALE + confirmed + trying + no peer → relinquish (fetched-and-dropped zombie)', () => {
    const d = decideZombieRelinquish(base({
      pending: true, serveProgressedFresh: false, staleConfirmed: true,
      pollAttemptedFresh: true, peerConfirmsGlobalOutage: false,
    }));
    expect(d.action).toBe('relinquish');
    expect(d.relinquish).toBe(true);
  });
});

describe('ZombieRelinquishLedger — evaluable soak evidence', () => {
  const t = '2026-06-28T00:00:00.000Z';
  it('counts each class; not-applicable is a non-event', () => {
    const led = new ZombieRelinquishLedger();
    led.record({ action: 'relinquish', relinquish: true, reason: 'x' }, t);
    led.record({ action: 'relinquish-wedged', relinquish: true, reason: 'x' }, t);
    led.record({ action: 'hold-global', relinquish: false, reason: 'x' }, t);
    led.record({ action: 'healthy', relinquish: false, reason: 'x' }, t);
    led.record({ action: 'await-confirm', relinquish: false, reason: 'x' }, t);
    led.record({ action: 'not-applicable', relinquish: false, reason: 'x' }, t);
    const s = led.summary();
    expect(s.evaluations).toBe(5);
    expect(s.relinquishedLocal).toBe(1);
    expect(s.relinquishedWedged).toBe(1);
    expect(s.heldGlobal).toBe(1);
    expect(s.healthy).toBe(1);
    expect(s.awaitConfirm).toBe(1);
  });
});
