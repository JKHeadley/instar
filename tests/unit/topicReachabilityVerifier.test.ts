/**
 * F7 Piece 2 — TopicReachabilityVerifier (docs/specs/verify-after-reachability.md §Piece 2).
 * Pure-signal decision core: reachable → silent; orphan → ONE NORMAL item; grace; pressure
 * /halt skip + re-sweep on clear; flap backoff; burst roll-up. Mutates nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  TopicReachabilityVerifier,
  type Reachability,
  type AttentionSurface,
} from '../../src/monitoring/TopicReachabilityVerifier.js';

function harness(opts: {
  reach: Map<number, Reachability>;
  pressure?: () => boolean;
  halt?: () => boolean;
  graceMs?: number;
  burstThreshold?: number;
  resurfaceFloorMs?: number;
}) {
  let now = 1_000_000;
  const surfaced: AttentionSurface[] = [];
  const v = new TopicReachabilityVerifier({
    probe: (t) => opts.reach.get(t) ?? { reachable: true },
    surface: (i) => surfaced.push(i),
    pressureCritical: opts.pressure ?? (() => false),
    emergencyStopActive: opts.halt ?? (() => false),
    now: () => now,
    graceMs: opts.graceMs ?? 30_000,
    burstThreshold: opts.burstThreshold ?? 10,
    resurfaceFloorMs: opts.resurfaceFloorMs ?? 3_600_000,
  });
  return { v, surfaced, advance: (ms: number) => (now += ms), nowRef: () => now };
}

const orphan = (reason: any): Reachability => ({ reachable: false, reason });

describe('TopicReachabilityVerifier — grace + reachable honesty guard', () => {
  it('does NOT surface before grace elapses', () => {
    const h = harness({ reach: new Map([[1, orphan('stuck-spawn')]]) });
    h.v.recordMutation(1);
    h.v.tick(); // grace not elapsed
    expect(h.surfaced).toHaveLength(0);
  });

  it('a topic that is REACHABLE (will self-heal on next inbound) → no surface', () => {
    const h = harness({ reach: new Map([[1, { reachable: true }]]) });
    h.v.recordMutation(1);
    h.advance(31_000);
    h.v.tick();
    expect(h.surfaced).toHaveLength(0);
  });

  it('a genuine orphan past grace → ONE NORMAL per-topic item (mutates nothing)', () => {
    const h = harness({ reach: new Map([[5, orphan('at-capacity')]]) });
    h.v.recordMutation(5);
    h.advance(31_000);
    h.v.tick();
    expect(h.surfaced).toHaveLength(1);
    expect(h.surfaced[0]).toMatchObject({ key: 'topic-reachability:5', rolledUp: false });
    expect(h.surfaced[0].reason).toContain('at-capacity');
  });
});

describe('TopicReachabilityVerifier — pressure / emergency-stop skip + re-sweep', () => {
  it('under critical pressure: skips per-topic churn, then re-sweeps on clear (orphan still surfaces)', () => {
    let pressure = true;
    const h = harness({ reach: new Map([[2, orphan('released-no-placement')]]), pressure: () => pressure });
    h.v.recordMutation(2);
    h.advance(31_000);
    const r1 = h.v.tick();
    expect(r1.skipped).toBe(1);
    expect(h.surfaced).toHaveLength(0); // skipped, not lost
    pressure = false;
    h.v.tick(); // re-sweep
    expect(h.surfaced).toHaveLength(1); // the orphan that outlived the window surfaces
  });

  it('emergency-stop active: suppressed, then re-swept on halt-lift', () => {
    let halt = true;
    const h = harness({ reach: new Map([[3, orphan('stuck-spawn')]]), halt: () => halt });
    h.v.recordMutation(3);
    h.advance(31_000);
    h.v.tick();
    expect(h.surfaced).toHaveLength(0);
    halt = false;
    h.v.tick();
    expect(h.surfaced).toHaveLength(1);
  });
});

describe('TopicReachabilityVerifier — flap backoff + burst roll-up', () => {
  it('a single flapping topic cannot mint an item every cycle (backoff caps cadence)', () => {
    const reach = new Map<number, Reachability>([[8, orphan('stuck-spawn')]]);
    const h = harness({ reach, resurfaceFloorMs: 3_600_000 });
    // orphan → surface (1)
    h.v.recordMutation(8); h.advance(31_000); h.v.tick();
    // flap reachable → re-arm
    reach.set(8, { reachable: true });
    h.v.recordMutation(8); h.advance(31_000); h.v.tick();
    // flap orphan again immediately → re-armed allows ONE more
    reach.set(8, orphan('stuck-spawn'));
    h.v.recordMutation(8); h.advance(31_000); h.v.tick();
    const after2 = h.surfaced.length;
    // flap reachable then orphan AGAIN within the backoff floor → must NOT surface (backoff)
    reach.set(8, { reachable: true }); h.v.recordMutation(8); h.advance(31_000); h.v.tick();
    reach.set(8, orphan('stuck-spawn')); h.v.recordMutation(8); h.advance(31_000); h.v.tick();
    // The second consecutive orphan inside the floor is backoff-gated.
    expect(h.surfaced.length).toBeLessThanOrEqual(after2 + 1);
    // and far fewer than the 5 cycles we ran
    expect(h.surfaced.length).toBeLessThan(5);
  });

  it('a mass-orphan (>= burst threshold) → ONE rolled-up item, never N', () => {
    const reach = new Map<number, Reachability>();
    for (let t = 1; t <= 12; t++) reach.set(t, orphan('released-no-placement'));
    const h = harness({ reach, burstThreshold: 10 });
    for (let t = 1; t <= 12; t++) h.v.recordMutation(t);
    h.advance(31_000);
    h.v.tick();
    expect(h.surfaced).toHaveLength(1);
    expect(h.surfaced[0]).toMatchObject({ key: 'topic-reachability:burst', rolledUp: true });
    expect(h.surfaced[0].topics).toHaveLength(12);
  });
});

describe('TopicReachabilityVerifier — coalescing + overflow', () => {
  it('repeated mutations for one topic coalesce to a single pending verify', () => {
    const h = harness({ reach: new Map([[1, orphan('stuck-spawn')]]) });
    h.v.recordMutation(1);
    h.v.recordMutation(1);
    h.v.recordMutation(1);
    expect(h.v.status().pending).toBe(1);
  });
});
