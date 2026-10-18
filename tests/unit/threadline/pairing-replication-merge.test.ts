// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Rollout step 5b (docs/specs/threadline-standalone-pairing.md D9/D11): the pairing method
 * as a sixth replicated field, the merge rule, inheritance wired on merge (gated), the
 * upgrade migration, and mixed-version behaviour. The merge tests run the real substrate:
 * CoherenceJournal (own stream), JournalSyncApplier (peer apply + commit observer),
 * ReplicatedPeerStreamReader, the no-clobber union reader, and AgentTrustManager.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  THREADLINE_PAIRING_KIND_REGISTRATION,
  THREADLINE_PAIRING_RECORD_KIND,
  THREADLINE_PAIRING_STORE_KEY,
  THREADLINE_PAIRING_STORE_KNOWN_FIELDS,
  REPLICATED_PAIRING_STATE,
  addPairingMethodWitnesses,
  buildThreadlinePairingRecordData,
  buildThreadlinePairingTombstoneData,
  deriveThreadlinePairingRecordKey,
  revokedPairings,
  evaluateInheritedVerification,
  pairingResultToOriginRecord,
  threadlinePairingRecordStoreSchema,
  type MergedPairingView,
  type VerifiedPairingResult,
} from '../../../src/core/ThreadlinePairingReplicatedStore.js';
import { ReplicatedKindRegistry, validateReplicatedEnvelope } from '../../../src/core/ReplicatedRecordEnvelope.js';
import { CoherenceJournal, type JournalEntry } from '../../../src/core/CoherenceJournal.js';
import { JournalSyncApplier, type ApplyBatchStream } from '../../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../../src/core/ReplicatedRecordEmitter.js';
import { ConflictStore } from '../../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../../src/core/RollbackUnmerge.js';
import type { HlcTimestamp } from '../../../src/core/HybridLogicalClock.js';
import type { OriginRecord } from '../../../src/core/UnionReader.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { createEncryptToPinnedResolver, createEncryptToPinnedCounters, type EncryptToPinnedMode } from '../../../src/threadline/encryptToPinned.js';
import { assertCanShareCredential } from '../../../src/threadline/CredentialShareGate.js';
import {
  applyReplicatedPairingInheritance,
  attachThreadlinePairingReplication,
  encryptToPinnedMultiMachineNote,
  isThreadlinePairingReplicationEnabled,
  type PairingReplicationWiring,
} from '../../../src/threadline/pairingReplicationWiring.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const SELF = 'm_self';
const PEER_A = 'm_peer_a';
const PEER_C = 'm_peer_c';
const VERIFIED_AT = '2026-10-01T12:00:00.000Z';
const ENFORCE: EncryptToPinnedMode = { enabled: true, dryRun: false };
const GATE_ON = { multiMachine: { stateSync: { threadlinePairing: { enabled: true, dryRun: true } } } };
const GATE_OFF = { multiMachine: { stateSync: { threadlinePairing: { enabled: false, dryRun: true } } } };

const peer = () => {
  const key = crypto.randomBytes(32).toString('hex');
  return { key, fp: key.slice(0, 32) };
};
const hlc = (physical: number, node: string, logical = 0): HlcTimestamp => ({ physical, logical, node });
const result = (p: { key: string; fp: string }, over: Partial<VerifiedPairingResult> = {}): VerifiedPairingResult => ({
  peerFp: p.fp, peerIdentityPub: p.key, state: REPLICATED_PAIRING_STATE, verifiedAt: VERIFIED_AT, verifiedOnMachine: PEER_A, ...over,
});
function view(p: { key: string; fp: string }, origin: string, method?: unknown, conflicted = false): MergedPairingView {
  const data = buildThreadlinePairingRecordData({ result: result(p, { verifiedOnMachine: origin }), hlc: hlc(1000, origin), origin })!;
  if (method !== undefined) data.pairingMethod = method;
  return { recordKey: data.recordKey as string, origin, data, conflicted };
}
function schemaValidate(raw: Record<string, unknown>) {
  let dropped = 0;
  const out = threadlinePairingRecordStoreSchema.validate(raw, { countDroppedField: () => { dropped++; }, countJailReject: () => {} });
  return { out, dropped };
}

