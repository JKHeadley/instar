/**
 * B5 (multimachine-lease-poll-robustness, Decision 11) — the three-valued
 * exactly-one-listener decision. Proves ok / dual / silence / indeterminate and
 * the partition-immune Telegram-409 ground truth, with a dark peer NEVER causing
 * a false silence/ok alarm.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePollerCount, poolPollerVerdict, type PollerObservation } from '../../src/core/pollerCount.js';

const m = (id: string, pollingActive: boolean | undefined, fresh = true): PollerObservation =>
  ({ machineId: id, pollingActive, fresh });

describe('B5 evaluatePollerCount — exactly-one-listener', () => {
  it('OK: exactly one fresh poller, everyone known', () => {
    const r = evaluatePollerCount([m('A', true), m('B', false)], false);
    expect(r.verdict).toBe('ok');
    expect(r.activePollers).toBe(1);
  });

  it('DUAL: two fresh pollers positively observed', () => {
    const r = evaluatePollerCount([m('A', true), m('B', true)], false);
    expect(r.verdict).toBe('dual');
    expect(r.activePollers).toBe(2);
  });

  it('SILENCE: zero pollers, everyone fresh + known (a real zero, not a gap)', () => {
    const r = evaluatePollerCount([m('A', false), m('B', false)], false);
    expect(r.verdict).toBe('silence');
  });

  it('INDETERMINATE: a dark peer → cannot confirm (NOT a false silence)', () => {
    // A is not polling; B is DARK. Legacy counting would call this "0 → silence",
    // but B might be the poller — so we must NOT alarm silence.
    const r = evaluatePollerCount([m('A', false), m('B', undefined, false)], false);
    expect(r.verdict).toBe('indeterminate');
    expect(r.hasVisibilityGap).toBe(true);
  });

  it('INDETERMINATE: an older peer with an unknown pollingActive field (mid-rollout)', () => {
    const r = evaluatePollerCount([m('A', true /*self polling*/), m('B', undefined /*old version*/)], false);
    // Self polling + B unknown → can't confirm exactly-one (B might also poll).
    expect(r.verdict).toBe('indeterminate');
  });

  it('DUAL via 409 EVEN WHEN the peer is dark (partition-immune ground truth)', () => {
    // A (self) is polling and got a 409 — someone else IS polling — but B is dark
    // so heartbeat-counting alone would say "1 → ok" and miss the dual-poll.
    const r = evaluatePollerCount([m('A', true), m('B', undefined, false)], true);
    expect(r.verdict).toBe('dual');
  });

  it('DUAL via positive ≥2 wins even with an unknown third peer', () => {
    const r = evaluatePollerCount([m('A', true), m('B', true), m('C', undefined, false)], false);
    expect(r.verdict).toBe('dual'); // we KNOW ≥2 regardless of C
  });

  it('single-machine: self is the one poller → ok', () => {
    expect(evaluatePollerCount([m('self', true)], false).verdict).toBe('ok');
  });

  describe('poolPollerVerdict (MachineCapacity adapter)', () => {
    it('online+pollingActive maps to a fresh poller (ok with one)', () => {
      const r = poolPollerVerdict([
        { machineId: 'A', online: true, pollingActive: true },
        { machineId: 'B', online: true, pollingActive: false },
      ], false);
      expect(r.verdict).toBe('ok');
    });
    it('offline peer (online:false) → not fresh → indeterminate, not false silence', () => {
      const r = poolPollerVerdict([
        { machineId: 'A', online: true, pollingActive: false },
        { machineId: 'B', online: false }, // dark — online undefined→false, pollingActive undefined
      ], false);
      expect(r.verdict).toBe('indeterminate');
    });
    it('two online pollers → dual', () => {
      expect(poolPollerVerdict([
        { machineId: 'A', online: true, pollingActive: true },
        { machineId: 'B', online: true, pollingActive: true },
      ], false).verdict).toBe('dual');
    });
  });
});
