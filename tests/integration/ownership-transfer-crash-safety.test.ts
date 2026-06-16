/**
 * Integration test for the transfer-fix crash-safety contract (spec
 * docs/specs/live-user-channel-proof-standard.md §7.3 / §9.4): an INTERRUPTED
 * cross-machine transfer must converge to EXACTLY ONE owner after the applier runs
 * — never zero owners (the topic stranded ownerless), never two (split-brain) —
 * using the durable store + epoch-fenced CAS + the OwnershipApplier built in this PR.
 *
 * This exercises the two-machine convergence with REAL LocalSessionOwnershipStores
 * (one per machine dir) and the OwnershipApplier reading a simulated replicated
 * placement stream — the exact shape of a transfer that crashed mid-flight, then
 * recovered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { OwnershipApplier, type PlacementReader } from '../../src/core/OwnershipApplier.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

/** A placement event as it would appear (replicated) in the coherence journal. */
interface Placement { topic: number; machine: string; owner: string; epoch: number }

function readerOf(events: Placement[]): PlacementReader {
  return {
    query: () => ({ entries: events.map((e) => ({ topic: e.topic, machine: e.machine, source: 'replica' as const, data: { owner: e.owner, epoch: e.epoch } })) }),
  };
}

function rec(sessionKey: string, owner: string, epoch: number, status: SessionOwnershipRecord['status'] = 'active'): SessionOwnershipRecord {
  return { sessionKey, ownerMachineId: owner, ownershipEpoch: epoch, status, nonce: `${owner}:${epoch}`, timestamp: 1, updatedAt: '1970' };
}

/** The single committed owner across BOTH machines (excludes 'released'/empty). */
function committedOwners(stores: Record<string, LocalSessionOwnershipStore>, topic: string): Array<{ machine: string; owner: string; epoch: number }> {
  const out: Array<{ machine: string; owner: string; epoch: number }> = [];
  for (const [machine, store] of Object.entries(stores)) {
    const r = store.read(topic);
    if (r && r.status === 'active') out.push({ machine, owner: r.ownerMachineId, epoch: r.ownershipEpoch });
  }
  return out;
}

describe('ownership transfer crash-safety (§7.3/§9.4)', () => {
  let root: string;
  let laptopDir: string;
  let miniDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-crash-'));
    laptopDir = path.join(root, 'laptop');
    miniDir = path.join(root, 'mini');
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: "live-test-cleanup" }); } catch { /* best-effort */ }
  });

  it('crash AFTER source commits but BEFORE target materializes → applier converges to ONE owner (the target)', () => {
    const laptop = new LocalSessionOwnershipStore({ dir: laptopDir });
    const mini = new LocalSessionOwnershipStore({ dir: miniDir });

    // The transfer's source leg landed on the laptop: it released its own ownership
    // and placed the seat to mini at a fresh epoch, emitting a placement entry.
    laptop.casWrite(rec('13481', 'mini', 5)); // source recorded the target as owner
    const replicatedPlacement: Placement[] = [{ topic: 13481, machine: 'laptop', owner: 'mini', epoch: 5 }];

    // CRASH: the process died before mini ever turned that into a local record.
    // Mini's store is empty → today's bug = topic owner resolves null on mini.
    expect(mini.read('13481')).toBeNull();

    // RECOVERY: mini's applier runs (boot tick) over the replicated placement.
    new OwnershipApplier({ reader: readerOf(replicatedPlacement), store: mini, selfMachineId: 'mini' }).tick();

    // CONVERGENCE: exactly one active owner across both machines, and it is mini.
    const owners = committedOwners({ laptop, mini }, '13481');
    expect(owners).toHaveLength(2); // both stores agree on the SAME owner (not two DIFFERENT owners)
    expect(new Set(owners.map((o) => o.owner))).toEqual(new Set(['mini']));
    expect(owners.every((o) => o.epoch === 5)).toBe(true);
    expect(mini.read('13481')?.status).toBe('active');
  });

  it('a raced stale placement during recovery never creates a SECOND owner (no split-brain)', () => {
    const laptop = new LocalSessionOwnershipStore({ dir: laptopDir });
    const mini = new LocalSessionOwnershipStore({ dir: miniDir });

    // mini already converged to owner=mini@epoch 5 (the real move).
    laptop.casWrite(rec('2', 'mini', 5));
    mini.casWrite(rec('2', 'mini', 5));

    // A STALE replicated placement arrives (an old laptop-owner entry at a lower epoch).
    new OwnershipApplier({ reader: readerOf([{ topic: 2, machine: 'laptop', owner: 'laptop', epoch: 3 }]), store: mini, selfMachineId: 'mini' }).tick();

    // mini stays owner — the stale entry never flips ownership (epoch fast-forward guard).
    const owners = committedOwners({ laptop, mini }, '2');
    expect(new Set(owners.map((o) => o.owner))).toEqual(new Set(['mini']));
  });

  it('the converged ownership is DURABLE across a restart (the seat does not regress to ownerless)', () => {
    const mini = new LocalSessionOwnershipStore({ dir: miniDir });
    new OwnershipApplier({ reader: readerOf([{ topic: 1, machine: 'laptop', owner: 'mini', epoch: 2 }]), store: mini, selfMachineId: 'mini' }).tick();
    expect(mini.read('1')?.ownerMachineId).toBe('mini');

    // Restart mini (fresh store over the same dir) — the seat survives, not ownerless.
    const miniAfter = new LocalSessionOwnershipStore({ dir: miniDir });
    expect(miniAfter.read('1')?.status).toBe('active');
    expect(miniAfter.read('1')?.ownerMachineId).toBe('mini');
  });
});
