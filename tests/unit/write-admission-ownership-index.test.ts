/**
 * OwnershipIndex — parity with the ownership store BY CONSTRUCTION across
 * arbitrary cas()/OwnershipApplier commit sequences, run against BOTH shipped
 * substrates (LocalSessionOwnershipStore AND InMemorySessionOwnershipStore —
 * the interface-level `onCommit` contract, round-2 S4); boot-warm
 * completeness; ingest validation (round-2 L1).
 *
 * Spec: docs/specs/standby-write-reconciliation.md §3.2 (ownership index),
 * §8 Tier-1 parity/ingest clauses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';
import { InMemorySessionOwnershipStore, SessionOwnershipRegistry, type SessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionOwnershipRecord, SessionOwnershipStatus } from '../../src/core/SessionOwnership.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function rec(sessionKey: string, owner: string, status: SessionOwnershipStatus, epoch: number): SessionOwnershipRecord {
  return {
    sessionKey,
    ownerMachineId: owner,
    ownershipEpoch: epoch,
    status,
    nonce: `n-${sessionKey}-${epoch}-${owner}`,
    timestamp: 1_000_000 + epoch,
    updatedAt: new Date(1_000_000 + epoch).toISOString(),
  };
}

function makeWA(store: SessionOwnershipStore): WriteAdmission {
  return new WriteAdmission(
    {
      thisMachineId: SELF,
      isReadOnly: () => true, // a standby — the interesting side
      isPoolActive: () => true,
      registry: buildWriteDomainRegistry({ machineId: SELF }),
      dryRun: false,
      disableTimers: true,
      inventoryComplete: true,
    },
    store,
  );
}

function makeRegistry(store: SessionOwnershipStore): SessionOwnershipRegistry {
  const seen = new Set<string>();
  return new SessionOwnershipRegistry({
    store,
    seenNonce: (k) => seen.has(k),
    recordNonce: (k) => seen.add(k),
    now: () => 1_000_000,
  });
}

/** Assert the index mirrors the store's record set exactly (owner + status per key). */
function assertParity(wa: WriteAdmission, store: SessionOwnershipStore): void {
  const storeView = new Map((store.all?.() ?? []).map((r) => [r.sessionKey, { owner: r.ownerMachineId, status: r.status }]));
  const idxView = wa.index.snapshot();
  expect(idxView.size).toBe(storeView.size);
  for (const [key, expected] of storeView) {
    expect(idxView.get(key)).toEqual(expected);
  }
}

const substrates: Array<{
  name: string;
  make: () => { store: SessionOwnershipStore; cleanup: () => void };
}> = [
  {
    name: 'InMemorySessionOwnershipStore (casWrite commit point — no persist() funnel)',
    make: () => ({ store: new InMemorySessionOwnershipStore(), cleanup: () => {} }),
  },
  {
    name: 'LocalSessionOwnershipStore (persist() commit point)',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ownership-'));
      return {
        store: new LocalSessionOwnershipStore({ dir }),
        cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }),
      };
    },
  },
];

for (const substrate of substrates) {
  describe(`OwnershipIndex parity — ${substrate.name}`, () => {
    let store: SessionOwnershipStore;
    let cleanup: () => void;

    beforeEach(() => {
      const made = substrate.make();
      store = made.store;
      cleanup = made.cleanup;
    });
    afterEach(() => cleanup());

    it('mirrors the store across an arbitrary registry.cas() sequence (place → claim → transfer → claim → release)', () => {
      const wa = makeWA(store);
      const reg = makeRegistry(store);
      const key = '30193';
      expect(reg.cas({ type: 'place', machineId: PEER }, { sessionKey: key, sender: PEER, nonce: 'x1' }).ok).toBe(true);
      assertParity(wa, store);
      expect(wa.evaluate('topic-scoped', { topicId: 30193 }).admit).toBe(false); // peer placing — not-owner

      expect(reg.cas({ type: 'claim', machineId: PEER }, { sessionKey: key, sender: PEER, nonce: 'x2' }).ok).toBe(true);
      assertParity(wa, store);

      expect(reg.cas({ type: 'transfer', to: SELF }, { sessionKey: key, sender: PEER, nonce: 'x3' }).ok).toBe(true);
      assertParity(wa, store);
      // transferring still names the draining source (PEER) — self still refuses.
      expect(wa.evaluate('topic-scoped', { topicId: 30193 }).admit).toBe(false);

      expect(reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: key, sender: SELF, nonce: 'x4' }).ok).toBe(true);
      assertParity(wa, store);
      // Now the FSM names THIS machine — the write is admitted on the "standby".
      expect(wa.evaluate('topic-scoped', { topicId: 30193 }).admit).toBe(true);

      expect(reg.cas({ type: 'release', machineId: SELF }, { sessionKey: key, sender: SELF, nonce: 'x5' }).ok).toBe(true);
      assertParity(wa, store);
    });

    it('mirrors the store across OwnershipApplier-path commits (direct store.casWrite — the SAME funnel)', () => {
      const wa = makeWA(store);
      // The applier materializes replicated placements via store.casWrite directly.
      expect(store.casWrite(rec('7', PEER, 'active', 3)).ok).toBe(true);
      expect(store.casWrite(rec('8', SELF, 'placing', 1)).ok).toBe(true);
      assertParity(wa, store);
      // A LOSING cas (non-fast-forward) must not corrupt the index.
      expect(store.casWrite(rec('7', SELF, 'active', 2)).ok).toBe(false);
      assertParity(wa, store);
      expect(wa.evaluate('topic-scoped', { topicId: 7 }).admit).toBe(false);
      expect(wa.evaluate('topic-scoped', { topicId: 8 }).admit).toBe(true);
    });

    it('a hook-listener throw never fails the CAS itself', () => {
      makeWA(store);
      store.onCommit = () => { throw new Error('listener boom'); };
      expect(store.casWrite(rec('9', SELF, 'active', 1)).ok).toBe(true);
      expect(store.read('9')?.ownerMachineId).toBe(SELF);
    });
  });
}

