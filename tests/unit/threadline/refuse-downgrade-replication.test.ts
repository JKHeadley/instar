// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Rollout step 6 (docs/specs/threadline-standalone-pairing.md D11): the encryptedSeen mark is ONE
 * record for the whole agent. Two machines, each with the real substrate the step 5b tests use
 * (CoherenceJournal own stream → JournalSyncApplier peer apply + commit observer →
 * ReplicatedPeerStreamReader → no-clobber union → attachThreadlinePairingReplication →
 * AgentTrustManager). Records travel by shipping one machine's real journal entries into the
 * other's applier, so a relay that downgrades by aiming at whichever machine takes over finds
 * the same mark there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isAcceptableIdentityKey } from '@sagemindai/threadline-core';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

import {
  THREADLINE_PAIRING_KIND_REGISTRATION,
  THREADLINE_PAIRING_RECORD_KIND,
  THREADLINE_PAIRING_STORE_KEY,
  ENCRYPTED_SEEN_STATE,
  ENCRYPTED_SEEN_UNPAIRED_STATE,
  buildEncryptedSeenRecordData,
  deriveEncryptedSeenRecordKey,
  threadlinePairingRecordStoreSchema,
} from '../../../src/core/ThreadlinePairingReplicatedStore.js';
import { ReplicatedKindRegistry, validateReplicatedEnvelope } from '../../../src/core/ReplicatedRecordEnvelope.js';
import { CoherenceJournal } from '../../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../../src/core/ReplicatedRecordEmitter.js';
import { ConflictStore } from '../../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../../src/core/RollbackUnmerge.js';
import type { HlcTimestamp } from '../../../src/core/HybridLogicalClock.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { attachThreadlinePairingReplication, type PairingReplicationWiring } from '../../../src/threadline/pairingReplicationWiring.js';
import {
  createRefuseDowngradeCounters,
  noteEncryptedChat,
  shouldRefuseDowngradedPlaintext,
  type RefuseDowngradeMode,
} from '../../../src/threadline/refuseDowngrade.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const WATCH: RefuseDowngradeMode = { enabled: true, dryRun: true };
const ENFORCE: RefuseDowngradeMode = { enabled: true, dryRun: false };
const GATE_ON = { multiMachine: { stateSync: { threadlinePairing: { enabled: true, dryRun: true } } } };
const STORES = { threadlinePairing: { enabled: true } };

const peer = () => {
  // A real Ed25519 key: random bytes are often not a curve point, which pinning refuses (SEC-16, #2229).
  const key = generateIdentityKeyPair().publicKey.toString('hex');
  return { key, fp: key.slice(0, 32) };
};
const chat = (p: { fp: string; key: string }) => ({ from: p.fp, content: { content: 'hello' }, senderIdentityPub: Buffer.from(p.key, 'hex') });

interface Machine {
  id: string;
  dir: string;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  trust: AgentTrustManager;
  wiring: PairingReplicationWiring | null;
  shipped: Record<string, number>;
}

let tick = 1_000_000; // one clock order across both machines: HLC order = the order things happened
const dirs: string[] = [];

function machine(id: string): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `refuse-downgrade-${id}-`));
  dirs.push(dir);
  const registry = new ReplicatedKindRegistry();
  registry.register(THREADLINE_PAIRING_KIND_REGISTRATION);
  const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: id, autoRebuild: false });
  const trust = new AgentTrustManager({ stateDir: dir, machineId: id });
  const m: Machine = { id, dir, journal, applier, reader, trust, wiring: null, shipped: {} };
  // Own records are indexed as they commit (the server's own-stream observer), then the merge hook.
  journal.setReplicatedRecordCommitObserver((kind, entries) => {
    reader.observeCommittedEntries(kind, entries);
    m.wiring?.onRecordsCommitted(kind);
  });
  applier.setReplicatedRecordCommitObserver((_s, kind, entries) => {
    reader.observeCommittedEntries(kind, entries);
    m.wiring?.onRecordsCommitted(kind);
  });
  m.wiring = attachThreadlinePairingReplication({
    config: GATE_ON, trust,
    emitter: new ReplicatedRecordEmitter({
      journal, clock: { tick: (): HlcTimestamp => ({ physical: ++tick, logical: 0, node: id }) }, registry, origin: id,
      stores: () => STORES,
      loadWitness: (store, rk) => reader.loadWitness(store, rk),
    }),
    ownOrigin: id, registry, stores: STORES, streams: reader,
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });
  return m;
}

