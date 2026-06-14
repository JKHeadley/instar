/**
 * Tier-1 unit tests for HybridLogicalClock (WS2 replicated-store foundation,
 * Component 1 — build order step 1).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §3 (structure +
 * the three operations + bounded-drift + serialization/persistence), §10.2 (the
 * maxDriftMs clamp), §15 risk-6 (BLOCKER-5: fixed-constant + pool-relative
 * reference).
 *
 * This primitive is pure library code with NO route/wiring yet (its consumers
 * are later foundation steps). Unit tests are the applicable tier; integration/
 * E2E arrive when it is wired (per the §13 build order). NO route test is
 * fabricated for an unwired primitive.
 *
 * Covers, with each dangerous property exercised through the injected seams:
 *   - tick monotonicity (strictly increasing by compare); same-ms logical bump;
 *     physical never regresses on a backward wall-clock jump.
 *   - receive merge correctness for ALL FOUR physical-comparison branches;
 *     receive monotonic vs both local and remote.
 *   - compare is a strict total order: transitive, antisymmetric, node-id
 *     tie-break, equal ONLY for identical triples; adversarial equal-(physical,
 *     logical) pair orders deterministically.
 *   - skew-rejection: poison-future remote REJECTED and clock NOT advanced;
 *     legitimately-ahead remote within the bound ACCEPTED; bound clamped to
 *     [60s, 15min].
 *   - skew reference is POOL-RELATIVE: a slow local receiver does NOT reject an
 *     ahead-but-within-bound peer.
 *   - restart-monotonicity: persist, construct a FRESH instance, next tick is
 *     strictly greater than the persisted value.
 *   - serialize/parse round-trips (JSON + key form); parse rejects malformed.
 */
import { describe, it, expect } from 'vitest';
import {
  HybridLogicalClock,
  clampMaxDriftMs,
  isSkewRejection,
  serializeHlc,
  parseHlc,
  serializeHlcKey,
  parseHlcKey,
  coerceHlc,
  DEFAULT_MAX_DRIFT_MS,
  MIN_MAX_DRIFT_MS,
  MAX_MAX_DRIFT_MS,
  type HlcTimestamp,
  type HlcPersistence,
  type ReceiveResult,
} from '../../src/core/HybridLogicalClock.js';

/** A controllable injected wall clock. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** An in-memory persistence seam recording every save. */
function memPersist(seed: HlcTimestamp | null = null): HlcPersistence & {
  saves: HlcTimestamp[];
  value: HlcTimestamp | null;
} {
  const state = { value: seed, saves: [] as HlcTimestamp[] };
  return {
    saves: state.saves,
    get value() {
      return state.value;
    },
    load: () => state.value,
    save: (t: HlcTimestamp) => {
      state.value = { ...t };
      state.saves.push({ ...t });
    },
  };
}

/** Helper: assert a receive succeeded and return the merged stamp. */
function merged(r: ReceiveResult): HlcTimestamp {
  if (isSkewRejection(r)) {
    throw new Error(`expected accept, got rejection: ${JSON.stringify(r)}`);
  }
  return r.hlc;
}

const lt = (a: HlcTimestamp, b: HlcTimestamp) => HybridLogicalClock.compare(a, b) < 0;

