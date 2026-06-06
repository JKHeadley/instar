/**
 * Tier-1 tests for SlowRetrySentinelEscalation — the "still tells a human once"
 * half of the supervisor's Eternal Sentinel contract ("No Unbounded Loops" /
 * P19, condition 4).
 *
 * The P19 sustained-failure pattern: drive the loop against a target that
 * NEVER recovers and assert the escalation volume stays at the declared bound
 * — exactly ONE escalation per episode, no matter how many ticks run.
 */

import { describe, it, expect } from 'vitest';
import { SlowRetrySentinelEscalation } from '../../src/lifeline/SlowRetrySentinelEscalation.js';

const HOUR = 60 * 60_000;

function make(escalateAfterMs: number) {
  let nowMs = 0;
  const esc = new SlowRetrySentinelEscalation({ escalateAfterMs, now: () => nowMs });
  return { esc, setNow: (t: number) => { nowMs = t; } };
}

describe('SlowRetrySentinelEscalation', () => {
  it('does not fire before the sustained-failure threshold', () => {
    const { esc, setNow } = make(12 * HOUR);
    const episodeStart = 1_000;
    for (const t of [1_000, 2 * HOUR, 6 * HOUR, 11 * HOUR]) {
      setNow(episodeStart + t);
      expect(esc.shouldEscalate(episodeStart)).toBe(false);
    }
  });

  it('SUSTAINED-FAILURE BOUND (P19): a never-recovering episode escalates exactly ONCE across unlimited ticks', () => {
    const { esc, setNow } = make(12 * HOUR);
    const episodeStart = 1_000;
    let fired = 0;
    // A week of supervisor ticks (every 10s would be 60k ticks; sample hourly —
    // the latch is time-independent so the sampling density doesn't matter).
    for (let h = 0; h <= 24 * 7; h++) {
      setNow(episodeStart + h * HOUR);
      if (esc.shouldEscalate(episodeStart)) fired++;
    }
    expect(fired).toBe(1);
  });

  it('fires at the first tick at/after the threshold', () => {
    const { esc, setNow } = make(12 * HOUR);
    const episodeStart = 5_000;
    setNow(episodeStart + 12 * HOUR);
    expect(esc.shouldEscalate(episodeStart)).toBe(true);
  });

  it('not in slow-retry mode (episode start 0) → never fires', () => {
    const { esc, setNow } = make(1);
    setNow(Number.MAX_SAFE_INTEGER);
    expect(esc.shouldEscalate(0)).toBe(false);
  });

  it('reset() re-arms: a NEW episode after recovery escalates again', () => {
    const { esc, setNow } = make(12 * HOUR);
    const ep1 = 1_000;
    setNow(ep1 + 13 * HOUR);
    expect(esc.shouldEscalate(ep1)).toBe(true);
    esc.reset(); // recovery / operator reset
    const ep2 = ep1 + 20 * HOUR;
    setNow(ep2 + 12 * HOUR);
    expect(esc.shouldEscalate(ep2)).toBe(true);
  });

  it('a fresh episode re-arms automatically even WITHOUT reset() (episode-keyed latch)', () => {
    // Defensive: if a reset path were ever missed, a different episodeStart
    // must still escalate — the latch keys on the episode, not a boolean.
    const { esc, setNow } = make(12 * HOUR);
    const ep1 = 1_000;
    setNow(ep1 + 13 * HOUR);
    expect(esc.shouldEscalate(ep1)).toBe(true);
    const ep2 = ep1 + 30 * HOUR; // new episode, no reset() call
    setNow(ep2 + 12 * HOUR);
    expect(esc.shouldEscalate(ep2)).toBe(true);
    // ...and ep2 itself still only fires once.
    setNow(ep2 + 40 * HOUR);
    expect(esc.shouldEscalate(ep2)).toBe(false);
  });
});

describe('wiring integrity: supervisor emits, lifeline delivers (source-shape pins)', () => {
  // The full ServerSupervisor/TelegramLifeline are process-coupled (tmux,
  // launchd, Telegram API), so the wiring is pinned at source level — the same
  // pattern as the live-tail version-gate wiring pin. Without these, the pure
  // unit above is "constructed but inert".
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const supervisorSrc = fs.readFileSync(path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'), 'utf-8');
  const lifelineSrc = fs.readFileSync(path.join(process.cwd(), 'src/lifeline/TelegramLifeline.ts'), 'utf-8');

  it('the supervisor constructs the escalation, checks it in the slow-retry block, and emits sentinelStalled', () => {
    expect(supervisorSrc).toContain('new SlowRetrySentinelEscalation(');
    expect(supervisorSrc).toContain('this.sentinelEscalation.shouldEscalate(this.slowRetryStartedAt)');
    expect(supervisorSrc).toContain("this.emit('sentinelStalled'");
  });

  it('the escalation latch re-arms on circuit-breaker reset (episode end)', () => {
    const resetIdx = supervisorSrc.indexOf('resetCircuitBreaker(): void {');
    expect(resetIdx).toBeGreaterThan(0);
    const block = supervisorSrc.slice(resetIdx, resetIdx + 700);
    expect(block).toContain('this.sentinelEscalation.reset()');
  });

  it('the slow-retry loop is DECLARED an eternal sentinel (P19 condition 1)', () => {
    expect(supervisorSrc).toContain('ETERNAL SENTINEL (declared per "No Unbounded Loops" / P19)');
  });

  it('the lifeline listens for sentinelStalled and delivers the one-shot operator message', () => {
    expect(lifelineSrc).toContain("this.supervisor.on('sentinelStalled'");
    expect(lifelineSrc).toContain('notifySentinelStalled');
    expect(lifelineSrc).toContain('/lifeline reset');
  });
});
