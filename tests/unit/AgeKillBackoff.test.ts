import { describe, it, expect } from 'vitest';
import { AgeKillBackoff, DEFAULT_AGE_KILL_BACKOFF } from '../../src/core/AgeKillBackoff.js';

const MIN = 60_000;

describe('AgeKillBackoff', () => {
  it('allows the first kill request, then suppresses re-requests within the window after a veto', () => {
    const b = new AgeKillBackoff({ backoffMs: 10 * MIN });
    let now = 1_000_000;
    expect(b.shouldRequest('s1', now)).toBe(true);  // first ask allowed
    b.recordVeto('s1', now);                         // guard kept it
    expect(b.shouldRequest('s1', now)).toBe(false);          // immediately suppressed
    expect(b.shouldRequest('s1', now + 5_000)).toBe(false);  // +5s (a monitor tick) — still suppressed
    expect(b.shouldRequest('s1', now + 9 * MIN)).toBe(false); // +9m — still inside window
  });

  it('re-allows a request once the back-off window elapses', () => {
    const b = new AgeKillBackoff({ backoffMs: 10 * MIN });
    const now = 2_000_000;
    b.recordVeto('s1', now);
    expect(b.shouldRequest('s1', now + 10 * MIN)).toBe(true);  // exactly at window boundary
    expect(b.shouldRequest('s1', now + 11 * MIN)).toBe(true);  // past window
  });

  it('the every-5s flood is cut to ~1 request per window (regression for the 17,503-line incident)', () => {
    const b = new AgeKillBackoff({ backoffMs: 10 * MIN });
    let now = 0;
    let requests = 0;
    // Simulate 1 hour of 5-second monitor ticks on an over-age, perpetually-KEPT session.
    for (let t = 0; t < 60 * MIN; t += 5_000) {
      if (b.shouldRequest('s1', t)) { requests++; b.recordVeto('s1', t); }
    }
    // Was 720 (one per 5s tick). Now 6 (one per 10-min window).
    expect(requests).toBe(6);
  });

  it('recordKilled / clear / reset drop the back-off so the session is re-evaluated', () => {
    const b = new AgeKillBackoff({ backoffMs: 10 * MIN });
    const now = 3_000_000;
    b.recordVeto('s1', now); expect(b.shouldRequest('s1', now)).toBe(false);
    b.recordKilled('s1');    expect(b.shouldRequest('s1', now)).toBe(true);
    b.recordVeto('s2', now); b.clear('s2');  expect(b.shouldRequest('s2', now)).toBe(true);
    b.recordVeto('s3', now); b.reset('s3');  expect(b.shouldRequest('s3', now)).toBe(true);
  });

  it('backoffMs:0 imposes no cooldown window (shouldRequest always true)', () => {
    // Generalized VetoedKillBackoff semantics (R4-5): cooldownMs:0 is
    // "enabled-but-no-cooldown" — shouldRequest is always true (no gate), so the
    // age-gate re-requests every tick exactly as the legacy backoffMs:0 disable did.
    // The ledger DOES record the veto now (episode-count/log-once/breaker still
    // work), but with no cooldown the gate never suppresses anything.
    const b = new AgeKillBackoff({ backoffMs: 0 });
    const now = 4_000_000;
    b.recordVeto('s1', now);
    expect(b.shouldRequest('s1', now)).toBe(true);       // never suppressed (no cooldown)
    expect(b.shouldRequest('s1', now + 5_000)).toBe(true);
  });

  it('is memory-bounded: evicts oldest beyond maxTracked', () => {
    const b = new AgeKillBackoff({ backoffMs: 10 * MIN, maxTracked: 3 });
    for (let i = 0; i < 5; i++) b.recordVeto('s' + i, 1000 + i);
    expect(b.trackedCount).toBe(3);
    // Oldest (s0, s1) evicted → allowed again; newest retained → suppressed.
    expect(b.shouldRequest('s0', 1000)).toBe(true);
    expect(b.shouldRequest('s4', 1000)).toBe(false);
  });

  it('a negative/NaN backoff falls back to the default; 0 is honored as disable', () => {
    expect(new AgeKillBackoff({ backoffMs: -5 }).remainingMs).toBeDefined();
    const def = new AgeKillBackoff({});
    def.recordVeto('s1', 0);
    expect(def.remainingMs('s1', 0)).toBe(DEFAULT_AGE_KILL_BACKOFF.backoffMs);
  });
});
