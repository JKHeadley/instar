/**
 * B4 (multimachine-lease-poll-robustness, Decision 9) — clock-skew alarm decision.
 * Proves the early-warning threshold, hysteresis, step-skew (abs), and the N=2
 * self-blame attribution (never a confident finger-point when our own clock is
 * unsynced or unprobed).
 */

import { describe, it, expect } from 'vitest';
import { evaluateClockSkew, type ClockSkewInputs } from '../../src/core/clockSkewAlarm.js';

const base: ClockSkewInputs = {
  observedOffsetMs: 0,
  ownNtpSynced: true,
  alarmThresholdMs: 20_000,
  clearThresholdMs: 12_000,
  currentlyAlarming: false,
};
const e = (o: Partial<ClockSkewInputs>) => evaluateClockSkew({ ...base, ...o });

describe('B4 evaluateClockSkew — clock-drift early-warning', () => {
  it('within tolerance → no alarm', () => {
    expect(e({ observedOffsetMs: 5_000 }).alarming).toBe(false);
    expect(e({ observedOffsetMs: -10_000 }).alarming).toBe(false); // abs, still < 20s
  });

  it('crosses the alarm threshold (below the 30s reject cliff) → alarms EARLY', () => {
    expect(e({ observedOffsetMs: 21_000 }).alarming).toBe(true); // 21s < 30s reject → early warning
    expect(e({ observedOffsetMs: -25_000 }).alarming).toBe(true); // step skew, abs
  });

  it('hysteresis: stays alarming until below the clear threshold', () => {
    // Already alarming at 15s (between clear 12s and alarm 20s) → stays.
    expect(e({ observedOffsetMs: 15_000, currentlyAlarming: true }).alarming).toBe(true);
    // Drops below clear → clears.
    expect(e({ observedOffsetMs: 11_000, currentlyAlarming: true }).alarming).toBe(false);
    // Not yet alarming at 15s → does NOT start (must reach the alarm threshold).
    expect(e({ observedOffsetMs: 15_000, currentlyAlarming: false }).alarming).toBe(false);
  });

  it('N=2 attribution: own clock UNSYNCED → blame SELF (never finger-point the peer)', () => {
    const v = e({ observedOffsetMs: 25_000, ownNtpSynced: false });
    expect(v.alarming).toBe(true);
    expect(v.blame).toBe('self');
    expect(v.reason).toMatch(/my own clock is not NTP-synced/i);
  });

  it('N=2 attribution: own clock SYNCED → blame the PEER', () => {
    const v = e({ observedOffsetMs: 25_000, ownNtpSynced: true });
    expect(v.blame).toBe('peer');
  });

  it('N=2 attribution: own NTP status UNKNOWN → blame unknown (no confident finger-point)', () => {
    const v = e({ observedOffsetMs: 25_000, ownNtpSynced: undefined });
    expect(v.blame).toBe('unknown');
  });

  // Freeze-vs-skew (the 2026-06-20 live lesson, topic 13481): an event-loop freeze
  // makes pre-freeze timestamps look stale → a large apparent offset with BOTH
  // clocks synced. The alarm must NOT cry "peer skew" during a local freeze.
  it('recent LOCAL event-loop starvation → SUPPRESSES the peer-skew alarm (blame local-freeze)', () => {
    const v = e({ observedOffsetMs: 200_000, ownNtpSynced: true, recentLocalStarvationAgeMs: 2_000 });
    expect(v.alarming).toBe(false); // would otherwise alarm + blame peer
    expect(v.blame).toBe('local-freeze');
    expect(v.reason).toMatch(/event-loop starvation/i);
  });

  it('a freeze OLDER than the freshness window does NOT suppress a genuine skew alarm', () => {
    const v = e({ observedOffsetMs: 200_000, ownNtpSynced: true, recentLocalStarvationAgeMs: 120_000 });
    expect(v.alarming).toBe(true); // freeze aged out → persistent offset is genuine skew
    expect(v.blame).toBe('peer');
  });

  it('respects a custom starvationFreshnessMs window', () => {
    // 40s-old freeze, but a 60s freshness window → still attributed to the freeze.
    const v = e({ observedOffsetMs: 50_000, ownNtpSynced: true, recentLocalStarvationAgeMs: 40_000, starvationFreshnessMs: 60_000 });
    expect(v.alarming).toBe(false);
    expect(v.blame).toBe('local-freeze');
  });

  it('no starvation signal (undefined) → behaves exactly as before (skew alarm fires)', () => {
    const v = e({ observedOffsetMs: 25_000, ownNtpSynced: true });
    expect(v.alarming).toBe(true);
    expect(v.blame).toBe('peer');
  });

  it('an in-tolerance offset stays no-alarm even with a fresh freeze (no spurious local-freeze verdict)', () => {
    const v = e({ observedOffsetMs: 3_000, ownNtpSynced: true, recentLocalStarvationAgeMs: 1_000 });
    expect(v.alarming).toBe(false);
    expect(v.blame).toBe('unknown'); // within tolerance → the freeze branch is never reached
  });
});
