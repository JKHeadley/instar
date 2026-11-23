// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * SEC-088 part 2 — transport side (docs/specs/trust-records-holder-authored.md decisions 2 + 5).
 *
 *  - signed `journal-sync` responses: valid accepted, unsigned accepted (older build), invalid
 *    refuses the response's trust-grant-record entries only (other kinds pass) and is counted as
 *    `journal.sync.badSignature`;
 *  - origin binding: a trust-grant-record whose payload origin is not the sender is `forged`
 *    (batch stops, nothing appended, counted);
 *  - a replica whose sender is this machine's own id is refused and counted;
 *  - `loadAllRecordsWithWriter`: writer from entry.machine (never the payload), first record per
 *    (writer, recordKey) wins, own stream included, other stores untouched.
 */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JournalSyncApplier, type ApplyBatchStream } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { TRUST_GRANT_KIND_REGISTRATION, TRUST_JOURNEY_STORE_KEY } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { LEARNING_KIND_REGISTRATION, LEARNING_STORE_KEY } from '../../src/core/LearningsReplicatedStore.js';
import { sign as edSign, verify as edVerify } from '../../src/core/MachineIdentity.js';
import {
  canonicalJournalSyncResponse,
  canonicalJson,
  mintRequesterNonce,
  screenJournalSyncStream,
  signJournalSyncResponse,
  verifyJournalSyncResponse,
} from '../../src/core/journalSyncResponseSignature.js';
import type { JournalEntry, JournalKind } from '../../src/core/CoherenceJournal.js';

const SELF = 'm_self';
const PEER = 'm_peer';
const OTHER = 'm_other';
const TRUST: JournalKind = 'trust-grant-record' as JournalKind;

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec088-p2-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/sec088-journal-sync-trust-transport.test.ts' }); });

function registry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(TRUST_GRANT_KIND_REGISTRATION);
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}

function trustData(recordKey: string, origin: string, physical: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordKey,
    hlc: { physical, logical: 0, node: origin },
    op: 'put',
    origin,
    recordType: 'change',
    at: new Date(physical).toISOString(),
    ...extra,
  };
}

function trustEntry(seq: number, machine: string, data: Record<string, unknown>): JournalEntry {
  return { seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), machine, kind: TRUST, data };
}

function applier(selfMachineId?: string): JournalSyncApplier {
  return new JournalSyncApplier({ stateDir: tmpDir, replicatedRegistry: registry(), ...(selfMachineId ? { selfMachineId } : {}) });
}

function replicaPath(machine: string, kind: string): string {
  return path.join(tmpDir, 'state', 'coherence-journal', 'peers', `${machine}.${kind}.jsonl`);
}

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

// ── decision 5: signed journal-sync responses ────────────────────────────────