// ── 1. Schema ────────────────────────────────────────────────────────────

describe('the sixth field: pairingMethod', () => {
  const p = peer();
  const base = { op: 'put', peerFp: p.fp, peerIdentityPub: p.key, state: 'mutual-verified', verifiedAt: VERIFIED_AT, verifiedOnMachine: PEER_A };

  it('is a known field (six in total)', () => {
    expect(THREADLINE_PAIRING_STORE_KNOWN_FIELDS).toContain('pairingMethod');
    expect(THREADLINE_PAIRING_STORE_KNOWN_FIELDS).toHaveLength(6);
  });

  it('accepts invite and sas and keeps them', () => {
    for (const m of ['invite', 'sas']) {
      const { out, dropped } = schemaValidate({ ...base, pairingMethod: m });
      expect(out).not.toBeNull();
      expect(out!.pairingMethod).toBe(m);
      expect(dropped).toBe(0);
    }
  });

  it('an unknown value is treated as ABSENT, not a rejected record (counted as dropped)', () => {
    for (const bad of ['inherited', 'magic', '<x>', 5, null, true]) {
      const { out, dropped } = schemaValidate({ ...base, pairingMethod: bad });
      expect(out).not.toBeNull();
      expect(out).not.toHaveProperty('pairingMethod');
      expect(dropped).toBe(1);
    }
  });

  it('a missing value stays absent (the merge treats absent as sas)', () => {
    const { out, dropped } = schemaValidate(base);
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('pairingMethod');
    expect(dropped).toBe(0);
    const d = evaluateInheritedVerification([view(p, PEER_A)], p.fp, undefined);
    expect(d).toMatchObject({ honor: true, pairingMethod: 'sas', pairingMethodKnown: false });
  });

  it('survives the full envelope validator (not dropped as unknown)', () => {
    let dropped = 0;
    const raw = { ...buildThreadlinePairingRecordData({ result: result(p, { pairingMethod: 'invite' }), hlc: hlc(1, PEER_A), origin: PEER_A })! };
    const env = validateReplicatedEnvelope(raw, threadlinePairingRecordStoreSchema, {
      bumpSchemaReject: () => {}, bumpDroppedField: () => { dropped++; }, bumpJailReject: () => {},
    });
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data.pairingMethod).toBe('invite');
    expect(dropped).toBe(0);
  });

  it('a tombstone may name the revoked key; a non-hex key is dropped and the revoke still stands', () => {
    const keyed = schemaValidate({ op: 'delete', deletedAt: VERIFIED_AT, peerIdentityPub: p.key });
    expect(keyed.out).toEqual({ deletedAt: VERIFIED_AT, peerIdentityPub: p.key });
    expect(keyed.dropped).toBe(0);
    const bad = schemaValidate({ op: 'delete', deletedAt: VERIFIED_AT, peerIdentityPub: '<zz>' });
    expect(bad.out).toEqual({ deletedAt: VERIFIED_AT });
    expect(bad.dropped).toBe(1);
    const built = buildThreadlinePairingTombstoneData({ peerFp: p.fp, hlc: hlc(1, SELF), origin: SELF, deletedAt: VERIFIED_AT, peerIdentityPub: p.key })!;
    expect(built.peerIdentityPub).toBe(p.key);
  });

  it('the sender includes invite|sas and omits anything else', () => {
    const withInvite = buildThreadlinePairingRecordData({ result: result(p, { pairingMethod: 'invite' }), hlc: hlc(1, SELF), origin: SELF })!;
    expect(withInvite.pairingMethod).toBe('invite');
    const withSas = buildThreadlinePairingRecordData({ result: result(p, { pairingMethod: 'sas' }), hlc: hlc(1, SELF), origin: SELF })!;
    expect(withSas.pairingMethod).toBe('sas');
    const bogus = buildThreadlinePairingRecordData({ result: result(p, { pairingMethod: 'inherited' as never }), hlc: hlc(1, SELF), origin: SELF })!;
    expect(bogus).not.toHaveProperty('pairingMethod');
    expect(pairingResultToOriginRecord(result(p, { pairingMethod: 'invite' }), SELF)!.data.pairingMethod).toBe('invite');
  });
});

