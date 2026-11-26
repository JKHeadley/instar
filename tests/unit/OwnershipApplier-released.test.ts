/**
 * Tier-1: a RELEASE replicates as a release (the 2026-10-21 "pin never actuates" bug).
 *
 * Live state that exposed it (topic 127648): the Mini released the topic
 * (local record released@3, journal row `{owner: mini, epoch: 3, reason: 'released'}`
 * with NO `status` field). Every peer's applier materialized that row as
 * active(owner = mini)@3 — so on the Studio the topic looked LIVE-owned by the Mini
 * forever, the pin → Studio could never adopt ("owner alive / unproven-dead"), the
 * Mini (a standby that cannot send) kept re-spawning sessions for it, and the
 * operator saw a conversation that went silent again and again.
 *
 * The applier must honor a release two ways: the explicit `status: 'released'` the
 * emit funnel now carries, AND the bare `reason: 'released'` of rows already in the
 * journal / written by an older peer — so convergence needs no re-emit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { OwnershipApplier, type PlacementReader } from '../../src/core/OwnershipApplier.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';

type Row = { topic: number; machine: string; owner: string; epoch: number; reason: string; status?: string; transferTo?: string };

function reader(rows: Row[]): PlacementReader {
  return {
    query: () => ({
      entries: rows.map((r) => ({
        topic: r.topic,
        machine: r.machine,
        source: 'replica',
        data: {
          owner: r.owner,
          epoch: r.epoch,
          reason: r.reason,
          ...(r.status ? { status: r.status } : {}),
          ...(r.transferTo ? { transferTo: r.transferTo } : {}),
        },
      })),
    }),
  };
}

const MINI = 'm_mini';
const STUDIO = 'm_studio';

describe('OwnershipApplier — a release replicates as a release', () => {
  let dir: string;
  let store: LocalSessionOwnershipStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applier-released-'));
    store = new LocalSessionOwnershipStore({ dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'live-test-cleanup' }); } catch { /* best-effort */ }
  });

  it('the exact live row (reason released, NO status) materializes as released — not active(owner)', () => {
    // Studio's view before the fix: owner=mini active@2 (the placed row).
    store.casWrite({ sessionKey: '127648', ownerMachineId: MINI, ownershipEpoch: 2, status: 'active', nonce: 'x', timestamp: 1, updatedAt: '1970' });
    const applier = new OwnershipApplier({
      reader: reader([
        { topic: 127648, machine: STUDIO, owner: MINI, epoch: 2, reason: 'placed' },
        { topic: 127648, machine: MINI, owner: MINI, epoch: 3, reason: 'released' }, // the Mini's release
      ]),
      store,
      selfMachineId: STUDIO,
    });
    const res = applier.tick();
    expect(res.materialized).toBe(1);
    const rec = store.read('127648')!;
    expect(rec.ownershipEpoch).toBe(3);
    // THE fix: released, so the reconciler on the pin target sees "no live record"
    // and adopts; before this it read active(mini) and deferred forever.
    expect(rec.status).toBe('released');
    expect(rec.transferTo).toBeUndefined();
  });

  it('an explicit status: released (the emit funnel now carries it) materializes as released', () => {
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 5, machine: MINI, owner: MINI, epoch: 4, reason: 'user-move', status: 'released' }]),
      store,
      selfMachineId: STUDIO,
    });
    expect(applier.tick().materialized).toBe(1);
    expect(store.read('5')?.status).toBe('released');
  });

  it('a released row at a LOWER epoch never clobbers a fresher local active claim (fast-forward only)', () => {
    // The Studio adopted the topic after the release: active(studio)@5.
    store.casWrite({ sessionKey: '7', ownerMachineId: STUDIO, ownershipEpoch: 5, status: 'active', nonce: 'x', timestamp: 1, updatedAt: '1970' });
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 7, machine: MINI, owner: MINI, epoch: 3, reason: 'released' }]),
      store,
      selfMachineId: STUDIO,
    });
    expect(applier.tick().materialized).toBe(0);
    expect(store.read('7')).toMatchObject({ ownerMachineId: STUDIO, ownershipEpoch: 5, status: 'active' });
  });

  it('after a replicated release, a later higher-epoch claim by the pin target lands (the handoff completes)', () => {
    const applier = new OwnershipApplier({
      reader: reader([
        { topic: 9, machine: MINI, owner: MINI, epoch: 3, reason: 'released' },
        { topic: 9, machine: STUDIO, owner: STUDIO, epoch: 5, reason: 'reconcile' }, // Studio adopted (place→claim)
      ]),
      store,
      selfMachineId: MINI,
    });
    expect(applier.tick().materialized).toBe(1);
    expect(store.read('9')).toMatchObject({ ownerMachineId: STUDIO, ownershipEpoch: 5, status: 'active' });
  });

  it('THE LIVE PRECONDITION: an already-materialized active@3 (applier nonce) is CORRECTED to released@3 by the same row', () => {
    // Studio's actual record on 2026-10-22: materialized by the applier itself from
    // the Mini's released@3 row, as active(mini)@3, nonce `applier:<mini>:3`. The row
    // is at the SAME epoch, so the fast-forward CAS can never repair it and no fresh
    // higher-epoch row is coming (a released topic is quiet by definition).
    store.casWrite({ sessionKey: '127648', ownerMachineId: MINI, ownershipEpoch: 3, status: 'active', nonce: `applier:${MINI}:3`, timestamp: 1792537121506, updatedAt: '2026-10-20T22:58:41.506Z' });
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 127648, machine: MINI, owner: MINI, epoch: 3, reason: 'released' }]),
      store,
      selfMachineId: STUDIO,
    });
    const res = applier.tick();
    expect(res.materialized).toBe(0);
    expect(res.statusCorrected).toBe(1);
    const rec = store.read('127648')!;
    expect(rec).toMatchObject({ ownerMachineId: MINI, ownershipEpoch: 3, status: 'released', nonce: `applier:${MINI}:3` });
    expect(rec.timestamp).toBe(1792537121506); // the original materialization time is kept
    // Idempotent: a second tick over the same row changes nothing.
    const again = applier.tick();
    expect(again.statusCorrected).toBeUndefined();
    expect(store.read('127648')?.status).toBe('released');
  });

  it('a same-epoch record written by a LOCAL CAS (not the applier) is NEVER rewritten by a released row', () => {
    // A local claim at epoch 3 is a local decision — the correction only ever touches
    // the applier's own materialization (nonce-checked on both sides).
    store.casWrite({ sessionKey: '21', ownerMachineId: STUDIO, ownershipEpoch: 3, status: 'active', nonce: `${STUDIO}:claim:21:1`, timestamp: 1, updatedAt: '1970' });
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 21, machine: STUDIO, owner: STUDIO, epoch: 3, reason: 'released' }]),
      store,
      selfMachineId: STUDIO,
    });
    const res = applier.tick();
    expect(res.materialized).toBe(0);
    expect(res.statusCorrected).toBeUndefined();
    expect(store.read('21')).toMatchObject({ status: 'active', nonce: `${STUDIO}:claim:21:1` });
  });

  it('a same-epoch applier record for a DIFFERENT owner is not rewritten (owner must match too)', () => {
    store.casWrite({ sessionKey: '23', ownerMachineId: STUDIO, ownershipEpoch: 3, status: 'active', nonce: `applier:${STUDIO}:3`, timestamp: 1, updatedAt: '1970' });
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 23, machine: MINI, owner: MINI, epoch: 3, reason: 'released' }]),
      store,
      selfMachineId: STUDIO,
    });
    expect(applier.tick().statusCorrected).toBeUndefined();
    expect(store.read('23')).toMatchObject({ ownerMachineId: STUDIO, status: 'active' });
  });

  it('the in-memory store supports the same correction (both substrates share the predicate)', () => {
    const mem = new InMemorySessionOwnershipStore();
    mem.casWrite({ sessionKey: '31', ownerMachineId: MINI, ownershipEpoch: 3, status: 'active', nonce: `applier:${MINI}:3`, timestamp: 1, updatedAt: '1970' });
    const seen: string[] = [];
    mem.onCommit = (r) => { seen.push(`${r.sessionKey}:${r.status}`); };
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 31, machine: MINI, owner: MINI, epoch: 3, reason: 'released' }]),
      store: mem,
      selfMachineId: STUDIO,
    });
    expect(applier.tick().statusCorrected).toBe(1);
    expect(mem.read('31')?.status).toBe('released');
    expect(seen).toEqual(['31:released']); // the commit hook (WriteAdmission index) sees the correction
  });

  it('a transferring row is still materialized as transferring (the release path does not swallow it)', () => {
    const applier = new OwnershipApplier({
      reader: reader([{ topic: 11, machine: MINI, owner: MINI, epoch: 2, reason: 'reconcile', status: 'transferring', transferTo: STUDIO }]),
      store,
      selfMachineId: STUDIO,
      knownMachines: () => new Set([MINI, STUDIO]),
    });
    expect(applier.tick().materialized).toBe(1);
    expect(store.read('11')).toMatchObject({ status: 'transferring', transferTo: STUDIO });
  });
});