describe('HybridLogicalClock — tick (local-event advance, §3.2.1)', () => {
  it('is strictly monotonic across repeated ticks (compare strictly increases)', () => {
    const clk = fakeClock();
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    let prev = hlc.tick();
    for (let i = 0; i < 50; i++) {
      // Advance the wall clock irregularly (sometimes 0ms, sometimes >0).
      if (i % 3 === 0) clk.advance(7);
      const next = hlc.tick();
      expect(lt(prev, next)).toBe(true);
      expect(HybridLogicalClock.compare(prev, next)).toBe(-1);
      prev = next;
    }
  });

  it('bumps logical (not physical) when two ticks land in the same physical ms', () => {
    const clk = fakeClock(5_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    const a = hlc.tick();
    const b = hlc.tick(); // same now() ⇒ logical++
    expect(b.physical).toBe(a.physical);
    expect(b.logical).toBe(a.logical + 1);
    expect(b.node).toBe('m1');
  });

  it('resets logical to 0 when the physical clock advances past last.physical', () => {
    const clk = fakeClock(5_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    // Fresh clock seeds last={physical:5000,logical:0}; the first same-ms tick
    // therefore collides and yields logical 1, the second logical 2.
    const t1 = hlc.tick();
    const t2 = hlc.tick();
    expect(t1.logical).toBe(1);
    expect(t2.logical).toBe(2);
    clk.advance(10);
    const advanced = hlc.tick();
    expect(advanced.physical).toBe(5_010);
    expect(advanced.logical).toBe(0); // physical advanced past last ⇒ reset
  });

  it('NEVER regresses physical when the wall clock jumps backward', () => {
    const clk = fakeClock(10_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    const before = hlc.tick();
    clk.set(3_000); // wall clock jumps backward
    const after = hlc.tick();
    // physical stays at the floor (10_000), logical bumps; still strictly greater.
    expect(after.physical).toBe(10_000);
    expect(after.logical).toBe(before.logical + 1);
    expect(lt(before, after)).toBe(true);
  });

  it('always stamps this clock’s own node id', () => {
    const clk = fakeClock();
    const hlc = new HybridLogicalClock({ node: 'machine-xyz', now: clk.now });
    expect(hlc.tick().node).toBe('machine-xyz');
  });
});

describe('HybridLogicalClock — receive (merge, §3.2.2) — all four branches', () => {
  it('branch A: pt === last === remote → logical = max(last,remote)+1', () => {
    const clk = fakeClock(2_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    // Fresh clock seeds {2000,0}; five same-ms ticks ⇒ last.logical = 5.
    for (let i = 0; i < 5; i++) hlc.tick();
    expect(hlc.current()).toMatchObject({ physical: 2_000, logical: 5 });
    // now() === last.physical === remote.physical === 2_000.
    const out = merged(hlc.receive({ physical: 2_000, logical: 9, node: 'm2' }));
    expect(out.physical).toBe(2_000);
    expect(out.logical).toBe(Math.max(5, 9) + 1); // 10
    expect(out.node).toBe('m1');
  });

  it('branch B: pt === last only → logical = last+1', () => {
    const clk = fakeClock(8_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    hlc.tick(); // fresh {8000,0} + same-ms tick ⇒ last = {8000, 1}
    hlc.tick(); // last = {8000, 2}
    // remote is OLDER (physical 5000), now() === last.physical === 8000.
    const out = merged(hlc.receive({ physical: 5_000, logical: 99, node: 'm2' }));
    expect(out.physical).toBe(8_000);
    expect(out.logical).toBe(2 + 1); // last.logical(2)+1
  });

  it('branch C: pt === remote only → logical = remote+1', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    hlc.tick(); // last = {1000, 0}
    // remote is AHEAD but within the default drift bound; now() < remote.physical.
    const remotePhysical = 1_000 + 30_000; // +30s, within 5min default
    const out = merged(hlc.receive({ physical: remotePhysical, logical: 7, node: 'm2' }));
    expect(out.physical).toBe(remotePhysical);
    expect(out.logical).toBe(7 + 1);
  });

  it('branch D: pt from now() alone (ahead of both last and remote) → logical = 0', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    hlc.tick(); // last = {1000, 5..} -> {1000,0}
    clk.set(20_000); // now() ahead of both last(1000) and remote(2000)
    const out = merged(hlc.receive({ physical: 2_000, logical: 3, node: 'm2' }));
    expect(out.physical).toBe(20_000);
    expect(out.logical).toBe(0);
  });

  it('receive is monotonic vs the LOCAL clock (strictly greater than prior last)', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    const beforeTick = hlc.tick();
    const out = merged(hlc.receive({ physical: 1_000, logical: 0, node: 'm2' }));
    expect(lt(beforeTick, out)).toBe(true);
  });

  it('receive result is >= the REMOTE stamp by physical (never goes below remote)', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    hlc.tick();
    const remote: HlcTimestamp = { physical: 1_000 + 60_000, logical: 2, node: 'm2' };
    const out = merged(hlc.receive(remote));
    expect(out.physical).toBeGreaterThanOrEqual(remote.physical);
    // and the merged stamp causally dominates the remote.
    expect(lt(remote, out) || HybridLogicalClock.compare(remote, out) === 0).toBe(true);
  });

  it('a sequence of receives stays strictly increasing on the local clock', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    let prev = hlc.tick();
    const remotes: HlcTimestamp[] = [
      { physical: 1_000, logical: 0, node: 'm2' },
      { physical: 1_000, logical: 50, node: 'm3' },
      { physical: 1_010, logical: 0, node: 'm2' },
      { physical: 999, logical: 999, node: 'm4' }, // older — must still advance us
    ];
    for (const r of remotes) {
      const out = merged(hlc.receive(r));
      expect(lt(prev, out)).toBe(true);
      prev = out;
    }
  });
});

