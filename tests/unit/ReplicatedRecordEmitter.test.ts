/**
 * Unit — ReplicatedRecordEmitter (WS2 send-side, the generic journal-backed emitter).
 *
 * Proves the emitter's contract in isolation with fakes: the dark gate (disabled
 * store ⇒ strict no-op), the degenerate guard (null recordKey ⇒ skip), the
 * `observed` witness order (witness read BEFORE the tick ⇒ observed < hlc), and that
 * a builder/journal throw is a counted no-op (never propagates — the manager's local
 * write must never break because replication did).
 */
import { describe, it, expect } from 'vitest';

import { ReplicatedRecordEmitter, type ReplicatedRecordEmitterClock } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedKindRegistry, type StateSyncStores } from '../../src/core/ReplicatedRecordEnvelope.js';
import { LEARNING_KIND_REGISTRATION, LEARNING_STORE_KEY, LEARNING_RECORD_KIND } from '../../src/core/LearningsReplicatedStore.js';
import { HybridLogicalClock, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const ORIGIN = 'm_test_self';

function registry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}

/** A real persistence-free HLC clock — monotonic ticks. */
function clock(): ReplicatedRecordEmitterClock {
  return new HybridLogicalClock({ node: ORIGIN, now: () => Date.now() });
}

interface Captured {
  kind: string;
  data: Record<string, unknown>;
}

function makeEmitter(opts: {
  stores: StateSyncStores | undefined;
  witness?: HlcTimestamp | undefined;
  clockImpl?: ReplicatedRecordEmitterClock;
}): { emitter: ReplicatedRecordEmitter; captured: Captured[] } {
  const captured: Captured[] = [];
  const emitter = new ReplicatedRecordEmitter({
    journal: { emitReplicatedRecord: (kind, data) => { captured.push({ kind, data }); } },
    clock: opts.clockImpl ?? clock(),
    registry: registry(),
    origin: ORIGIN,
    stores: () => opts.stores,
    loadWitness: () => opts.witness,
  });
  return { emitter, captured };
}

const PUT_BUILD = (hlc: HlcTimestamp, origin: string, observed: HlcTimestamp | undefined): Record<string, unknown> => ({
  title: 'tmux trailing colon', category: 'ops', description: 'use a trailing colon', source: { discoveredAt: '2026-06-15T00:00:00.000Z' },
  applied: false, tags: [], recordKey: 'rk1', hlc, op: 'put', origin,
  ...(observed !== undefined ? { observed } : {}),
});

describe('ReplicatedRecordEmitter — dark gate', () => {
  it('is a STRICT no-op when the store is disabled (default)', () => {
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: false } } });
    emitter.emit(LEARNING_STORE_KEY, 'rk1', PUT_BUILD);
    expect(captured).toHaveLength(0);
    expect(emitter.getStats().storeDisabled).toBe(1);
    expect(emitter.getStats().emitted).toBe(0);
  });

  it('is a no-op when the store flags are absent entirely', () => {
    const { emitter, captured } = makeEmitter({ stores: undefined });
    emitter.emit(LEARNING_STORE_KEY, 'rk1', PUT_BUILD);
    expect(captured).toHaveLength(0);
    expect(emitter.getStats().storeDisabled).toBe(1);
  });

  it('emits to the store kind when enabled', () => {
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: true } } });
    emitter.emit(LEARNING_STORE_KEY, 'rk1', PUT_BUILD);
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe(LEARNING_RECORD_KIND);
    expect(captured[0].data.recordKey).toBe('rk1');
    expect(captured[0].data.origin).toBe(ORIGIN);
    expect(emitter.getStats().emitted).toBe(1);
  });
});

describe('ReplicatedRecordEmitter — guards', () => {
  it('skips a null/empty recordKey (no stable identity surface)', () => {
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: true } } });
    emitter.emit(LEARNING_STORE_KEY, null, PUT_BUILD);
    emitter.emit(LEARNING_STORE_KEY, '', PUT_BUILD);
    expect(captured).toHaveLength(0);
    expect(emitter.getStats().skipped).toBe(2);
  });

  it('skips an unregistered store', () => {
    const { emitter, captured } = makeEmitter({ stores: { somethingElse: { enabled: true } } });
    emitter.emit('somethingElse', 'rk1', PUT_BUILD);
    expect(captured).toHaveLength(0);
    expect(emitter.getStats().skipped).toBe(1);
  });

  it('skips when the builder returns null (degenerate record)', () => {
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: true } } });
    emitter.emit(LEARNING_STORE_KEY, 'rk1', () => null);
    expect(captured).toHaveLength(0);
    expect(emitter.getStats().skipped).toBe(1);
  });

  it('CATCHES a builder throw — never propagates, counts an error', () => {
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: true } } });
    expect(() => emitter.emit(LEARNING_STORE_KEY, 'rk1', () => { throw new Error('over cap'); })).not.toThrow();
    expect(captured).toHaveLength(0);
    expect(emitter.getStats().errors).toBe(1);
  });

  it('CATCHES a journal throw — never propagates', () => {
    const c = clock();
    const emitter = new ReplicatedRecordEmitter({
      journal: { emitReplicatedRecord: () => { throw new Error('journal boom'); } },
      clock: c,
      registry: registry(),
      origin: ORIGIN,
      stores: () => ({ learnings: { enabled: true } }),
      loadWitness: () => undefined,
    });
    expect(() => emitter.emit(LEARNING_STORE_KEY, 'rk1', PUT_BUILD)).not.toThrow();
    expect(emitter.getStats().errors).toBe(1);
  });
});

describe('ReplicatedRecordEmitter — observed witness (§7.2)', () => {
  it('omits observed on the first write (no prior witness)', () => {
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: true } }, witness: undefined });
    emitter.emit(LEARNING_STORE_KEY, 'rk1', PUT_BUILD);
    expect(captured[0].data.observed).toBeUndefined();
  });

  it('supplies the prior witness AND ticks strictly after it (observed < hlc)', () => {
    const prior: HlcTimestamp = { physical: 1000, logical: 0, node: 'm_peer' };
    // A clock seeded so its first tick is strictly after `prior`.
    const c = new HybridLogicalClock({ node: ORIGIN, now: () => 2000 });
    const { emitter, captured } = makeEmitter({ stores: { learnings: { enabled: true } }, witness: prior, clockImpl: c });
    emitter.emit(LEARNING_STORE_KEY, 'rk1', PUT_BUILD);
    const observed = captured[0].data.observed as HlcTimestamp;
    const hlc = captured[0].data.hlc as HlcTimestamp;
    expect(observed).toEqual(prior);
    // The witness is read BEFORE the tick, so the emitted hlc is strictly greater.
    expect(HybridLogicalClock.compare(hlc, observed)).toBeGreaterThan(0);
  });
});

describe('ReplicatedRecordEmitter — construction guards', () => {
  it('throws on a null/no-op seam (wiring-integrity)', () => {
    expect(() => new ReplicatedRecordEmitter({
      // @ts-expect-error intentional null seam
      journal: null, clock: clock(), registry: registry(), origin: ORIGIN, stores: () => undefined, loadWitness: () => undefined,
    })).toThrow(/journal/);
    expect(() => new ReplicatedRecordEmitter({
      journal: { emitReplicatedRecord: () => {} }, clock: clock(), registry: registry(), origin: '',
      stores: () => undefined, loadWitness: () => undefined,
    })).toThrow(/origin/);
  });
});