/** Ship every journal entry `from` wrote since the last ship into `to`'s real applier. */
function ship(from: Machine, to: Machine): number {
  from.journal.flush();
  const all = from.journal.readTail(THREADLINE_PAIRING_RECORD_KIND, 10_000).entries;
  const since = from.shipped[to.id] ?? 0;
  const entries = all.filter((e) => e.seq > since).sort((x, y) => x.seq - y.seq); // readTail is newest-first
  if (entries.length === 0) return 0;
  from.shipped[to.id] = entries[entries.length - 1].seq;
  const incarnation = from.journal.getOwnAdvert()[THREADLINE_PAIRING_RECORD_KIND]?.incarnation ?? `inc-${from.id}`;
  to.applier.apply(from.id, [{ kind: THREADLINE_PAIRING_RECORD_KIND, incarnation, entries }]);
  return entries.length;
}

describe('the mark record on the wire', () => {
  it('validates through the real envelope validator; a seen record needs a key and a date', () => {
    const p = peer();
    const data = buildEncryptedSeenRecordData({ peerFp: p.fp, peerIdentityPub: p.key, kind: 'seen', at: '2026-10-01T00:00:00.000Z', hlc: { physical: 1, logical: 0, node: 'm1' }, origin: 'm1' })!;
    expect(data.recordKey).toBe(deriveEncryptedSeenRecordKey(p.fp, 'm1'));
    expect(deriveEncryptedSeenRecordKey(p.fp, 'm1')).not.toBe(deriveEncryptedSeenRecordKey(p.fp, 'm2'));
    let dropped = 0;
    const env = validateReplicatedEnvelope({ ...data }, threadlinePairingRecordStoreSchema, { bumpSchemaReject: () => {}, bumpDroppedField: () => { dropped++; }, bumpJailReject: () => {} });
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data).toMatchObject({ state: ENCRYPTED_SEEN_STATE, encryptedSeenAt: '2026-10-01T00:00:00.000Z', peerIdentityPub: p.key });
    expect(dropped).toBe(0);
    const v = (raw: Record<string, unknown>) => threadlinePairingRecordStoreSchema.validate(raw, { countDroppedField: () => {}, countJailReject: () => {} });
    expect(v({ op: 'put', peerFp: p.fp, state: ENCRYPTED_SEEN_STATE, encryptedSeenAt: '2026-10-01T00:00:00.000Z' })).toBeNull();
    expect(v({ op: 'put', peerFp: p.fp, peerIdentityPub: p.key, state: ENCRYPTED_SEEN_STATE, encryptedSeenAt: '<x>' })).toBeNull();
    expect(v({ op: 'put', peerFp: p.fp, state: ENCRYPTED_SEEN_UNPAIRED_STATE, unpairedAt: '2026-10-01T00:00:00.000Z' })).toMatchObject({ state: ENCRYPTED_SEEN_UNPAIRED_STATE });
    expect(buildEncryptedSeenRecordData({ peerFp: p.fp, kind: 'seen', at: '2026-10-01T00:00:00.000Z', hlc: { physical: 1, logical: 0, node: 'm1' }, origin: 'm1' })).toBeNull();
  });
});