describe('journal-sync response signature (decision 5)', () => {
  const peerKey = keypair();
  const strangerKey = keypair();
  const registered: Record<string, string> = { [PEER]: peerKey.pub };
  const verifySig = (id: string, canonical: string, sig: string): boolean => {
    const pem = registered[id];
    return pem ? edVerify(canonical, sig, pem) : false;
  };
  const stream = { kind: 'trust-grant-record', incarnation: 'inc-1', entries: [trustEntry(1, PEER, trustData('tj:change:a', PEER, 1_800_000_000_000))] };

  it('a valid signature from the machine asked verifies', () => {
    const nonce = mintRequesterNonce();
    const sig = signJournalSyncResponse({ responder: PEER, requesterNonce: nonce, kind: stream.kind, incarnation: stream.incarnation, fromSeq: 0, entries: stream.entries }, (c) => edSign(c, peerKey.priv));
    expect(verifyJournalSyncResponse(PEER, nonce, 0, stream, sig, verifySig)).toBe('valid');
    const screened = screenJournalSyncStream(stream, 'valid');
    expect(screened.stream).toBe(stream);
    expect(screened.refusedEntries).toBe(0);
  });

  it('an unsigned response (an older build) is accepted as today', () => {
    expect(verifyJournalSyncResponse(PEER, mintRequesterNonce(), 0, stream, undefined, verifySig)).toBe('unsigned');
    expect(screenJournalSyncStream(stream, 'unsigned').stream).toBe(stream);
  });

  it('a signature by another key, over another nonce, or over altered entries is invalid', () => {
    const nonce = mintRequesterNonce();
    const parts = { responder: PEER, requesterNonce: nonce, kind: stream.kind, incarnation: stream.incarnation, fromSeq: 0, entries: stream.entries };
    const byStranger = signJournalSyncResponse(parts, (c) => edSign(c, strangerKey.priv));
    expect(verifyJournalSyncResponse(PEER, nonce, 0, stream, byStranger, verifySig)).toBe('invalid');

    const good = signJournalSyncResponse(parts, (c) => edSign(c, peerKey.priv));
    expect(verifyJournalSyncResponse(PEER, mintRequesterNonce(), 0, stream, good, verifySig)).toBe('invalid'); // replayed to another request
    expect(verifyJournalSyncResponse(PEER, nonce, 5, stream, good, verifySig)).toBe('invalid'); // another fromSeq
    const altered = { ...stream, entries: [trustEntry(1, PEER, trustData('tj:change:a', PEER, 1_800_000_000_000, { to: 'autonomous' }))] };
    expect(verifyJournalSyncResponse(PEER, nonce, 0, altered, good, verifySig)).toBe('invalid');
    // verified against the machine ASKED: the peer's valid signature does not stand for another machine
    expect(verifyJournalSyncResponse(OTHER, nonce, 0, stream, good, verifySig)).toBe('invalid');
    expect(verifyJournalSyncResponse(PEER, nonce, 0, stream, '', verifySig)).toBe('invalid');
    expect(verifyJournalSyncResponse(PEER, nonce, 0, stream, 42, verifySig)).toBe('invalid');
    expect(verifyJournalSyncResponse(PEER, nonce, 0, stream, good, () => { throw new Error('no key'); })).toBe('invalid');
  });

  it('the canonical digest is independent of entry key order', () => {
    const a = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } };
    const b = { a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const p = { responder: PEER, requesterNonce: 'n', kind: 'k', incarnation: 'i', fromSeq: 1 };
    expect(canonicalJournalSyncResponse({ ...p, entries: [a] })).toBe(canonicalJournalSyncResponse({ ...p, entries: [b] }));
    expect(JSON.parse(canonicalJournalSyncResponse({ ...p, entries: [] })).slice(0, 6)).toEqual(['journal-sync-response', PEER, 'n', 'k', 'i', 1]);
  });

  it('an invalid signature refuses trust-grant-record entries and counts badSignature; other kinds pass', () => {
    const trustScreen = screenJournalSyncStream(stream, 'invalid');
    expect(trustScreen.stream).toBeNull();
    expect(trustScreen.refusedEntries).toBe(1);

    const otherKind = { kind: 'topic-placement', incarnation: 'inc-1', entries: [{ seq: 1 }] };
    const otherScreen = screenJournalSyncStream(otherKind, 'invalid');
    expect(otherScreen.stream).toBe(otherKind);
    expect(otherScreen.refusedEntries).toBe(0);

    const a = applier(SELF);
    a.recordBadSignature(PEER, 'trust-grant-record', trustScreen.refusedEntries);
    expect(a.getDegradation().badSignature).toBe(1);
    // nothing was appended for the refused trust stream
    expect(fs.existsSync(replicaPath(PEER, 'trust-grant-record'))).toBe(false);
  });
});

// ── decision 2: origin binding + self-sender refusal ─────────────────────────

