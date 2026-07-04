import { describe, it, expect } from 'vitest';
import {
  recordKill,
  isBreakerTripped,
  killCountInWindow,
  shouldEvictInFlight,
  isInFlight,
  EMPTY_KILL_LEDGER,
  type KillLedgerState,
  type BreakerOpts,
  type InFlightKill,
} from '../../src/monitoring/ExternalHogKillLedger.js';

/**
 * ExternalHogKillLedger — the P19 loop brakes (CMT-1901, §6). Stops the #863 kill-respawn
 * loop: after K kills of the same signature in a window, STOP killing it; a volatile key
 * falls back to a CLASS-level breaker; the in-flight set prevents re-killing a SIGTERM'd pid.
 */

const HOUR = 3_600_000;
const opts = (over: Partial<BreakerOpts> = {}): BreakerOpts => ({
  nowMs: 1_000_000,
  windowMs: HOUR,
  maxPerWindow: 3,
  keyIsVolatile: false,
  ...over,
});

function ledgerWith(...records: Array<{ key: string; classId: string; atMs: number }>): KillLedgerState {
  return { records };
}

describe('recordKill — append + prune (bounded ledger)', () => {
  it('appends a new record', () => {
    const s = recordKill(EMPTY_KILL_LEDGER, { key: 'k1', classId: 'c', atMs: 1000 }, HOUR, 1000);
    expect(s.records).toHaveLength(1);
  });
  it('prunes records older than the retention bound (never grows unbounded)', () => {
    const old = ledgerWith({ key: 'k1', classId: 'c', atMs: 0 });
    const s = recordKill(old, { key: 'k1', classId: 'c', atMs: HOUR + 1 }, HOUR, HOUR + 1);
    // The atMs:0 record is older than (now - retention) → pruned; only the new one remains.
    expect(s.records).toHaveLength(1);
    expect(s.records[0]!.atMs).toBe(HOUR + 1);
  });
});

describe('isBreakerTripped — respawn breaker (per-key)', () => {
  it('does NOT trip below K kills in the window', () => {
    const s = ledgerWith(
      { key: 'k', classId: 'c', atMs: 999_000 },
      { key: 'k', classId: 'c', atMs: 999_500 },
    );
    expect(isBreakerTripped(s, 'k', 'c', opts())).toBe(false);
  });
  it('TRIPS at K kills of the same key within the window', () => {
    const s = ledgerWith(
      { key: 'k', classId: 'c', atMs: 999_000 },
      { key: 'k', classId: 'c', atMs: 999_300 },
      { key: 'k', classId: 'c', atMs: 999_600 },
    );
    expect(isBreakerTripped(s, 'k', 'c', opts())).toBe(true);
  });
  it('ignores kills OUTSIDE the rolling window', () => {
    const s = ledgerWith(
      { key: 'k', classId: 'c', atMs: 1_000_000 - HOUR - 1 }, // just outside
      { key: 'k', classId: 'c', atMs: 999_000 },
      { key: 'k', classId: 'c', atMs: 999_500 },
    );
    expect(isBreakerTripped(s, 'k', 'c', opts())).toBe(false); // only 2 in-window
  });
  it('does NOT trip for a DIFFERENT key (one decoy cannot shield another key)', () => {
    const s = ledgerWith(
      { key: 'decoy', classId: 'c', atMs: 999_000 },
      { key: 'decoy', classId: 'c', atMs: 999_300 },
      { key: 'decoy', classId: 'c', atMs: 999_600 },
    );
    expect(isBreakerTripped(s, 'real-hog', 'c', opts())).toBe(false);
  });
});

describe('isBreakerTripped — volatile-key fallback (CLASS-level breaker)', () => {
  it('counts by CLASS when the key is volatile (a per-volatile-key breaker could never trip)', () => {
    // Three DISTINCT volatile keys of the same class → the class breaker trips (bounded loop),
    // even though no single key reached K.
    const s = ledgerWith(
      { key: 'vol-a', classId: 'exthost', atMs: 999_000 },
      { key: 'vol-b', classId: 'exthost', atMs: 999_300 },
      { key: 'vol-c', classId: 'exthost', atMs: 999_600 },
    );
    expect(isBreakerTripped(s, 'vol-d', 'exthost', opts({ keyIsVolatile: true }))).toBe(true);
    // The SAME data does NOT trip a per-key breaker (this is why volatile falls back to class).
    expect(isBreakerTripped(s, 'vol-d', 'exthost', opts({ keyIsVolatile: false }))).toBe(false);
  });
});