describe('HybridLogicalClock.compare — strict total order (§3.3)', () => {
  it('orders by physical first', () => {
    expect(
      HybridLogicalClock.compare(
        { physical: 1, logical: 99, node: 'z' },
        { physical: 2, logical: 0, node: 'a' },
      ),
    ).toBe(-1);
  });

  it('orders by logical when physical ties', () => {
    expect(
      HybridLogicalClock.compare(
        { physical: 5, logical: 1, node: 'z' },
        { physical: 5, logical: 2, node: 'a' },
      ),
    ).toBe(-1);
  });

  it('orders by node (lexicographic) when physical AND logical tie', () => {
    // Adversarial: equal physical+logical, different node ⇒ deterministic order.
    const a: HlcTimestamp = { physical: 5, logical: 2, node: 'aaa' };
    const b: HlcTimestamp = { physical: 5, logical: 2, node: 'bbb' };
    expect(HybridLogicalClock.compare(a, b)).toBe(-1);
    expect(HybridLogicalClock.compare(b, a)).toBe(1);
  });

  it('returns 0 ONLY for an identical triple', () => {
    const t: HlcTimestamp = { physical: 5, logical: 2, node: 'm1' };
    expect(HybridLogicalClock.compare(t, { ...t })).toBe(0);
    // Any single field differing ⇒ never 0.
    expect(HybridLogicalClock.compare(t, { ...t, physical: 6 })).not.toBe(0);
    expect(HybridLogicalClock.compare(t, { ...t, logical: 3 })).not.toBe(0);
    expect(HybridLogicalClock.compare(t, { ...t, node: 'm2' })).not.toBe(0);
  });

  it('is antisymmetric: compare(a,b) === -compare(b,a) for distinct stamps', () => {
    const samples: HlcTimestamp[] = [
      { physical: 1, logical: 0, node: 'a' },
      { physical: 1, logical: 0, node: 'b' },
      { physical: 1, logical: 5, node: 'a' },
      { physical: 9, logical: 0, node: 'a' },
      { physical: 9, logical: 9, node: 'zzz' },
    ];
    for (const a of samples) {
      for (const b of samples) {
        const ab = HybridLogicalClock.compare(a, b);
        const ba = HybridLogicalClock.compare(b, a);
        // `-0 + 0` normalizes the JS negative-zero quirk so toBe (Object.is) holds.
        expect(ab).toBe(((-ba) + 0) as -1 | 0 | 1);
      }
    }
  });

  it('is transitive and yields a consistent sort (a<b<c ⇒ a<c)', () => {
    const stamps: HlcTimestamp[] = [
      { physical: 9, logical: 9, node: 'zzz' },
      { physical: 1, logical: 0, node: 'b' },
      { physical: 1, logical: 0, node: 'a' },
      { physical: 1, logical: 5, node: 'a' },
      { physical: 9, logical: 0, node: 'a' },
      { physical: 5, logical: 5, node: 'm' },
    ];
    const sorted = [...stamps].sort(HybridLogicalClock.compare);
    // Verify the order is a genuine total order: every adjacent pair is < and
    // transitivity holds across all triples.
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(HybridLogicalClock.compare(sorted[i], sorted[i + 1])).toBe(-1);
    }
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        for (let k = j + 1; k < sorted.length; k++) {
          // sorted[i] < sorted[j] < sorted[k] ⇒ sorted[i] < sorted[k]
          expect(HybridLogicalClock.compare(sorted[i], sorted[k])).toBe(-1);
        }
      }
    }
    // Deterministic regardless of input order: shuffled input ⇒ same sorted output.
    const shuffled = [stamps[3], stamps[0], stamps[5], stamps[1], stamps[4], stamps[2]];
    const sorted2 = [...shuffled].sort(HybridLogicalClock.compare);
    expect(sorted2).toEqual(sorted);
  });
});