describe('JournalSyncApplier trust-grant-record origin binding (decision 2)', () => {
  it('a trust record whose origin equals the sender is applied', () => {
    const a = applier(SELF);
    const batch: ApplyBatchStream[] = [{ kind: TRUST, incarnation: 'inc-p', entries: [trustEntry(1, PEER, trustData('tj:change:a', PEER, 1_800_000_000_000))] }];
    const r = a.apply(PEER, batch);
    expect(r.applied).toBe(1);
    expect(r.forgedEntries).toBe(0);
  });

  it('an origin naming another machine is forged: batch stops, nothing appended, counted', () => {
    const a = applier(SELF);
    const batch: ApplyBatchStream[] = [{
      kind: TRUST,
      incarnation: 'inc-p',
      entries: [
        trustEntry(1, PEER, trustData('tj:change:a', SELF, 1_800_000_000_000)), // claims to be this machine's record
        trustEntry(2, PEER, trustData('tj:change:b', PEER, 1_800_000_000_001)),
      ],
    }];
    const r = a.apply(PEER, batch);
    expect(r.forgedEntries).toBe(1);
    expect(r.applied).toBe(0);
    expect(a.getDegradation().forgedEntries).toBe(1);
    expect(fs.existsSync(replicaPath(PEER, 'trust-grant-record'))).toBe(false);
  });

  it('a missing origin is forged too', () => {
    const a = applier(SELF);
    const data = trustData('tj:change:a', PEER, 1_800_000_000_000);
    delete data.origin;
    const r = a.apply(PEER, [{ kind: TRUST, incarnation: 'inc-p', entries: [trustEntry(1, PEER, data)] }]);
    expect(r.forgedEntries).toBe(1);
    expect(r.applied).toBe(0);
  });

  it('a replica whose sender is this machine is refused and counted (any kind)', () => {
    const a = applier(SELF);
    const r = a.apply(SELF, [{ kind: TRUST, incarnation: 'inc-s', entries: [trustEntry(1, SELF, trustData('tj:change:a', SELF, 1_800_000_000_000))] }]);
    expect(r.applied).toBe(0);
    expect(r.selfSenderEntries).toBe(1);
    expect(a.getDegradation().selfSenderEntries).toBe(1);
    expect(fs.existsSync(replicaPath(SELF, 'trust-grant-record'))).toBe(false);
  });

  it('the own id can be set late via setSelfMachineId (ids compared after file-name sanitising)', () => {
    const odd = 'm/self';
    const a = applier();
    a.setSelfMachineId(odd);
    const r = a.apply(odd, [{ kind: TRUST, incarnation: 'inc-s', entries: [trustEntry(1, odd, trustData('tj:change:a', odd, 1_800_000_000_000))] }]);
    expect(r.selfSenderEntries).toBe(1);
    expect(r.applied).toBe(0);
  });

  it('without a known own id the applier behaves as before', () => {
    const a = applier();
    const r = a.apply(PEER, [{ kind: TRUST, incarnation: 'inc-p', entries: [trustEntry(1, PEER, trustData('tj:change:a', PEER, 1_800_000_000_000))] }]);
    expect(r.applied).toBe(1);
    expect(r.selfSenderEntries).toBe(0);
  });
});

// ── decision 2: the writer-keyed trust read ──────────────────────────────────

