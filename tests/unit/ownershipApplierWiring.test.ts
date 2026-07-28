/**
 * Tier-1 + wiring-integrity tests for the OwnershipApplier mesh-self ordering fix
 * (spec: docs/specs/ownership-applier-meshself-ordering-fix.md).
 *
 * Proves the fix for the boot-ordering bug the GOLD-STANDARD live test caught: the applier
 * was gated on `durableOwnershipStore && _meshSelfId`, but `_meshSelfId` is assigned ~650
 * lines AFTER that guard in the server boot sequence, so it was always null at the check →
 * the applier was never constructed/ticked → a transferred seat never materialized on the
 * destination. The fix gates construction on the durable store ALONE and late-binds
 * `selfMachineId` (label-only) so it can never capture a stale null.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { OwnershipApplier, type PlacementReader } from '../../src/core/OwnershipApplier.js';
import { wireOwnershipApplier } from '../../src/core/ownershipApplierWiring.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';

/** A fake reader returning fixed placement entries (mirrors CoherenceJournalReader.query). */
function reader(entries: Array<{ topic: number; machine: string; owner: string; epoch: number; source?: 'own' | 'replica' }>): PlacementReader {
  return {
    query: () => ({
      entries: entries.map((e) => ({ topic: e.topic, machine: e.machine, source: e.source ?? 'replica', data: { owner: e.owner, epoch: e.epoch, reason: 'user-move' } })),
    }),
  };
}

describe('wireOwnershipApplier factory (construction condition — the regression surface)', () => {
  let dir: string;
  let store: LocalSessionOwnershipStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applier-wiring-'));
    store = new LocalSessionOwnershipStore({ dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'live-test-cleanup' }); } catch { /* best-effort */ }
  });

  it('THE REGRESSION GUARD: constructs a LIVE applier when the durable store is present even though getSelfMachineId() returns null', () => {
    // This is the exact condition the boot-ordering bug got wrong: store present, self
    // unresolved. The old guard returned no applier here. The fix MUST return one.
    const applier = wireOwnershipApplier({
      durableOwnershipStore: store,
      reader: reader([{ topic: 970013, machine: 'laptop', owner: 'mini', epoch: 2 }]),
      getSelfMachineId: () => null, // self not yet assigned (the boot-ordering hazard)
    });
    expect(applier).not.toBeNull();
    // And it actually materializes — materialization never needed self.
    const res = applier!.tick();
    expect(res.materialized).toBe(1);
    expect(store.read('970013')?.ownerMachineId).toBe('mini');
  });

  it('returns null when there is no durable store (InMemory has nothing to apply)', () => {
    const applier = wireOwnershipApplier({
      durableOwnershipStore: null,
      reader: reader([{ topic: 970013, machine: 'laptop', owner: 'mini', epoch: 2 }]),
      getSelfMachineId: () => 'mini',
    });
    expect(applier).toBeNull();
  });

  it('materializes a replicated placement end-to-end through the factory (in-process analogue of the cross-machine path)', () => {
    const applier = wireOwnershipApplier({
      durableOwnershipStore: store,
      reader: reader([{ topic: 26406, machine: 'laptop', owner: 'mini', epoch: 3 }]),
      getSelfMachineId: () => 'mini',
    });
    expect(store.read('26406')).toBeNull(); // the bug's starting state on the destination
    expect(applier!.tick().materialized).toBe(1);
    expect(store.read('26406')?.ownerMachineId).toBe('mini');
    expect(store.read('26406')?.ownershipEpoch).toBe(3);
  });
});

describe('OwnershipApplier late-bound selfMachineId', () => {
  let dir: string;
  let store: LocalSessionOwnershipStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applier-lazy-'));
    store = new LocalSessionOwnershipStore({ dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'live-test-cleanup' }); } catch { /* best-effort */ }
  });

  it('a getter that is null at construction then resolves still materializes on both ticks and labels SELF once resolved', () => {
    let self: string | null = null; // unresolved at construction (the boot ordering)
    const logs: string[] = [];
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 970013, machine: 'laptop', owner: 'mini', epoch: 1 }]),
      store,
      selfMachineId: () => self,
      logger: (m) => logs.push(m),
    });
    // Tick #1: self still null → materializes (no SELF/peer suffix on the label).
    expect(applier.tick().materialized).toBe(1);
    expect(store.read('970013')?.ownerMachineId).toBe('mini');
    expect(logs.some((l) => l.includes('materialized topic 970013'))).toBe(true);
    expect(logs.some((l) => l.includes('(SELF') || l.includes('(peer'))).toBe(false);

    // self resolves; a NEWER placement arrives → re-materialize, now labelled SELF.
    self = 'mini';
    logs.length = 0;
    const applier2 = new OwnershipApplier({
      reader: reader([{ topic: 970013, machine: 'laptop', owner: 'mini', epoch: 2 }]),
      store,
      selfMachineId: () => self,
      logger: (m) => logs.push(m),
    });
    expect(applier2.tick().materialized).toBe(1);
    expect(logs.some((l) => l.includes('(SELF — this machine now serves it)'))).toBe(true);
  });

  it('a peer-owned placement labels (peer …) once self is resolved', () => {
    const logs: string[] = [];
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 12476, machine: 'mini', owner: 'laptop', epoch: 4 }]),
      store,
      selfMachineId: () => 'mini', // I am mini; owner is laptop → peer
      logger: (m) => logs.push(m),
    });
    expect(applier.tick().materialized).toBe(1);
    expect(logs.some((l) => l.includes('(peer — route forwards there)'))).toBe(true);
  });

  it('still accepts a plain string selfMachineId (backward compatibility)', () => {
    const logs: string[] = [];
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 13481, machine: 'laptop', owner: 'mini', epoch: 5 }]),
      store,
      selfMachineId: 'mini', // legacy string form
      logger: (m) => logs.push(m),
    });
    expect(applier.tick().materialized).toBe(1);
    expect(logs.some((l) => l.includes('(SELF — this machine now serves it)'))).toBe(true);
  });
});