describe('OwnershipIndex — boot-warm completeness (LocalSessionOwnershipStore)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-warm-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }));

  it('ONE synchronous all() scan at construction loads the COMPLETE record set — negative answers come from memory', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '100.json'), JSON.stringify(rec('100', SELF, 'active', 2)));
    fs.writeFileSync(path.join(dir, '200.json'), JSON.stringify(rec('200', PEER, 'active', 4)));
    const store = new LocalSessionOwnershipStore({ dir });
    const wa = makeWA(store);
    expect(wa.index.stats().entries).toBe(2);
    expect(wa.evaluate('topic-scoped', { topicId: 100 }).admit).toBe(true);
    const v = wa.evaluate('topic-scoped', { topicId: 200 });
    expect(v.admit).toBe(false);
    if (!v.admit) expect(v.refusal.code).toBe('not-owner');
  });

  it('ingest validation (round-2 L1): a record surfaced by the WEAKLY-validated all() scan (non-string ownerMachineId) classifies malformed ⇒ ownership-unresolved', () => {
    fs.mkdirSync(dir, { recursive: true });
    // Passes the all() scan's weak validation (ownershipEpoch + sessionKey) but
    // fails loadOne's stronger check — exactly the asymmetry L1 named.
    fs.writeFileSync(path.join(dir, '300.json'), JSON.stringify({ sessionKey: '300', ownerMachineId: 42, ownershipEpoch: 1, status: 'active' }));
    const store = new LocalSessionOwnershipStore({ dir });
    const wa = makeWA(store);
    const v = wa.evaluate('topic-scoped', { topicId: 300 });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.refusal.code).toBe('ownership-unresolved');
      expect(v.refusal.owner).toBeNull(); // NEVER not-owner with owner:null
    }
  });

  it('an unreadable warm scan fails toward today (warmed-empty index), never a construction throw', () => {
    const store = {
      all: () => { throw new Error('disk gone'); },
    } as unknown as SessionOwnershipStore;
    const wa = makeWA(store);
    expect(wa.index.stats().entries).toBe(0);
    // Absent record on a standby ⇒ the legacy boolean (refuse) — today's verdict.
    expect(wa.evaluate('topic-scoped', { topicId: 1 }).admit).toBe(false);
  });
});

describe('OwnershipIndex — hook-then-warm ordering (§3.2.2)', () => {
  it('the onCommit hook is registered BEFORE the warm scan, so a pre-construction commit is seen via the scan and a post-construction commit via the hook', () => {
    const store = new InMemorySessionOwnershipStore();
    store.casWrite(rec('1', SELF, 'active', 1)); // pre-construction — covered by warm
    const wa = makeWA(store);
    expect(wa.index.lookup('1')).toEqual({ state: 'record', owner: SELF, status: 'active' });
    store.casWrite(rec('2', PEER, 'active', 1)); // post-construction — covered by the hook
    expect(wa.index.lookup('2')).toEqual({ state: 'record', owner: PEER, status: 'active' });
    expect(wa.index.stats().lastCasTransitionAt).not.toBeNull();
  });
});