// ── 2. Merge rule ────────────────────────────────────────────────────────

describe('merge rule: invite if ANY honoured view with the same single key says invite', () => {
  const p = peer();
  it('any invite → invite', () => {
    expect(evaluateInheritedVerification([view(p, PEER_A, 'sas', true), view(p, PEER_C, 'invite', true)], p.fp, undefined))
      .toMatchObject({ honor: true, pairingMethod: 'invite', pairingMethodKnown: true });
  });
  it('invite + absent (an older machine) → invite (mixed versions never downgrade)', () => {
    expect(evaluateInheritedVerification([view(p, PEER_A, 'invite', true), view(p, PEER_C, undefined, true)], p.fp, undefined))
      .toMatchObject({ honor: true, pairingMethod: 'invite', pairingMethodKnown: true });
  });
  it('all absent → sas, method not known', () => {
    expect(evaluateInheritedVerification([view(p, PEER_A), view(p, PEER_C)], p.fp, undefined))
      .toMatchObject({ honor: true, pairingMethod: 'sas', pairingMethodKnown: false });
  });
  it('sas only → sas, method known', () => {
    expect(evaluateInheritedVerification([view(p, PEER_A, 'sas')], p.fp, undefined))
      .toMatchObject({ honor: true, pairingMethod: 'sas', pairingMethodKnown: true });
  });
  it('different keys for the same fingerprint → no inheritance at all', () => {
    const other = { key: p.fp + 'c'.repeat(32), fp: p.fp };
    const d = evaluateInheritedVerification([view(p, PEER_A, 'invite', true), view(other, PEER_C, 'invite', true)], p.fp, undefined);
    expect(d.honor).toBe(false);
  });
});

describe('addPairingMethodWitnesses (sequential mixed versions)', () => {
  const p = peer();
  const rec = (origin: string, key: string, method?: 'invite' | 'sas', op: 'put' | 'delete' = 'put'): OriginRecord => {
    const recordKey = deriveThreadlinePairingRecordKey(p.fp)!;
    const data: Record<string, unknown> = op === 'put'
      ? { peerFp: p.fp, peerIdentityPub: key, state: REPLICATED_PAIRING_STATE, verifiedAt: VERIFIED_AT, verifiedOnMachine: origin, ...(method ? { pairingMethod: method } : {}) }
      : { deletedAt: VERIFIED_AT };
    return { origin, envelope: { recordKey, hlc: hlc(1000, origin), op, origin }, data };
  };

  it('a later record without the field does not hide an earlier invite from another origin (same key)', () => {
    const winner = view(p, PEER_C); // union winner: older machine, no field
    const all = [rec(PEER_C, p.key), rec(PEER_A, p.key, 'invite')];
    const views = addPairingMethodWitnesses([winner], () => all);
    expect(views).toHaveLength(2);
    expect(evaluateInheritedVerification(views, p.fp, undefined)).toMatchObject({ honor: true, pairingMethod: 'invite' });
  });

  it('never adds a witness for a different key, a tombstone, or a dropped origin', () => {
    const winner = view(p, PEER_C);
    const all = [rec(PEER_C, p.key), rec(PEER_A, 'dd'.repeat(32), 'invite'), rec('m_x', p.key, 'invite', 'delete'), rec('m_dropped', p.key, 'invite')];
    const views = addPairingMethodWitnesses([winner], () => all, new Set(['m_dropped']));
    expect(views).toHaveLength(1);
    expect(evaluateInheritedVerification(views, p.fp, undefined)).toMatchObject({ honor: true, pairingMethod: 'sas', pairingMethodKnown: false });
  });
});

// ── 3. Inheritance on merge (real substrate) ─────────────────────────────