describe('HybridLogicalClock — bounded-drift / skew rejection (§3.4)', () => {
  it('REJECTS a poison-future remote and does NOT advance the clock', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    const before = hlc.tick();
    const drift = hlc.getMaxDriftMs();
    // remote.physical far beyond reference + maxDriftMs.
    const poison: HlcTimestamp = { physical: 1_000 + drift + 10_000, logical: 0, node: 'evil' };
    const res = hlc.receive(poison);
    expect(isSkewRejection(res)).toBe(true);
    if (isSkewRejection(res)) {
      expect(res.reason).toBe('skew-ahead');
      expect(res.remote).toEqual(poison);
      expect(res.maxDriftMs).toBe(drift);
    }
    // Clock unchanged — a fast peer cannot drag us into the future.
    expect(hlc.current()).toEqual(before);
  });

  it('ACCEPTS a legitimately-ahead remote that is within the bound', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    hlc.tick();
    const drift = hlc.getMaxDriftMs();
    // remote ahead but inside the bound (reference is last.physical = 1000).
    const ahead: HlcTimestamp = { physical: 1_000 + drift - 1, logical: 0, node: 'm2' };
    const out = merged(hlc.receive(ahead));
    expect(out.physical).toBe(ahead.physical);
  });

  it('accepts exactly at the bound (reference + maxDriftMs) and rejects one past it', () => {
    const clk = fakeClock(1_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    // last.physical = 1000 after a single tick at now()=1000.
    hlc.tick();
    const drift = hlc.getMaxDriftMs();
    const reference = 1_000; // = last.physical, > poolReference(0)
    const atBound: HlcTimestamp = { physical: reference + drift, logical: 0, node: 'm2' };
    expect(isSkewRejection(hlc.receive(atBound))).toBe(false); // exactly at bound is allowed (> is the reject)
    const past: HlcTimestamp = { physical: reference + drift + 1, logical: 0, node: 'm3' };
    // Note: after accepting atBound, last.physical jumped to reference+drift, so
    // re-measure against a fresh clock to isolate the boundary.
    const fresh = new HybridLogicalClock({ node: 'm1', now: () => 1_000 });
    fresh.tick();
    expect(isSkewRejection(fresh.receive(past))).toBe(true);
  });

  it('an OLD remote (at/below reference) is NORMAL and accepted (slow peer)', () => {
    const clk = fakeClock(100_000);
    const hlc = new HybridLogicalClock({ node: 'm1', now: clk.now });
    hlc.tick(); // last.physical = 100_000
    const old: HlcTimestamp = { physical: 5, logical: 0, node: 'slow' };
    const out = merged(hlc.receive(old));
    // accepted; merged stamp keeps OUR floor (100_000), not the old physical.
    expect(out.physical).toBe(100_000);
  });
});

