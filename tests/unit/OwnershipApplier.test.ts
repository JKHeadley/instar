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
function reader(entries: Array<{ topic: number; machine: string; owner: string; epoch: number; source?: 'own' | 'replica'; status?: 'active' | 'transferring'; transferTo?: string; timestamp?: number; drainInFlight?: boolean }>): PlacementReader {
  return {
    query: () => ({
      entries: entries.map((e) => ({
        topic: e.topic, machine: e.machine, source: e.source ?? 'replica',
        data: {
          owner: e.owner, epoch: e.epoch, reason: 'user-move',
          ...(e.status ? { status: e.status } : {}),
          ...(e.transferTo !== undefined ? { transferTo: e.transferTo } : {}),
          ...(e.timestamp !== undefined ? { timestamp: e.timestamp } : {}),
          ...(e.drainInFlight !== undefined ? { drainInFlight: e.drainInFlight } : {}),
        },
      })),
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

  // ── Fix #3: cross-machine transferring materialization + safety fences ──
  describe('transferring handoff (Fix #3)', () => {
    const known = () => new Set(['mini', 'laptop']);

    it('materializes a replicated `transferring` so the target can claim (the core #3 fix)', () => {
      const applier = new OwnershipApplier({
        reader: reader([{ topic: 700, machine: 'mini', owner: 'mini', epoch: 3, status: 'transferring', transferTo: 'laptop', timestamp: 1000 }]),
        store, selfMachineId: 'laptop', knownMachines: known, now: () => 1000,
      });
      applier.tick();
      const rec = store.read('700')!;
      expect(rec.status).toBe('transferring');
      expect(rec.ownerMachineId).toBe('mini');
      expect(rec.transferTo).toBe('laptop');
    });

    it('preserves the producer `timestamp` IN-BOUNDS (AD2 — drain timing intact)', () => {
      const producerTs = 5_000_000;
      const applier = new OwnershipApplier({
        reader: reader([{ topic: 700, machine: 'mini', owner: 'mini', epoch: 3, status: 'transferring', transferTo: 'laptop', timestamp: producerTs }]),
        store, selfMachineId: 'laptop', knownMachines: known, now: () => producerTs + 1000, // within skew tolerance
      });
      applier.tick();
      expect(store.read('700')!.timestamp).toBe(producerTs); // carried verbatim
    });

    it('CLAMPS a FUTURE timestamp to now (SE8 — corrupt peer cannot defeat the deadline)', () => {
      const now = 5_000_000;
      const applier = new OwnershipApplier({
        reader: reader([{ topic: 700, machine: 'mini', owner: 'mini', epoch: 3, status: 'transferring', transferTo: 'laptop', timestamp: now + 60 * 60 * 1000 }]), // 1h in the future
        store, selfMachineId: 'laptop', knownMachines: known, now: () => now,
      });
      applier.tick();
      expect(store.read('700')!.timestamp).toBe(now); // future floored to now
    });

    it('DOWNGRADES `transferring` to active when transferTo is unknown (AD3/SE1)', () => {
      const applier = new OwnershipApplier({
        reader: reader([{ topic: 700, machine: 'mini', owner: 'mini', epoch: 3, status: 'transferring', transferTo: 'ghost-machine', timestamp: 1000 }]),
        store, selfMachineId: 'laptop', knownMachines: known, now: () => 1000,
      });
      applier.tick();
      const rec = store.read('700')!;
      expect(rec.status).toBe('active'); // never an un-claimable stuck transferring
      expect(rec.transferTo).toBeUndefined();
      expect(rec.ownerMachineId).toBe('mini');
    });

    it('DOWNGRADES `transferring` to active when transferTo == owner (AD3)', () => {
      const applier = new OwnershipApplier({
        reader: reader([{ topic: 700, machine: 'mini', owner: 'mini', epoch: 3, status: 'transferring', transferTo: 'mini', timestamp: 1000 }]),
        store, selfMachineId: 'laptop', knownMachines: known, now: () => 1000,
      });
      applier.tick();
      expect(store.read('700')!.status).toBe('active');
    });

    it('EPOCH FENCE: refuses an absurd epoch jump over local (SE2 — no permanent wedge)', () => {
      store.casWrite({ sessionKey: '700', ownerMachineId: 'mini', ownershipEpoch: 5, status: 'active', nonce: 'x', timestamp: 1, updatedAt: '1970' });
      const applier = new OwnershipApplier({
        reader: reader([{ topic: 700, machine: 'mini', owner: 'laptop', epoch: 5 + 2e9 }]), // jump beyond default 1e9 ceiling
        store, selfMachineId: 'laptop', knownMachines: known, maxEpochJump: 1e9,
      });
      applier.tick();
      expect(store.read('700')!.ownershipEpoch).toBe(5); // unchanged — fenced out
      expect(store.read('700')!.ownerMachineId).toBe('mini');
    });

    it('OWNER-ANCHORED tie-break at equal epoch: the true owner stream is canonical (SE6)', () => {
      const applier = new OwnershipApplier({
        reader: reader([
          // A peer stream (laptop) falsely emits active for topic 700 at epoch 3...
          { topic: 700, machine: 'laptop', owner: 'mini', epoch: 3, status: 'active' },
          // ...and the TRUE owner (mini) emits the transferring at the SAME epoch.
          { topic: 700, machine: 'mini', owner: 'mini', epoch: 3, status: 'transferring', transferTo: 'laptop', timestamp: 1000 },
        ]),
        store, selfMachineId: 'laptop', knownMachines: known, now: () => 1000,
      });
      applier.tick();
      // The owner-anchored entry (stream==owner==mini) wins → transferring materialized.
      expect(store.read('700')!.status).toBe('transferring');
      expect(store.read('700')!.transferTo).toBe('laptop');
    });
  });
});