describe('inheritance wired on merge', () => {
  let dir: string;
  let journal: CoherenceJournal;
  let applier: JournalSyncApplier;
  let reader: ReplicatedPeerStreamReader;
  let registry: ReplicatedKindRegistry;
  let trust: AgentTrustManager;
  let wiring: PairingReplicationWiring | null;
  const seq: Record<string, number> = {};

  let tick = 5000;
  /** The server's attach call, verbatim in shape: real journal-backed emitter, real streams. */
  function makeWiring(config: unknown): PairingReplicationWiring | null {
    return attachThreadlinePairingReplication({
      config: config as never,
      trust,
      emitter: new ReplicatedRecordEmitter({
        journal,
        clock: { tick: () => hlc(++tick, SELF) },
        registry,
        origin: SELF,
        stores: () => ({ threadlinePairing: { enabled: true } }),
        loadWitness: (store, rk) => reader.loadWitness(store, rk),
      }),
      ownOrigin: SELF,
      registry,
      stores: { threadlinePairing: { enabled: true } },
      streams: reader,
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    });
  }

  function applyEntry(origin: string, data: Record<string, unknown>): void {
    seq[origin] = (seq[origin] ?? 0) + 1;
    const entry: JournalEntry = { seq: seq[origin], ts: new Date(2026, 9, 1).toISOString(), machine: origin, kind: THREADLINE_PAIRING_RECORD_KIND, data };
    const batch: ApplyBatchStream[] = [{ kind: THREADLINE_PAIRING_RECORD_KIND, incarnation: `inc-${origin}`, entries: [entry] }];
    applier.apply(origin, batch);
  }

  /** A peer machine's record arrives through the real applier; the commit observer is the merge hook. */
  function applyPeer(origin: string, p: { key: string; fp: string }, physical: number, method?: 'invite' | 'sas', observed?: number): void {
    applyEntry(origin, buildThreadlinePairingRecordData({
      result: result(p, { verifiedOnMachine: origin, pairingMethod: method }), hlc: hlc(physical, origin), origin,
      ...(observed !== undefined ? { observed: hlc(observed, 'witness') } : {}),
    })!);
  }

  /** A peer machine's revoke (tombstone) arrives through the real applier. */
  function applyRevoke(origin: string, p: { key: string; fp: string }, physical: number, opts: { observed?: number; keyed?: boolean } = {}): void {
    applyEntry(origin, buildThreadlinePairingTombstoneData({
      peerFp: p.fp, hlc: hlc(physical, origin), origin, deletedAt: VERIFIED_AT,
      ...(opts.keyed === false ? {} : { peerIdentityPub: p.key }),
      ...(opts.observed !== undefined ? { observed: hlc(opts.observed, 'witness') } : {}),
    })!);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-merge-'));
    registry = new ReplicatedKindRegistry();
    registry.register(THREADLINE_PAIRING_KIND_REGISTRATION);
    journal = new CoherenceJournal({ stateDir: dir, machineId: SELF, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
    reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: SELF, autoRebuild: false });
    trust = new AgentTrustManager({ stateDir: dir, machineId: SELF });
    wiring = null;
    // The server's observer: index first, then the merge hook (null unless the gate is on).
    applier.setReplicatedRecordCommitObserver((_s, kind, entries) => {
      reader.observeCommittedEntries(kind, entries);
      wiring?.onRecordsCommitted(kind);
    });
    for (const k of Object.keys(seq)) delete seq[k];
    tick = 5000;
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best effort */ }
    trust.flush();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/pairing-replication-merge.test.ts' });
  });

  it('gate off: no wiring, a received record is NOT inherited', () => {
    expect(isThreadlinePairingReplicationEnabled(GATE_OFF)).toBe(false);
    expect(isThreadlinePairingReplicationEnabled({})).toBe(false);
    wiring = makeWiring(GATE_OFF);
    expect(wiring).toBeNull();
    const p = peer();
    applyPeer(PEER_A, p, 1000, 'invite');
    expect(reader.listRecordKeys(THREADLINE_PAIRING_STORE_KEY)).toHaveLength(1); // the record did land
    expect(trust.getProfileByFingerprint(p.fp)).toBeNull();
  });

  it('gate on: a received invite record is inherited WITH its method, and enforce encrypts to the pinned key here', () => {
    wiring = makeWiring(GATE_ON);
    expect(wiring).not.toBeNull();
    const p = peer();
    applyPeer(PEER_A, p, 1000, 'invite');
    expect(trust.getProfileByFingerprint(p.fp)).toMatchObject({
      pairingState: 'identity-verified', pairingMethod: 'invite', peerIdentityPub: p.key, inheritedFromMachine: PEER_A,
    });
    const counters = createEncryptToPinnedCounters();
    const resolve = createEncryptToPinnedResolver({ trustManager: trust, mode: () => ENFORCE, counters });
    expect(resolve(p.fp, 'send')!.toString('hex')).toBe(p.key);
    expect(counters.encryptedToPinned).toBe(1);
  });

  it('a record from an older machine (no field) is inherited as inherited, and enforce keeps the older rule', () => {
    wiring = makeWiring(GATE_ON);
    const p = peer();
    applyPeer(PEER_C, p, 1000);
    expect(trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', pairingMethod: 'inherited' });
    expect(createEncryptToPinnedResolver({ trustManager: trust, mode: () => ENFORCE })(p.fp, 'send')).toBeNull();
  });

  it('a sas record is inherited as sas (not invite)', () => {
    wiring = makeWiring(GATE_ON);
    const p = peer();
    applyPeer(PEER_A, p, 1000, 'sas');
    expect(trust.getProfileByFingerprint(p.fp)!.pairingMethod).toBe('sas');
    expect(createEncryptToPinnedResolver({ trustManager: trust, mode: () => ENFORCE })(p.fp, 'send')).toBeNull();
  });

  it('mixed versions, sequential: a LATER record without the field never downgrades a known invite', () => {
    wiring = makeWiring(GATE_ON);
    const p = peer();
    applyPeer(PEER_A, p, 1000, 'invite');
    applyPeer(PEER_C, p, 2000); // older machine re-verified the same key later, no field
    expect(trust.getProfileByFingerprint(p.fp)!.pairingMethod).toBe('invite');
    // and the same origin replacing its own record without the field (an older build) too
    applyPeer(PEER_A, p, 3000);
    expect(trust.getProfileByFingerprint(p.fp)!.pairingMethod).toBe('invite');
  });

  it('never swaps a locally established mutual-verified pin for a different key', () => {
    wiring = makeWiring(GATE_ON);
    const local = peer();
    expect(trust.markInviteVerified(local.fp, { peerIdentityPub: local.key, via: 'finish' })).toBe(true);
    const forged = { fp: local.fp, key: local.fp + 'e'.repeat(32) };
    applyPeer(PEER_A, forged, 1000, 'invite');
    expect(trust.getProfileByFingerprint(local.fp)).toMatchObject({
      pairingState: 'mutual-verified', pairingMethod: 'invite', peerIdentityPub: local.key, source: 'mutual-verified',
    });
    expect(wiring!.applyNow()).toMatchObject({ localWins: 1, inherited: 0 });
  });

  it('is idempotent: re-running the pass leaves an inherited profile untouched', () => {
    wiring = makeWiring(GATE_ON);
    const p = peer();
    applyPeer(PEER_A, p, 1000, 'invite');
    const before = JSON.stringify(trust.getProfileByFingerprint(p.fp));
    expect(wiring!.applyNow()).toMatchObject({ peers: 1, unchanged: 1, inherited: 0 });
    expect(JSON.stringify(trust.getProfileByFingerprint(p.fp))).toBe(before);
  });

  it('migration: re-sends local invite pairings once (gate on), idempotent across restarts', () => {
    const inv = peer(), sas = peer(), inh = peer();
    expect(trust.markInviteVerified(inv.fp, { peerIdentityPub: inv.key, via: 'finish' })).toBe(true); // no emitter yet: the pre-upgrade state
    expect(trust.recordPendingVerification(sas.fp, { pairingId: 'pid', peerIdentityPub: sas.key, sasWords: ['a', 'b'], sasFingerprint: 'sfp' })).toBe(true);
    expect(trust.markMutualVerified(sas.fp, { pairingId: 'pid', operatorConfirm: true })).toBe(true);
    expect(trust.inheritReplicatedVerification(inh.fp, { peerIdentityPub: inh.key, pairingMethod: 'invite' })).toBe(true);
    expect(reader.listRecordKeys(THREADLINE_PAIRING_STORE_KEY)).toHaveLength(0);

    wiring = makeWiring(GATE_ON); // attach runs start(): migration, then a pass
    journal.flush();
    expect(reader.listRecordKeys(THREADLINE_PAIRING_STORE_KEY)).toHaveLength(1); // only the LOCAL invite pairing
    const own = reader.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, deriveThreadlinePairingRecordKey(inv.fp)!);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ origin: SELF, data: { pairingMethod: 'invite', peerIdentityPub: inv.key } });
    expect(own[0].envelope.hlc.physical).toBeGreaterThan(5000); // a fresh timestamp

    // Next start: the own stream already carries 'invite' for that key — nothing re-sent.
    expect(makeWiring(GATE_ON)!.start().republished).toBe(0);
    expect(wiring!.start().republished).toBe(0);
    journal.flush();
    expect(reader.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, deriveThreadlinePairingRecordKey(inv.fp)!)[0].envelope.hlc.physical)
      .toBe(own[0].envelope.hlc.physical);
  });

  it('migration does nothing with the gate off', () => {
    const inv = peer();
    trust.markInviteVerified(inv.fp, { peerIdentityPub: inv.key, via: 'finish' });
    expect(makeWiring(GATE_OFF)).toBeNull();
    trust.markVerificationFailed(inv.fp, 'x'); // no sender attached either: nothing emitted
    journal.flush();
    expect(reader.listRecordKeys(THREADLINE_PAIRING_STORE_KEY)).toHaveLength(0);
  });

  it('a new invite verification sends the method; a new SAS verification sends sas', () => {
    wiring = makeWiring(GATE_ON);
    const inv = peer(), sas = peer();
    trust.markInviteVerified(inv.fp, { peerIdentityPub: inv.key, via: 'finish' });
    trust.recordPendingVerification(sas.fp, { pairingId: 'pid', peerIdentityPub: sas.key, sasWords: ['a'], sasFingerprint: 'sfp' });
    trust.markMutualVerified(sas.fp, { pairingId: 'pid', operatorConfirm: true });
    journal.flush();
    expect(reader.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, deriveThreadlinePairingRecordKey(inv.fp)!)[0].data.pairingMethod).toBe('invite');
    expect(reader.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, deriveThreadlinePairingRecordKey(sas.fp)!)[0].data.pairingMethod).toBe('sas');
  });
});