describe('isBreakerTripped — fails toward the SAFE direction (trip) on bad window inputs', () => {
  it('a non-finite window/now TRIPS (stop killing rather than risk an unbounded loop)', () => {
    expect(isBreakerTripped(EMPTY_KILL_LEDGER, 'k', 'c', opts({ nowMs: NaN }))).toBe(true);
    expect(isBreakerTripped(EMPTY_KILL_LEDGER, 'k', 'c', opts({ windowMs: Infinity }))).toBe(true);
  });
  it('a NON-POSITIVE window TRIPS (round-11: ≤0 is finite but nonsensical → do NOT slip to not-tripped)', () => {
    // The dangerous case the guard now closes: a 0/negative window would make since>=now and
    // collapse the count to ~0 → spurious not-tripped → unbounded loop. Must TRIP instead.
    expect(isBreakerTripped(EMPTY_KILL_LEDGER, 'k', 'c', opts({ windowMs: 0 }))).toBe(true);
    expect(isBreakerTripped(EMPTY_KILL_LEDGER, 'k', 'c', opts({ windowMs: -1 }))).toBe(true);
    expect(isBreakerTripped(EMPTY_KILL_LEDGER, 'k', 'c', opts({ maxPerWindow: 0 }))).toBe(true);
  });
});

describe('recordKill precondition — retention == window still trips at K', () => {
  it('with retentionMs == windowMs, K kills within the window still trip (no undercount)', () => {
    // Accumulate 3 kills across a full HOUR window with retention == window; the breaker must
    // still see all 3 in-window records and trip (documents the retention >= window precondition).
    let s = EMPTY_KILL_LEDGER;
    s = recordKill(s, { key: 'k', classId: 'c', atMs: 1_000_000 - HOUR + 1 }, HOUR, 1_000_000 - HOUR + 1);
    s = recordKill(s, { key: 'k', classId: 'c', atMs: 999_500 }, HOUR, 999_500);
    s = recordKill(s, { key: 'k', classId: 'c', atMs: 1_000_000 }, HOUR, 1_000_000);
    expect(isBreakerTripped(s, 'k', 'c', opts({ nowMs: 1_000_000 }))).toBe(true);
  });
});

describe('killCountInWindow — for the degradation message', () => {
  it('counts in-window kills of a key', () => {
    const s = ledgerWith(
      { key: 'k', classId: 'c', atMs: 999_000 },
      { key: 'k', classId: 'c', atMs: 999_600 },
    );
    expect(killCountInWindow(s, 'k', 'c', opts())).toBe(2);
  });
});

describe('in-flight kill set — no re-kill of a SIGTERM d pid; TTL eviction', () => {
  const entry: InFlightKill = { pid: 123, startTime: 'T', sigtermAtMs: 1_000_000 };
  it('a pid+start-time already in-flight is detected (must not re-kill this scan)', () => {
    expect(isInFlight([entry], 123, 'T')).toBe(true);
    expect(isInFlight([entry], 123, 'DIFFERENT-START')).toBe(false); // pid reuse → not the same target
    expect(isInFlight([entry], 999, 'T')).toBe(false);
  });
  it('evicts on CONFIRMED exit immediately', () => {
    expect(shouldEvictInFlight(entry, 1_000_100, 36_000, true)).toBe(true);
  });
  it('does NOT evict before the TTL (so a not-yet-dead mid-write LS is not re-killed early)', () => {
    expect(shouldEvictInFlight(entry, 1_000_000 + 20_000, 36_000, false)).toBe(false);
  });
  it('evicts once the TTL elapses', () => {
    expect(shouldEvictInFlight(entry, 1_000_000 + 36_000, 36_000, false)).toBe(true);
  });
  it('evicts on a non-finite timestamp (never leaks the set)', () => {
    expect(shouldEvictInFlight(entry, NaN, 36_000, false)).toBe(true);
    expect(shouldEvictInFlight({ ...entry, sigtermAtMs: NaN }, 1_000_100, 36_000, false)).toBe(true);
  });
});
