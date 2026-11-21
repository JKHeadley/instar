/**
 * stall-wake-lease-reconfirm — the pure rule (fb-fdb55c1c-a79). Both sides of every boundary:
 * the gap threshold and lost-time accounting, the switch resolution, and the two ways a held
 * claim is released (one TTL awake with a completed fresh round; the chain cap).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateStallReconfirm,
  resolveStallReconfirm,
  stallGapMsFor,
  awakeGapMs,
  lostInGapMs,
  lostWithinMs,
  STALL_CHAIN_CAP_TTLS,
  type StallReconfirmInput,
} from '../../src/core/StallReconfirm.js';

const TTL = 60_000;
const OPEN = 1_000_000;
const input = (over: Partial<StallReconfirmInput> = {}): StallReconfirmInput => ({
  nowMs: OPEN + 1_000,
  episodeOpenedAtMs: OPEN,
  ttlMs: TTL,
  holderId: 'studio',
  freshRoundCompleted: true,
  ...over,
});

describe('gap threshold and switch', () => {
  it('opens above 30% of the TTL (18 s at 60 s), with a 5 s floor never above TTL/2, and an override clamped to [1 s, TTL/2]', () => {
    expect(stallGapMsFor(60_000)).toBe(18_000);
    expect(stallGapMsFor(20_000)).toBe(6_000);
    expect(stallGapMsFor(6_000)).toBe(3_000); // the 5 s floor never exceeds TTL/2
    expect(stallGapMsFor(60_000, 20_000)).toBe(20_000);
    expect(stallGapMsFor(60_000, 50_000)).toBe(30_000); // clamped: above TTL/2 it could never fire in time
    expect(stallGapMsFor(60_000, 500)).toBe(1_000); // clamped up to 1 s, never ignored
    expect(resolveStallReconfirm({ multiMachine: { takeoverReadyPool: { stallReconfirm: { enabled: true, stallGapMs: 500 } } } }).stallGapMs).toBe(500);
  });
  it('the gap is the larger of the wall and monotonic deltas, never negative', () => {
    expect(awakeGapMs({ wallMs: 0, monoMs: 0 }, { wallMs: 226_000, monoMs: 2_000 })).toBe(226_000); // a sleep the mono clock skipped
    expect(awakeGapMs({ wallMs: 0, monoMs: 0 }, { wallMs: -50_000, monoMs: 226_000 })).toBe(226_000); // a wall step back
    expect(awakeGapMs({ wallMs: 10, monoMs: 10 }, { wallMs: 5, monoMs: 5 })).toBe(0);
  });
  it('lost time: an ordinary gap loses nothing; a gap of 6 s or more counts whole (the folded lease ages by all of it)', () => {
    expect(lostInGapMs(2_000)).toBe(0);
    expect(lostInGapMs(5_999)).toBe(0);
    expect(lostInGapMs(6_000)).toBe(6_000);
    expect(lostInGapMs(226_000)).toBe(226_000);
  });
  it('lost time sums only inside the window', () => {
    const samples = [{ atMs: 0, lostMs: 10_000 }, { atMs: 30_000, lostMs: 9_000 }, { atMs: 59_000, lostMs: 8_000 }];
    expect(lostWithinMs(samples, 60_000, 60_000)).toBe(27_000);
    expect(lostWithinMs(samples, 61_000, 60_000)).toBe(17_000);
  });
  it('is dark unless explicitly on; the project rollback turns it off', () => {
    expect(resolveStallReconfirm(undefined).enabled).toBe(false);
    expect(resolveStallReconfirm({ multiMachine: { takeoverReadyPool: {} } }).enabled).toBe(false);
    expect(resolveStallReconfirm({ multiMachine: { takeoverReadyPool: { enabled: true } } }).enabled).toBe(false);
    expect(resolveStallReconfirm({ multiMachine: { takeoverReadyPool: { stallReconfirm: { enabled: true } } } }).enabled).toBe(true);
    expect(resolveStallReconfirm({ multiMachine: { takeoverReadyPool: { enabled: false, stallReconfirm: { enabled: true } } } }).enabled).toBe(false);
  });
});

describe('holding and releasing a claim after a stall', () => {
  it('tonight: right after the wake the claim is held', () => {
    const v = evaluateStallReconfirm(input());
    expect(v.claim).toBe(false);
    expect(v.rule).toBe('waiting');
  });

  it('one TTL awake with a completed fresh round releases it; one ms less, or no completed round, does not', () => {
    expect(evaluateStallReconfirm(input({ nowMs: OPEN + TTL - 1 })).claim).toBe(false);
    expect(evaluateStallReconfirm(input({ nowMs: OPEN + TTL }))).toMatchObject({ claim: true, rule: 'awake-ttl' });
    const noRound = evaluateStallReconfirm(input({ nowMs: OPEN + TTL, freshRoundCompleted: false }));
    expect(noRound.claim).toBe(false);
    expect(noRound.reason).toMatch(/no fresh pull round completed/);
  });

  it('awake time only: a smaller loss inside the episode pushes the deadline out', () => {
    expect(evaluateStallReconfirm(input({ nowMs: OPEN + TTL, lostSinceOpenMs: 23_000 })).claim).toBe(false);
    expect(evaluateStallReconfirm(input({ nowMs: OPEN + TTL + 23_000, lostSinceOpenMs: 23_000 })).rule).toBe('awake-ttl');
  });

  it('the availability bound: a chain of re-opens holds at most ten TTLs of monotonic time, and still needs a completed round', () => {
    const cap = STALL_CHAIN_CAP_TTLS * TTL;
    expect(evaluateStallReconfirm(input({ chainAwakeMs: cap - 1 })).claim).toBe(false);
    expect(evaluateStallReconfirm(input({ chainAwakeMs: cap })).rule).toBe('chain-cap');
    expect(evaluateStallReconfirm(input({ chainAwakeMs: cap, freshRoundCompleted: false })).claim).toBe(false);
  });

  it('a released, empty or own view is decided the same way (no holder to probe)', () => {
    for (const holderId of ['', 'laptop']) {
      expect(evaluateStallReconfirm(input({ holderId })).claim).toBe(false);
      expect(evaluateStallReconfirm(input({ holderId, nowMs: OPEN + TTL })).rule).toBe('awake-ttl');
    }
  });
});