describe('revokes forget the INHERITED pin', () => {
  let dir: string;
  let journal: CoherenceJournal;
  let applier: JournalSyncApplier;
  let reader: ReplicatedPeerStreamReader;
  let registry: ReplicatedKindRegistry;
  let trust: AgentTrustManager;
  let wiring: PairingReplicationWiring | null;
  const seq: Record<string, number> = {};

  function applyEntry(origin: string, data: Record<string, unknown>): void {
    seq[origin] = (seq[origin] ?? 0) + 1;
    const entry: JournalEntry = { seq: seq[origin], ts: new Date(2026, 9, 1).toISOString(), machine: origin, kind: THREADLINE_PAIRING_RECORD_KIND, data };
    applier.apply(origin, [{ kind: THREADLINE_PAIRING_RECORD_KIND, incarnation: `inc-${origin}`, entries: [entry] }]);
  }
  const put = (origin: string, p: { key: string; fp: string }, physical: number, method?: 'invite' | 'sas', observed?: number) =>
    applyEntry(origin, buildThreadlinePairingRecordData({
      result: result(p, { verifiedOnMachine: origin, pairingMethod: method }), hlc: hlc(physical, origin), origin,
      ...(observed !== undefined ? { observed: hlc(observed, 'witness') } : {}),
    })!);
  const revoke = (origin: string, p: { key: string; fp: string }, physical: number, opts: { observed?: number; keyed?: boolean } = {}) =>
    applyEntry(origin, buildThreadlinePairingTombstoneData({
      peerFp: p.fp, hlc: hlc(physical, origin), origin, deletedAt: VERIFIED_AT,
      ...(opts.keyed === false ? {} : { peerIdentityPub: p.key }),
      ...(opts.observed !== undefined ? { observed: hlc(opts.observed, 'witness') } : {}),
    })!);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-revoke-'));
    registry = new ReplicatedKindRegistry();
    registry.register(THREADLINE_PAIRING_KIND_REGISTRATION);
    journal = new CoherenceJournal({ stateDir: dir, machineId: SELF, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
    reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: SELF, autoRebuild: false });
    trust = new AgentTrustManager({ stateDir: dir, machineId: SELF });
    let tick = 9000;
    wiring = attachThreadlinePairingReplication({
      config: GATE_ON, trust,
      emitter: new ReplicatedRecordEmitter({
        journal, clock: { tick: () => hlc(++tick, SELF) }, registry, origin: SELF,
        stores: () => ({ threadlinePairing: { enabled: true } }),
        loadWitness: (store, rk) => reader.loadWitness(store, rk),
      }),
      ownOrigin: SELF, registry, stores: { threadlinePairing: { enabled: true } }, streams: reader,
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    });
    applier.setReplicatedRecordCommitObserver((_s, kind, entries) => {
      reader.observeCommittedEntries(kind, entries);
      wiring?.onRecordsCommitted(kind);
    });
    for (const k of Object.keys(seq)) delete seq[k];
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best effort */ }
    trust.flush();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/pairing-replication-merge.test.ts' });
  });

  it('a revoke (person unpaired on machine A) removes the inherited pin: credentials refused, encrypt-to-pinned null', () => {
    const p = peer();
    put(PEER_A, p, 1000, 'invite');
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBe('identity-verified');
    expect(assertCanShareCredential(trust, p.fp).allow).toBe(true);
    expect(createEncryptToPinnedResolver({ trustManager: trust, mode: () => ENFORCE })(p.fp, 'send')!.toString('hex')).toBe(p.key);

    revoke(PEER_A, p, 2000);
    const prof = trust.getProfileByFingerprint(p.fp)!;
    expect(prof.pairingState).toBeUndefined();
    expect(prof.peerIdentityPub).toBeUndefined();
    expect(prof.source).toBe('setup-default');
    expect(trust.isCredentialShareAllowedByFingerprint(p.fp)).toBe(false);
    expect(assertCanShareCredential(trust, p.fp).allow).toBe(false);
    expect(createEncryptToPinnedResolver({ trustManager: trust, mode: () => ENFORCE })(p.fp, 'send')).toBeNull();
  });

  it('a revoke from ANOTHER machine that saw the put (witness) also applies', () => {
    const p = peer();
    put(PEER_A, p, 1000, 'invite');
    revoke(PEER_C, p, 2000, { observed: 1000 });
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBeUndefined();
  });

  it('a tombstone from an older machine (no key) revokes by fingerprint', () => {
    const p = peer();
    put(PEER_A, p, 1000, 'invite');
    revoke(PEER_A, p, 2000, { keyed: false });
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBeUndefined();
  });

  it('a locally established pairing is untouched by a revoke', () => {
    const local = peer();
    expect(trust.markInviteVerified(local.fp, { peerIdentityPub: local.key, via: 'finish' })).toBe(true);
    revoke(PEER_A, local, 2000);
    expect(trust.getProfileByFingerprint(local.fp)).toMatchObject({ pairingState: 'mutual-verified', peerIdentityPub: local.key, source: 'mutual-verified' });
    expect(trust.isCredentialShareAllowedByFingerprint(local.fp)).toBe(true);
  });

  it('a revoke for key K does not touch an inherited pin to a different key', () => {
    const p = peer();
    trust.inheritReplicatedVerification(p.fp, { peerIdentityPub: p.key, pairingMethod: 'invite' });
    revoke(PEER_A, { fp: p.fp, key: p.fp + '0'.repeat(32) }, 2000);
    expect(trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', peerIdentityPub: p.key });
    expect(trust.isCredentialShareAllowedByFingerprint(p.fp)).toBe(true);
  });

  it('a revoke then a NEWER record re-inherits (the newer one wins)', () => {
    const p = peer();
    put(PEER_A, p, 1000, 'invite');
    revoke(PEER_A, p, 2000);
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBeUndefined();
    put(PEER_A, p, 3000, 'invite');
    expect(trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', pairingMethod: 'invite', peerIdentityPub: p.key });
    // and from another machine that saw the revoke
    revoke(PEER_A, p, 4000);
    put(PEER_C, p, 5000, 'invite', 4000);
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBe('identity-verified');
  });

  it('a NEWER put already in force is not undone by an older revoke arriving late', () => {
    const p = peer();
    put(PEER_C, p, 3000, 'invite', 2000); // C re-paired after seeing A's revoke at 2000
    revoke(PEER_A, p, 2000);              // the older revoke lands afterwards
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBe('identity-verified');
  });

  it('a revoke CONCURRENT with a put (no order) fails closed', () => {
    const p = peer();
    put(PEER_A, p, 1000, 'invite');
    put(PEER_C, p, 1500, 'invite');      // concurrent puts, same key: inherited
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBe('identity-verified');
    revoke(PEER_A, p, 2000);             // A revoked, C never saw it: open conflict with a tombstone
    expect(trust.getProfileByFingerprint(p.fp)!.pairingState).toBeUndefined();
  });

  it('revokedPairings respects the union winner', () => {
    const p = peer();
    put(PEER_A, p, 1000);
    revoke(PEER_A, p, 2000);
    const rk = deriveThreadlinePairingRecordKey(p.fp)!;
    const tomb = reader.loadOriginRecords(THREADLINE_PAIRING_STORE_KEY, rk);
    expect(revokedPairings(new Map([[rk, { recordKey: rk, value: null, conflict: null, divergenceFlag: false }]]), () => tomb).get(rk))
      .toMatchObject({ unkeyed: false });
    expect(revokedPairings(new Map([[rk, { recordKey: rk, value: tomb[0], conflict: null, divergenceFlag: false }]]), () => tomb).size).toBe(0);
  });
});