describe('HybridLogicalClock — POOL-RELATIVE reference (§3.4, BLOCKER-5)', () => {
  it('a SLOW receiver does NOT reject an ahead-but-within-bound peer (poolReference floor)', () => {
    // Receiver's wall clock is far behind real time, and it has no recent durable
    // stamp ahead of now() — but the pool reference (heartbeat median) is current.
    const slowNow = () => 1_000; // receiver NTP is way behind
    const hlc = new HybridLogicalClock({ node: 'slow-receiver', now: slowNow });
    // Fresh clock: last.physical = now() = 1_000.
    const drift = hlc.getMaxDriftMs();
    const poolReference = 1_000_000; // the real pool time, far ahead of slowNow()
    // A peer at pool time is ~999_000 ahead of the receiver's bare now() — far past
    // maxDriftMs (5min = 300_000). Against bare now() this WOULD be rejected.
    const peer: HlcTimestamp = { physical: poolReference + 1_000, logical: 0, node: 'healthy-peer' };
    expect(peer.physical - slowNow()).toBeGreaterThan(drift); // confirm the trap

    // WITHOUT the pool reference, the slow receiver rejects (proves the bug exists
    // if we used bare now()).
    const naive = hlc.receive(peer);
    expect(isSkewRejection(naive)).toBe(true);

    // WITH the pool reference, the same peer is accepted — the legitimate case.
    const hlc2 = new HybridLogicalClock({ node: 'slow-receiver', now: slowNow });
    const ok = hlc2.receive(peer, { poolReference });
    expect(isSkewRejection(ok)).toBe(false);
    expect(merged(ok).physical).toBe(peer.physical);
  });

  it('still rejects a peer that is past the bound EVEN with the pool reference', () => {
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 1_000 });
    const drift = hlc.getMaxDriftMs();
    const poolReference = 1_000_000;
    const poison: HlcTimestamp = { physical: poolReference + drift + 1, logical: 0, node: 'evil' };
    const res = hlc.receive(poison, { poolReference });
    expect(isSkewRejection(res)).toBe(true);
    if (isSkewRejection(res)) expect(res.reference).toBe(poolReference);
  });

  it('uses max(last.physical, poolReference) as the reference', () => {
    // last.physical exceeds poolReference ⇒ last.physical wins as the floor.
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 5_000_000 });
    hlc.tick(); // last.physical = 5_000_000
    const drift = hlc.getMaxDriftMs();
    const peer: HlcTimestamp = { physical: 5_000_000 + drift - 1, logical: 0, node: 'm2' };
    // poolReference is LOWER than last.physical — must not lower the floor.
    expect(isSkewRejection(hlc.receive(peer, { poolReference: 1 }))).toBe(false);
  });
});

describe('clampMaxDriftMs — the [60s, 15min] clamp (§3.4 / §10.2)', () => {
  it('clamps a too-small value up to the 60s floor', () => {
    expect(clampMaxDriftMs(1_000)).toBe(MIN_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(0)).toBe(MIN_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(MIN_MAX_DRIFT_MS - 1)).toBe(MIN_MAX_DRIFT_MS);
  });

  it('clamps a too-large value down to the 15min ceiling', () => {
    expect(clampMaxDriftMs(60 * 60 * 1000)).toBe(MAX_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(MAX_MAX_DRIFT_MS + 1)).toBe(MAX_MAX_DRIFT_MS);
  });

  it('passes an in-range value through unchanged', () => {
    expect(clampMaxDriftMs(DEFAULT_MAX_DRIFT_MS)).toBe(DEFAULT_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(MIN_MAX_DRIFT_MS)).toBe(MIN_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(MAX_MAX_DRIFT_MS)).toBe(MAX_MAX_DRIFT_MS);
  });

  it('falls back to the default for undefined / non-finite input', () => {
    expect(clampMaxDriftMs(undefined)).toBe(DEFAULT_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(NaN)).toBe(DEFAULT_MAX_DRIFT_MS);
    expect(clampMaxDriftMs(Infinity)).toBe(DEFAULT_MAX_DRIFT_MS);
  });

  it('the clock applies the clamp: a below-floor config rejects at the floor bound, not the raw value', () => {
    // Config 1_000ms would be far too tight; the clock must clamp to 60s.
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 1_000, maxDriftMs: 1_000 });
    expect(hlc.getMaxDriftMs()).toBe(MIN_MAX_DRIFT_MS);
    // A remote 30s ahead would be REJECTED under 1_000ms but ACCEPTED under 60s.
    const peer: HlcTimestamp = { physical: 1_000 + 30_000, logical: 0, node: 'm2' };
    expect(isSkewRejection(hlc.receive(peer))).toBe(false);
  });

  it('the clock applies the clamp: an above-ceiling config caps at 15min', () => {
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 1_000, maxDriftMs: 60 * 60 * 1000 });
    expect(hlc.getMaxDriftMs()).toBe(MAX_MAX_DRIFT_MS);
    // A remote 20min ahead would be allowed under 1h but must be REJECTED under 15min.
    const peer: HlcTimestamp = { physical: 1_000 + 20 * 60 * 1000, logical: 0, node: 'm2' };
    expect(isSkewRejection(hlc.receive(peer))).toBe(true);
  });
});