describe('the mark is unified across an agent\'s machines', () => {
  let A: Machine;
  let B: Machine;
  beforeEach(() => {
    A = machine('m_a');
    B = machine('m_b');
  });
  afterEach(() => {
    for (const m of [A, B]) {
      try { m.journal.close(); } catch { /* best effort */ }
      m.trust.flush();
    }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/threadline/refuse-downgrade-replication.test.ts' });
  });

  /** A pairs the peer by invite and B inherits it. */
  function pairOnA(p: { key: string; fp: string }): void {
    expect(A.trust.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    ship(A, B);
    expect(B.trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', pairingMethod: 'invite', peerIdentityPub: p.key });
  }

  it('a mark set on machine A appears on machine B, and B (enforce) refuses plaintext from that peer', () => {
    const p = peer();
    pairOnA(p);
    // Before any encrypted chat, B does not refuse (the peer may be pre-D9 Instar).
    expect(shouldRefuseDowngradedPlaintext({ trustManager: B.trust, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);

    expect(noteEncryptedChat({ trustManager: A.trust, mode: () => WATCH }, chat(p))).toBe(true);
    const atA = A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt!;
    expect(atA).toBeDefined();
    expect(B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();

    ship(A, B);
    expect(B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(atA);
    const c = createRefuseDowngradeCounters();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: B.trust, mode: () => ENFORCE, counters: c }, p.fp, undefined)).toBe(true);
    expect(c.refusedDowngrade).toBe(1);
  });

  it('a mark set on B (the machine holding the relay) reaches A\'s own pairing too', () => {
    const p = peer();
    pairOnA(p);
    expect(noteEncryptedChat({ trustManager: B.trust, mode: () => ENFORCE }, chat(p))).toBe(true);
    ship(B, A);
    expect(A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt);
    expect(shouldRefuseDowngradedPlaintext({ trustManager: A.trust, mode: () => ENFORCE }, p.fp, undefined)).toBe(true);
  });

  it('union keeps the earliest time: both machines end with the same, earliest mark', async () => {
    const p = peer();
    pairOnA(p);
    noteEncryptedChat({ trustManager: B.trust, mode: () => WATCH }, chat(p));
    const early = B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt!;
    await new Promise((r) => setTimeout(r, 10));
    noteEncryptedChat({ trustManager: A.trust, mode: () => WATCH }, chat(p));
    const late = A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt!;
    expect(Date.parse(late)).toBeGreaterThan(Date.parse(early));
    ship(A, B); ship(B, A);
    expect(A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(early);
    expect(B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(early);
    // Re-shipping (idempotent) changes nothing.
    ship(A, B); ship(B, A);
    expect(A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(early);
  });

  it('removed only by an unpair: the person unpairs on A, B drops the pin and the mark; a re-pair starts clean', () => {
    const p = peer();
    pairOnA(p);
    noteEncryptedChat({ trustManager: B.trust, mode: () => ENFORCE }, chat(p));
    ship(B, A);
    expect(A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeDefined();

    expect(A.trust.markVerificationFailed(p.fp, 'the person unpaired')).toBe(true);
    ship(A, B);
    expect(B.trust.getProfileByFingerprint(p.fp)!.pairingState).toBeUndefined();
    expect(B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: B.trust, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);

    // The person pairs the same agent again on A: B inherits it, and B's OLD mark (recorded
    // before the unpair) does not come back.
    expect(A.trust.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    ship(A, B); ship(B, A);
    expect(B.trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', pairingMethod: 'invite' });
    expect(B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
    expect(A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
  });

  it('a pause (demote after a second accept) is not an unpair: the mark comes back with the re-confirmed pin', () => {
    const p = peer();
    pairOnA(p);
    noteEncryptedChat({ trustManager: A.trust, mode: () => WATCH }, chat(p));
    ship(A, B);
    const at = B.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt!;
    expect(A.trust.demoteInvitePairing(p.fp, 'second accept')).toBe(true);
    ship(A, B);
    expect(B.trust.getProfileByFingerprint(p.fp)!.pairingState).toBeUndefined(); // inherited pin forgotten
    expect(A.trust.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true); // the person re-confirms
    ship(A, B);
    expect(B.trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', encryptedSeenAt: at });
  });

  it('a key change never inherits the old mark: a pause cannot swap the key, and a re-pair with a DIFFERENT key after an unpair ignores B\'s old mark record (Echo, step 6 review)', () => {
    const p = peer();
    pairOnA(p);
    // The mark is recorded on B, so B holds a mark record bound to the OLD key.
    noteEncryptedChat({ trustManager: B.trust, mode: () => WATCH }, chat(p));
    ship(B, A);
    expect(A.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeDefined();
    // Same fingerprint, a different full key: a new agent (D8).
    // A VALID curve point (SEC-16, #2229), so only the never-swap rule can refuse it while paused.
    let other = '';
    do { other = p.fp + crypto.randomBytes(16).toString('hex'); } while (!isAcceptableIdentityKey(Buffer.from(other, 'hex')));
    // A pause does not let the key be swapped (only re-pairing after an unpair can).
    expect(A.trust.demoteInvitePairing(p.fp, 'second accept')).toBe(true);
    expect(A.trust.markInviteVerified(p.fp, { peerIdentityPub: other, via: 'finish' })).toBe(false);
    // The person unpairs, then pairs the agent that now presents the new key.
    expect(A.trust.markVerificationFailed(p.fp, 'the person unpaired')).toBe(true);
    ship(A, B);
    expect(A.trust.markInviteVerified(p.fp, { peerIdentityPub: other, via: 'finish' })).toBe(true);
    ship(A, B); ship(B, A); ship(A, B);
    for (const m of [A, B]) {
      expect(['mutual-verified', 'identity-verified']).toContain(m.trust.getProfileByFingerprint(p.fp)!.pairingState);
      expect(m.trust.getProfileByFingerprint(p.fp)!.peerIdentityPub).toBe(other);
      expect(m.trust.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
      expect(shouldRefuseDowngradedPlaintext({ trustManager: m.trust, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);
    }
  });

  it('an SAS pairing replicated to B is unaffected: no mark is recorded and plaintext is not refused', () => {
    const p = peer();
    expect(A.trust.recordPendingVerification(p.fp, { pairingId: 'pid', peerIdentityPub: p.key, sasWords: ['a'], sasFingerprint: 'sfp', ownFp: 'f'.repeat(32) })).toBe(true);
    expect(A.trust.markMutualVerified(p.fp, { pairingId: 'pid', operatorConfirm: true })).toBe(true);
    ship(A, B);
    expect(B.trust.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', pairingMethod: 'sas' });
    expect(noteEncryptedChat({ trustManager: B.trust, mode: () => ENFORCE }, chat(p))).toBe(false);
    expect(noteEncryptedChat({ trustManager: A.trust, mode: () => ENFORCE }, chat(p))).toBe(false);
    expect(shouldRefuseDowngradedPlaintext({ trustManager: B.trust, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);
  });

  it('mark records never disturb pairing inheritance (no extra peers, no refusals counted)', () => {
    const p = peer();
    pairOnA(p);
    noteEncryptedChat({ trustManager: A.trust, mode: () => WATCH }, chat(p));
    ship(A, B);
    expect(B.wiring!.applyNow()).toMatchObject({ peers: 1, refused: 0, unchanged: 1 });
    expect(B.reader.listRecordKeys(THREADLINE_PAIRING_STORE_KEY)).toHaveLength(2); // the pairing + A's mark
  });

  it('a mark record for a peer with no pairing record is not read as a pairing (no peer, no refusal, no profile)', () => {
    const p = peer();
    // A recorded a mark for a peer this agent holds no replicated pairing for (e.g. a local-only pin).
    A.trust.inheritReplicatedVerification(p.fp, { peerIdentityPub: p.key, pairingMethod: 'invite' }); // local to A, not replicated
    expect(noteEncryptedChat({ trustManager: A.trust, mode: () => WATCH }, chat(p))).toBe(true);
    ship(A, B);
    expect(B.reader.listRecordKeys(THREADLINE_PAIRING_STORE_KEY)).toHaveLength(1); // only the mark
    expect(B.wiring!.applyNow()).toMatchObject({ peers: 0, refused: 0, inherited: 0, marksMerged: 0 });
    expect(B.trust.getProfileByFingerprint(p.fp)).toBeNull();
  });
});