describe('applyReplicatedPairingInheritance — local authority', () => {
  it('a local invite-accepted (possibly paused) pairing is not overridden', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-local-'));
    try {
      const t = new AgentTrustManager({ stateDir: dir });
      const p = peer();
      t.recordInviteAccepted(p.fp, { peerIdentityPub: p.key });
      expect(applyReplicatedPairingInheritance([view(p, PEER_A, 'invite')], t)).toMatchObject({ localWins: 1, inherited: 0 });
      expect(t.getProfileByFingerprint(p.fp)!.pairingState).toBe('invite-accepted');
      t.flush();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/pairing-replication-merge.test.ts' });
    }
  });
});

describe('item 7: startup note', () => {
  it('only for enforce + more than one machine + replication off', () => {
    expect(encryptToPinnedMultiMachineNote({ encryptToPinnedMode: 'enforce', activeMachineCount: 2, pairingReplicationEnabled: false })).toMatch(/threadlinePairing\.enabled is off/);
    expect(encryptToPinnedMultiMachineNote({ encryptToPinnedMode: 'enforce', activeMachineCount: 2, pairingReplicationEnabled: true })).toBeNull();
    expect(encryptToPinnedMultiMachineNote({ encryptToPinnedMode: 'enforce', activeMachineCount: 1, pairingReplicationEnabled: false })).toBeNull();
    expect(encryptToPinnedMultiMachineNote({ encryptToPinnedMode: 'watch', activeMachineCount: 3, pairingReplicationEnabled: false })).toBeNull();
  });
});
