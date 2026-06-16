/**
 * Tier-1 tests for OwnershipApplier (spec §7.2): the cross-machine half of the
 * transfer fix. Proves the exact missing step the 2026-06-15 bug exposed — a
 * REPLICATED placement journal entry (a transfer that happened on a peer) is turned
 * into a durable LOCAL ownership record, so this machine resolves the right owner on
 * the next message. Plus the fast-forward guard (a stale replicated entry never
 * clobbers a fresher local decision).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { OwnershipApplier, type PlacementReader } from '../../src/core/OwnershipApplier.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';

/** A fake reader returning fixed placement entries (mirrors CoherenceJournalReader.query). */
function reader(entries: Array<{ topic: number; machine: string; owner: string; epoch: number; source?: 'own' | 'replica' }>): PlacementReader {
  return {
    query: () => ({
      entries: entries.map((e) => ({ topic: e.topic, machine: e.machine, source: e.source ?? 'replica', data: { owner: e.owner, epoch: e.epoch, reason: 'user-move' } })),
    }),
  };
}

describe('OwnershipApplier', () => {
  let dir: string;
  let store: LocalSessionOwnershipStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applier-'));
    store = new LocalSessionOwnershipStore({ dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: "live-test-cleanup" }); } catch { /* best-effort */ }
  });

  it('materializes a peer placement into a local ownership record (THE core fix)', () => {
    // A transfer happened on the LAPTOP that made MINI the owner; its placement
    // replicated here. Before: the local store has nothing → owner resolves null →
    // router mis-routes. The applier turns the replicated placement into ownership.
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 13481, machine: 'laptop', owner: 'mini', epoch: 5 }]),
      store,
      selfMachineId: 'mini',
    });
    expect(store.read('13481')).toBeNull(); // the bug's starting state
    const res = applier.tick();
    expect(res.materialized).toBe(1);
    expect(store.read('13481')?.ownerMachineId).toBe('mini');
    expect(store.read('13481')?.ownershipEpoch).toBe(5);
    expect(store.read('13481')?.status).toBe('active');
  });

  it('does NOT clobber a fresher local decision with a stale replicated entry', () => {
    // Local already knows owner=mini@epoch 7 (a newer local transfer).
    store.casWrite({ sessionKey: '13481', ownerMachineId: 'mini', ownershipEpoch: 7, status: 'active', nonce: 'x', timestamp: 1, updatedAt: '1970' });
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 13481, machine: 'laptop', owner: 'laptop', epoch: 4 }]), // stale (lower epoch)
      store,
      selfMachineId: 'mini',
    });
    const res = applier.tick();
    expect(res.materialized).toBe(0);
    expect(store.read('13481')?.ownerMachineId).toBe('mini'); // unchanged
    expect(store.read('13481')?.ownershipEpoch).toBe(7);
  });

  it('adopts the HIGHEST-epoch placement when several exist for a topic', () => {
    const applier = new OwnershipApplier({
      reader: reader([
        { topic: 5, machine: 'a', owner: 'a', epoch: 1 },
        { topic: 5, machine: 'b', owner: 'b', epoch: 3 }, // newest wins
        { topic: 5, machine: 'a', owner: 'a', epoch: 2 },
      ]),
      store,
      selfMachineId: 'self',
    });
    applier.tick();
    expect(store.read('5')?.ownerMachineId).toBe('b');
    expect(store.read('5')?.ownershipEpoch).toBe(3);
  });

  it('materializes self-owned placements too (this machine becomes the live server)', () => {
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 9, machine: 'peer', owner: 'self', epoch: 2 }]),
      store,
      selfMachineId: 'self',
    });
    applier.tick();
    expect(store.read('9')?.ownerMachineId).toBe('self');
  });

  it('is idempotent — a second tick over the same entries materializes nothing new', () => {
    const r = reader([{ topic: 1, machine: 'peer', owner: 'mini', epoch: 2 }]);
    const applier = new OwnershipApplier({ reader: r, store, selfMachineId: 'mini' });
    expect(applier.tick().materialized).toBe(1);
    expect(applier.tick().materialized).toBe(0); // already at epoch 2 → fast-forward no-op
  });

  it('skips malformed entries (missing owner / non-positive epoch) without throwing', () => {
    const applier = new OwnershipApplier({
      reader: {
        query: () => ({
          entries: [
            { topic: 1, machine: 'p', data: { owner: '', epoch: 5 } },
            { topic: 2, machine: 'p', data: { owner: 'm', epoch: 0 } },
            { topic: 3, machine: 'p', data: { owner: 'm', epoch: 4 } }, // the only valid one
          ],
        }),
      },
      store,
      selfMachineId: 'self',
    });
    const res = applier.tick();
    expect(res.materialized).toBe(1);
    expect(store.read('3')?.ownerMachineId).toBe('m');
    expect(store.read('1')).toBeNull();
    expect(store.read('2')).toBeNull();
  });

  it('materialized ownership is DURABLE — survives a restart (fresh store over same dir)', () => {
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 13481, machine: 'laptop', owner: 'mini', epoch: 5 }]),
      store,
      selfMachineId: 'mini',
    });
    applier.tick();
    const afterRestart = new LocalSessionOwnershipStore({ dir });
    expect(afterRestart.read('13481')?.ownerMachineId).toBe('mini');
  });
});