describe('HybridLogicalClock — restart-monotonicity (§3.5 persistence)', () => {
  it('seeds last from the persisted stamp; next tick is strictly greater', () => {
    const persist = memPersist();
    const clk1 = fakeClock(1_000);
    const hlc1 = new HybridLogicalClock({ node: 'm1', now: clk1.now, persist });
    let issued: HlcTimestamp = hlc1.tick();
    for (let i = 0; i < 4; i++) issued = hlc1.tick(); // drive logical up at the same ms
    expect(persist.value).toEqual(issued);

    // Simulate a restart: a FRESH instance loading the persisted stamp, even with
    // the wall clock having regressed below the persisted physical.
    const clk2 = fakeClock(500); // wall clock came back behind the persisted stamp
    const hlc2 = new HybridLogicalClock({ node: 'm1', now: clk2.now, persist });
    expect(hlc2.current()).toMatchObject({ physical: issued.physical, logical: issued.logical });
    const afterRestart = hlc2.tick();
    expect(HybridLogicalClock.compare(issued, afterRestart)).toBe(-1);
    expect(afterRestart.physical).toBe(issued.physical); // floor held against regressed wall
    expect(afterRestart.logical).toBe(issued.logical + 1);
  });

  it('persists on EVERY advance (tick and receive both save)', () => {
    const persist = memPersist();
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 1_000, persist });
    hlc.tick();
    expect(persist.saves.length).toBe(1);
    hlc.receive({ physical: 1_000, logical: 0, node: 'm2' });
    expect(persist.saves.length).toBe(2);
    // A REJECTED receive does NOT persist (the clock did not advance).
    hlc.receive({ physical: 1_000 + hlc.getMaxDriftMs() + 1, logical: 0, node: 'evil' });
    expect(persist.saves.length).toBe(2);
  });

  it('a fresh clock with no persisted stamp starts at { now(), 0, node }', () => {
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 42_000, persist: memPersist(null) });
    expect(hlc.current()).toEqual({ physical: 42_000, logical: 0, node: 'm1' });
  });

  it('a CORRUPT (non-null malformed) persisted stamp degrades to a fresh-but-monotonic clock, not a crash (§3.5)', () => {
    // A persistence layer that returns a poisoned/partially-written row. coerceHlc
    // throws on each of these; the constructor must catch and fail TOWARD a fresh
    // clock seeded from now() — never let the throw escape construction.
    const corruptCases: Array<{ label: string; load: () => unknown }> = [
      { label: 'negative physical', load: () => ({ physical: -1, logical: 0, node: 'm1' }) },
      { label: 'non-integer physical', load: () => ({ physical: 1.5, logical: 0, node: 'm1' }) },
      { label: 'missing node', load: () => ({ physical: 1, logical: 0 }) },
      { label: 'empty node', load: () => ({ physical: 1, logical: 0, node: '' }) },
      { label: 'negative logical', load: () => ({ physical: 1, logical: -3, node: 'm1' }) },
      { label: 'non-object string', load: () => 'totally-not-a-stamp' },
      { label: 'non-object number', load: () => 12345 },
      { label: 'array (object but not a stamp)', load: () => [1, 2, 3] },
    ];

    for (const { label, load } of corruptCases) {
      const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
      // Cast through unknown: a real persistence layer can return anything off disk.
      const corruptPersist: HlcPersistence = {
        load: load as unknown as () => HlcTimestamp | null,
        save: () => {},
      };

      let hlc: HybridLogicalClock | undefined;
      expect(() => {
        hlc = new HybridLogicalClock({
          node: 'm1',
          now: () => 99_000,
          persist: corruptPersist,
          log: (event, detail) => logs.push({ event, detail }),
        });
      }, `corrupt case "${label}" must not throw out of the constructor`).not.toThrow();

      // Degraded to a fresh clock seeded from now() — usable, not bricked.
      expect(hlc!.current(), `corrupt case "${label}"`).toEqual({
        physical: 99_000,
        logical: 0,
        node: 'm1',
      });
      // Logged exactly once so the corruption is observable.
      const corruptLogs = logs.filter((l) => l.event === 'hlc-load-corrupt');
      expect(corruptLogs.length, `corrupt case "${label}" should log once`).toBe(1);

      // The fresh clock is fully usable + monotonic from its seed.
      const t1 = hlc!.tick();
      expect(t1.physical).toBe(99_000);
      expect(t1.logical).toBe(1); // same ms ⇒ logical bump from the fresh { 99_000, 0 }
      const t2 = hlc!.tick();
      expect(HybridLogicalClock.compare(t1, t2)).toBe(-1);
    }
  });

  it('honors the durable floor + logs once when loaded physical is ahead of wall by > maxDriftMs', () => {
    const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const persist = memPersist({ physical: 10_000_000, logical: 3, node: 'm1' });
    const hlc = new HybridLogicalClock({
      node: 'm1',
      now: () => 1_000, // wall far behind the durable stamp
      persist,
      log: (event, detail) => logs.push({ event, detail }),
    });
    // The durable floor is honored — the next tick is still > the loaded stamp.
    const next = hlc.tick();
    expect(next.physical).toBe(10_000_000);
    expect(next.logical).toBe(4);
    expect(logs.some((l) => l.event === 'hlc-load-ahead-of-wall')).toBe(true);
  });

  it('the persisted stamp is always re-stamped with THIS node (origin tag integrity)', () => {
    // A loaded stamp authored by a different node id is re-homed to this clock's
    // node — the clock only ever issues its OWN node's stamps.
    const persist = memPersist({ physical: 5_000, logical: 2, node: 'other-machine' });
    const hlc = new HybridLogicalClock({ node: 'this-machine', now: () => 5_000, persist });
    expect(hlc.current().node).toBe('this-machine');
    expect(hlc.tick().node).toBe('this-machine');
  });
});

