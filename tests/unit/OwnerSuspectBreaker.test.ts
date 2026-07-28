/**
 * Tier-1 tests for OwnerSuspectBreaker + its SessionRouter integration — the
 * per-peer circuit breaker behind the previously-unwired markOwnerSuspect hook
 * ("No Unbounded Loops" / P19). Pre-fix: every session owned by a slow peer
 * independently re-paid the full delivery retry tax (~4.5s) per message,
 * because isMachineAlive read only capacity heartbeats.
 */

import { describe, it, expect, vi } from 'vitest';
import { OwnerSuspectBreaker } from '../../src/core/OwnerSuspectBreaker.js';
import { SessionRouter } from '../../src/core/SessionRouter.js';
import type { DeliverAck, OwnershipView } from '../../src/core/SessionRouter.js';

function make(opts: { ttl?: number; signalAfter?: number } = {}) {
  let nowMs = 0;
  const lines: string[] = [];
  const sustained: any[] = [];
  const b = new OwnerSuspectBreaker({
    suspectTtlMs: opts.ttl ?? 30_000,
    signalAfterMs: opts.signalAfter ?? 600_000,
    now: () => nowMs,
    logger: (m) => lines.push(m),
    reportSustained: (i) => sustained.push(i),
  });
  return { b, lines, sustained, setNow: (t: number) => { nowMs = t; } };
}

describe('OwnerSuspectBreaker', () => {
  it('opens a TTL window on markSuspect, half-opens after the TTL', () => {
    const { b, setNow } = make({ ttl: 30_000 });
    setNow(1_000);
    b.markSuspect('m_b');
    expect(b.isSuspect('m_b')).toBe(true);
    setNow(31_001); // past the window — half-open: callers re-probe
    expect(b.isSuspect('m_b')).toBe(false);
  });

  it('a successful delivery closes the window immediately and logs recovery once', () => {
    const { b, lines, setNow } = make();
    setNow(1_000);
    b.markSuspect('m_b');
    b.recordSuccess('m_b');
    expect(b.isSuspect('m_b')).toBe(false);
    expect(lines.filter((l) => l.includes('recovered after 1 suspect mark'))).toHaveLength(1);
    b.recordSuccess('m_b'); // steady success silent
    expect(lines).toHaveLength(2); // first-suspect + recovery, nothing else
  });

  it('SUSTAINED-SUSPICION BOUND (P19): repeated marks log first + signal once, never per-mark', () => {
    const { b, lines, sustained, setNow } = make({ ttl: 30_000, signalAfter: 120_000 });
    // A peer failing every half-open re-probe for 10 minutes (20 marks).
    for (let t = 0; t <= 600_000; t += 30_001) {
      setNow(t);
      b.markSuspect('m_b');
    }
    expect(lines.filter((l) => l.includes('SUSPECT (delivery retries exhausted)'))).toHaveLength(1);
    expect(sustained).toHaveLength(1);
    expect(sustained[0].machineId).toBe('m_b');
    expect(sustained[0].marks).toBeGreaterThan(3);
  });

  it('peers are independent; success deletes per-peer state (bounded memory)', () => {
    const { b, setNow } = make();
    setNow(1_000);
    b.markSuspect('m_b');
    b.markSuspect('m_c');
    b.recordSuccess('m_b');
    expect(b.isSuspect('m_b')).toBe(false);
    expect(b.isSuspect('m_c')).toBe(true);
  });

  it('a NEW episode after recovery logs + signals afresh', () => {
    const { b, lines, setNow } = make({ ttl: 10_000 });
    setNow(0);
    b.markSuspect('m_b');
    b.recordSuccess('m_b');
    setNow(50_000);
    b.markSuspect('m_b');
    expect(lines.filter((l) => l.includes('SUSPECT (delivery retries exhausted)'))).toHaveLength(2);
  });

  it('ABSOLUTE per-episode TTL: a re-mark WITHIN an open window does NOT extend it — half-open is always reachable under a steady <TTL stream', () => {
    const { b, setNow } = make({ ttl: 30_000 });
    setNow(0);
    b.markSuspect('m_b'); // window → 30_000
    // A steady stream re-marks every 10s (< TTL). Without the absolute-TTL fix
    // each mark would push the window end forward (10s→40s, 20s→50s, …) so the
    // window would never expire while messages keep arriving — a recovered peer
    // would stay suspect forever and the half-open re-probe would never fire.
    setNow(10_000); b.markSuspect('m_b');
    setNow(20_000); b.markSuspect('m_b');
    setNow(29_000); b.markSuspect('m_b');
    // With the fix the window end is fixed at the FIRST mark (30_000), so it
    // expires on schedule regardless of stream rate.
    setNow(30_001);
    expect(b.isSuspect('m_b')).toBe(false); // half-open reached — the next dispatch re-probes the peer for real
  });
});