describe('ReplicatedPeerStreamReader.loadAllRecordsWithWriter (decision 2)', () => {
  function reader(): ReplicatedPeerStreamReader {
    return new ReplicatedPeerStreamReader({ stateDir: tmpDir, registry: registry(), selfMachineId: SELF });
  }
  function writeOwn(entries: JournalEntry[]): void {
    const dir = path.join(tmpDir, 'state', 'coherence-journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SELF}.trust-grant-record.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  function writeReplica(fileMachine: string, entries: JournalEntry[]): void {
    fs.mkdirSync(path.dirname(replicaPath(fileMachine, 'trust-grant-record')), { recursive: true });
    fs.writeFileSync(replicaPath(fileMachine, 'trust-grant-record'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('takes the writer from entry.machine via the applier, first record per (writer, key) wins', () => {
    const a = applier(SELF);
    // the later record carries a HIGHER hlc: newest-by-HLC would pick it; first-wins must not
    a.apply(PEER, [{ kind: TRUST, incarnation: 'inc-p', entries: [
      trustEntry(1, PEER, trustData('tj:change:k', PEER, 1_800_000_000_000, { to: 'first' })),
      trustEntry(2, PEER, trustData('tj:change:k', PEER, 1_900_000_000_000, { to: 'second' })),
    ] }]);
    const recs = reader().loadAllRecordsWithWriter(TRUST_JOURNEY_STORE_KEY);
    expect(recs).toHaveLength(1);
    expect(recs[0].writer).toBe(PEER);
    expect(recs[0].recordKey).toBe('tj:change:k');
    expect(recs[0].data.to).toBe('first');
  });

  it('includes this machine\'s own stream with writer = own id, and keys by (writer, key)', () => {
    writeOwn([trustEntry(1, SELF, trustData('tj:change:k', SELF, 1_800_000_000_000, { to: 'own' }))]);
    writeReplica(PEER, [trustEntry(1, PEER, trustData('tj:change:k', PEER, 1_800_000_000_000, { to: 'peer' }))]);
    const recs = reader().loadAllRecordsWithWriter(TRUST_JOURNEY_STORE_KEY);
    const byWriter = Object.fromEntries(recs.map((r) => [r.writer, r]));
    expect(Object.keys(byWriter).sort()).toEqual([PEER, SELF].sort());
    expect(byWriter[SELF].data.to).toBe('own');
    expect(byWriter[PEER].data.to).toBe('peer');
  });

  it('a replica entry is attributed to its machine, never to the payload origin', () => {
    // written straight to disk (bypassing the applier): machine = PEER, payload origin claims SELF
    writeReplica(PEER, [trustEntry(1, PEER, trustData('tj:change:k', SELF, 1_800_000_000_000))]);
    const recs = reader().loadAllRecordsWithWriter(TRUST_JOURNEY_STORE_KEY);
    expect(recs).toHaveLength(1);
    expect(recs[0].writer).toBe(PEER);
  });

  it('drops replica entries whose machine is not the file\'s machine, or that claim this machine', () => {
    writeReplica(PEER, [
      trustEntry(1, OTHER, trustData('tj:change:a', OTHER, 1_800_000_000_000)),
      trustEntry(2, SELF, trustData('tj:change:b', SELF, 1_800_000_000_001)),
    ]);
    writeReplica(SELF, [trustEntry(1, SELF, trustData('tj:change:c', SELF, 1_800_000_000_002))]);
    expect(reader().loadAllRecordsWithWriter(TRUST_JOURNEY_STORE_KEY)).toEqual([]);
  });

  it('an own-stream record stamped with another origin (a restored stream) is not own', () => {
    writeOwn([
      trustEntry(1, OTHER, trustData('tj:change:a', OTHER, 1_800_000_000_000)),
      trustEntry(2, SELF, trustData('tj:change:b', OTHER, 1_800_000_000_001)),
    ]);
    const recs = reader().loadAllRecordsWithWriter(TRUST_JOURNEY_STORE_KEY);
    expect(recs.map((r) => r.writer)).toEqual([OTHER, OTHER]);
    expect(recs.some((r) => r.writer === SELF)).toBe(false);
  });

  it('first-wins follows stream order (seq), not file line order', () => {
    writeReplica(PEER, [
      trustEntry(2, PEER, trustData('tj:change:k', PEER, 1_800_000_000_000, { to: 'later' })),
      trustEntry(1, PEER, trustData('tj:change:k', PEER, 1_800_000_000_000, { to: 'earlier' })),
    ]);
    const recs = reader().loadAllRecordsWithWriter(TRUST_JOURNEY_STORE_KEY);
    expect(recs).toHaveLength(1);
    expect(recs[0].data.to).toBe('earlier');
  });

  it('serves the trust store only', () => {
    expect(reader().loadAllRecordsWithWriter(LEARNING_STORE_KEY)).toEqual([]);
    expect(reader().loadAllRecordsWithWriter('no-such-store')).toEqual([]);
  });
});