describe('HybridLogicalClock — serialization (§3.5)', () => {
  it('JSON serialize/parse round-trips', () => {
    const t: HlcTimestamp = { physical: 1_700_000_000_123, logical: 7, node: 'mac-mini' };
    expect(parseHlc(serializeHlc(t))).toEqual(t);
  });

  it('key-string serialize/parse round-trips', () => {
    const t: HlcTimestamp = { physical: 1_700_000_000_123, logical: 7, node: 'mac-mini' };
    expect(serializeHlcKey(t)).toBe('1700000000123:7:mac-mini');
    expect(parseHlcKey(serializeHlcKey(t))).toEqual(t);
  });

  it('key-string round-trips even when the node id CONTAINS colons', () => {
    const t: HlcTimestamp = { physical: 9, logical: 0, node: 'host:port:weird' };
    const key = serializeHlcKey(t);
    expect(key).toBe('9:0:host:port:weird');
    expect(parseHlcKey(key)).toEqual(t); // split on first two colons only
  });

  it('JSON parse rejects malformed input', () => {
    expect(() => parseHlc('not json')).toThrow();
    expect(() => parseHlc('null')).toThrow();
    expect(() => parseHlc('{}')).toThrow();
    expect(() => parseHlc('{"physical":1,"logical":0}')).toThrow(); // missing node
    expect(() => parseHlc('{"physical":-1,"logical":0,"node":"m"}')).toThrow(); // negative
    expect(() => parseHlc('{"physical":1.5,"logical":0,"node":"m"}')).toThrow(); // non-integer
    expect(() => parseHlc('{"physical":1,"logical":0,"node":""}')).toThrow(); // empty node
  });

  it('key parse rejects malformed input', () => {
    expect(() => parseHlcKey('only-one-part')).toThrow();
    expect(() => parseHlcKey('1:2')).toThrow(); // no node segment
    expect(() => parseHlcKey('abc:2:node')).toThrow(); // non-numeric physical
    expect(() => parseHlcKey('1:xyz:node')).toThrow(); // non-numeric logical
  });

  it('coerceHlc is the single validation chokepoint', () => {
    expect(coerceHlc({ physical: 1, logical: 2, node: 'm' })).toEqual({ physical: 1, logical: 2, node: 'm' });
    expect(() => coerceHlc(null)).toThrow();
    expect(() => coerceHlc({ physical: 'x', logical: 0, node: 'm' })).toThrow();
  });

  it('receive narrows untrusted remote input through coerceHlc', () => {
    const hlc = new HybridLogicalClock({ node: 'm1', now: () => 1_000 });
    // A malformed remote (negative physical) is rejected at the door.
    expect(() => hlc.receive({ physical: -5, logical: 0, node: 'm2' } as HlcTimestamp)).toThrow();
  });
});
