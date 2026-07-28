/**
 * Tier-1 tests for FailureEpisodeLatch — the canonical episode-latch behind
 * P19 Eternal Sentinel condition 4 (state-change logging + one signal per
 * sustained-failure episode) — plus wiring pins for its first consumer: the
 * MultiMachineCoordinator heartbeat writer, whose unguarded writeHeartbeat()
 * throw inside the 2-min timer tick previously CRASHED the awake holder
 * (uncaughtException → FATAL path) on a transient fs error.
 */

import { describe, it, expect } from 'vitest';
import { FailureEpisodeLatch } from '../../src/core/FailureEpisodeLatch.js';

const MIN = 60_000;

function make(signalAfterMs: number) {
  let nowMs = 0;
  const latch = new FailureEpisodeLatch({ signalAfterMs, now: () => nowMs });
  return { latch, setNow: (t: number) => { nowMs = t; } };
}

describe('FailureEpisodeLatch', () => {
  it('round-trips a validated snapshot without replaying transitions', () => {
    let now = 10;
    const first = new FailureEpisodeLatch({ signalAfterMs: 5, now: () => now });
    first.recordFailure(); now = 20; first.recordFailure();
    const second = new FailureEpisodeLatch({ signalAfterMs: 5, now: () => now });
    second.restore(first.snapshot());
    expect(second.snapshot()).toEqual(first.snapshot());
    expect(second.recordFailure()).toMatchObject({ failures: 3, shouldSignal: false });
  });

  it('rejects inconsistent snapshots', () => {
    const latch = new FailureEpisodeLatch({ signalAfterMs: 5 });
    expect(() => latch.restore({ schemaVersion: 1, failingSince: null, failures: 1, signaledFor: null })).toThrow('invalid');
  });
  it('first failure of an episode is marked firstOfEpisode exactly once', () => {
    const { latch, setNow } = make(10 * MIN);
    setNow(1_000);
    expect(latch.recordFailure().firstOfEpisode).toBe(true);
    setNow(2 * MIN);
    expect(latch.recordFailure().firstOfEpisode).toBe(false);
    expect(latch.recordFailure().firstOfEpisode).toBe(false);
  });

  it('SUSTAINED-FAILURE BOUND (P19): a week of 2-min-cadence failures signals exactly ONCE', () => {
    const { latch, setNow } = make(6 * MIN);
    let signals = 0;
    let firsts = 0;
    for (let t = 0; t <= 7 * 24 * 60 * MIN; t += 2 * MIN) {
      setNow(t);
      const f = latch.recordFailure();
      if (f.shouldSignal) signals++;
      if (f.firstOfEpisode) firsts++;
    }
    expect(signals).toBe(1);
    expect(firsts).toBe(1); // bounded logging: one first-failure line, one signal — for a WEEK of failures
  });

  it('does not signal before the threshold', () => {
    const { latch, setNow } = make(6 * MIN);
    for (const t of [0, 2 * MIN, 4 * MIN]) {
      setNow(t);
      expect(latch.recordFailure().shouldSignal).toBe(false);
    }
    setNow(6 * MIN);
    expect(latch.recordFailure().shouldSignal).toBe(true);
  });

  it('recovery reports the streak once, then steady success is silent', () => {
    const { latch, setNow } = make(6 * MIN);
    setNow(0); latch.recordFailure();
    setNow(2 * MIN); latch.recordFailure();
    const s = latch.recordSuccess();
    expect(s.recovered).toBe(true);
    expect(s.failures).toBe(2);
    expect(latch.recordSuccess().recovered).toBe(false);
    expect(latch.recordSuccess().recovered).toBe(false);
  });

  it('a new episode after recovery signals again (full re-arm)', () => {
    const { latch, setNow } = make(4 * MIN);
    setNow(0); latch.recordFailure();
    setNow(4 * MIN);
    expect(latch.recordFailure().shouldSignal).toBe(true);
    latch.recordSuccess();
    setNow(20 * MIN);
    expect(latch.recordFailure().firstOfEpisode).toBe(true);
    setNow(24 * MIN);
    expect(latch.recordFailure().shouldSignal).toBe(true);
  });

  it('failingForMs and failures count are accurate', () => {
    const { latch, setNow } = make(100 * MIN);
    setNow(5_000); latch.recordFailure();
    setNow(5_000 + 3 * MIN);
    const f = latch.recordFailure();
    expect(f.failingForMs).toBe(3 * MIN);
    expect(f.failures).toBe(2);
  });
});

describe('wiring integrity: heartbeat writer uses the guarded path (source-shape pins)', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/core/MultiMachineCoordinator.ts'), 'utf-8');

  it('raw writeHeartbeat() calls exist ONLY in the two sanctioned sites (guarded funnel + promote-abort)', () => {
    // The timer-tick crash vector requires every PERIODIC write to go through
    // writeHeartbeatGuarded. Exactly two raw calls are sanctioned:
    // 1. inside writeHeartbeatGuarded's try (the funnel itself);
    // 2. inside promoteToAwake's abort-clean block (second-pass reviewer: a
    //    promotion that cannot write its liveness must rollback-and-rethrow,
    //    NOT silently complete) — which sits inside its own try with a
    //    role-rollback catch.
    const rawCalls = src.split('\n').filter((l) => l.includes('this.heartbeatManager.writeHeartbeat()'));
    expect(rawCalls).toHaveLength(2);
    const guardedIdx = src.indexOf('private writeHeartbeatGuarded()');
    expect(guardedIdx).toBeGreaterThan(0);
    // The promote-abort site must carry the rollback (not a bare raw call).
    const promoteIdx = src.indexOf('promotion aborted — initial heartbeat write failed');
    expect(promoteIdx).toBeGreaterThan(0);
    const rollbackIdx = src.indexOf('this._role = oldRole;');
    expect(rollbackIdx).toBeGreaterThan(0);
  });

  it('both writer call sites (boot-immediate + timer tick) use the guarded path', () => {
    const matches = src.match(/this\.writeHeartbeatGuarded\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('the episode latch is constructed and drives a DegradationReporter signal', () => {
    expect(src).toContain('new FailureEpisodeLatch({ signalAfterMs: 6 * 60_000 })');
    expect(src).toContain("feature: 'MultiMachine.heartbeatWrite'");
  });

  it('the writer is DECLARED an eternal sentinel (P19 condition 1)', () => {
    expect(src).toContain('ETERNAL SENTINEL (declared per "No Unbounded Loops" / P19)');
  });
});