describe('SessionRouter integration (the breaker composition + chains hygiene)', () => {
  const SELF = 'm_self';
  const msg = (id = 'evt-1') => ({ sessionKey: 's1', messageId: id, payload: {}, topicMetadata: {} });

  function makeRouter(over: Record<string, unknown> = {}) {
    const deps: any = {
      selfMachineId: SELF,
      placement: { decide: () => ({ outcome: 'placed', chosenMachine: SELF, reason: 'test' }) },
      machineRegistry: () => [],
      resolveOwnership: () => ({ owner: null, epoch: 0, status: null }) as OwnershipView,
      isMachineAlive: () => true,
      casClaimOwnership: vi.fn(() => ({ ok: true, epoch: 1 })),
      deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'queued' }) as DeliverAck,
      handleLocally: vi.fn(async () => {}),
      spawnOnMachine: vi.fn(async () => {}),
      queueMessage: vi.fn(() => 'refused' as const),
      raiseAttention: vi.fn(),
      sleep: vi.fn(async () => {}),
      ...over,
    };
    return { router: new SessionRouter(deps), deps };
  }

  it('a successful forward fires onOwnerResponsive (closes the suspect window)', async () => {
    const onOwnerResponsive = vi.fn();
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_remote', epoch: 7, status: 'active' }),
      onOwnerResponsive,
    });
    await router.route(msg());
    expect(onOwnerResponsive).toHaveBeenCalledWith('m_remote');
  });

  it('a stale-ownership ack ALSO fires onOwnerResponsive (the peer answered)', async () => {
    const onOwnerResponsive = vi.fn();
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_remote', epoch: 7, status: 'active' }),
      deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'stale-ownership' }) as DeliverAck,
      onOwnerResponsive,
    });
    await router.route(msg());
    expect(onOwnerResponsive).toHaveBeenCalledWith('m_remote');
  });

  it('END-TO-END: retry exhaustion marks suspect; the composed isMachineAlive short-circuits the NEXT message straight to re-place (no second retry tax)', async () => {
    const { b } = (() => { const r = make({ ttl: 30_000 }); return { b: r.b, setNow: r.setNow }; })();
    const deliver = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const spawnOnMachine = vi.fn(async () => {});
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_slow', epoch: 7, status: 'active' }),
      // The production composition: capacity-online AND not suspect.
      isMachineAlive: (m: string) => m === SELF || !b.isSuspect(m),
      markOwnerSuspect: (m: string) => b.markSuspect(m),
      deliverMessage: deliver,
      placement: { decide: () => ({ outcome: 'placed', chosenMachine: 'm_other', reason: 'failover' }) },
      spawnOnMachine,
    });
    // Message 1: pays the full retry tax (4 attempts), exhausts, marks suspect, re-places.
    await router.route(msg('evt-1'));
    expect(deliver).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(b.isSuspect('m_slow')).toBe(true);
    // Message 2: short-circuits — ZERO new delivery attempts, straight to re-place.
    await router.route(msg('evt-2'));
    expect(deliver).toHaveBeenCalledTimes(4);
    expect(spawnOnMachine).toHaveBeenCalledTimes(2); // both messages landed on m_other
  });

  it('chains map is bounded by IN-FLIGHT sessions (settled entries are deleted)', async () => {
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: SELF, epoch: 1, status: 'active' }),
    });
    for (let i = 0; i < 50; i++) {
      await router.route({ sessionKey: `s${i}`, messageId: `e${i}`, payload: {}, topicMetadata: {} });
    }
    await new Promise((r) => setTimeout(r, 0)); // let the cleanup microtasks run
    expect((router as any).chains.size).toBe(0);
  });
});
