/** Instar Documents store: append, peer ingest, pending, purge, prune, export and merge-restore (§3.4, §5). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore, docKeyOf, mergeRestore, updateExport, type StandingCheck } from '../../src/documents/store.js';
import { blobHash, newSalt } from '../../src/documents/blobs.js';
import { rowKeyOf, type Actor, type DocRow } from '../../src/documents/rows.js';

const DOC = '33333333-3333-4333-8333-333333333333';
const H = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const owner: Actor = { type: 'owner-phone', deviceId: 'od', signedOrigin: { keyHash: 'k', deviceId: 'od', domain: 'instar-device-v1', payloadB64: 'e30', host: 'h', timeMs: '1', sig: 's' } };
const agent: Actor = { type: 'agent', placeKey: 'p' };
const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/documents-store.test.ts:cleanup' }); });

function keys() {
  const pems = new Map<string, string>();
  const lookup: MachineKeyLookup = (id) => (pems.has(id) ? { status: 'ok', publicKeyPem: pems.get(id)! } : { status: 'unknown' });
  const signer = (id: string): MachineSigner => {
    const kp = generateSigningKeyPair(); pems.set(id, kp.publicKey);
    return { machineId: () => id, signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: id, signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  };
  return { lookup, signer };
}
function store(id: string, k: ReturnType<typeof keys>, standing: StandingCheck = () => 'ok') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  tmp.push(dir);
  return { dir, s: new DocumentStore(dir, { signer: k.signer(id), keyLookup: k.lookup, standing }) };
}
const created = { eventKind: 'created' as const, titleHash: H('t'), ownerPerson: 'owner', primary: 'telegram:7', createdFrom: 'telegram:7', docSaltHash: H('s') };

describe('DocumentStore', () => {
  it('appends signed, chained rows and a peer ingests them in any order', () => {
    const k = keys(); const A = store('A', k); const B = store('B', k);
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    const r2 = A.s.append(DOC, { eventKind: 'title', titleHash: H('t2') }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    const r3 = A.s.append(DOC, { eventKind: 'title', titleHash: H('t3') }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    expect(r2.prevHash).not.toBeNull();
    expect(r3.docDeps).toEqual({ 'A/i1': 2 });
    expect(B.s.ingest(r3)).toBe('pending');
    expect(B.s.ingest(r1)).toBe('applied');
    expect(B.s.ingest(r2)).toBe('applied');
    expect(B.s.recheckPending()).toBe(1);
    expect(B.s.rowsOf(DOC).length).toBe(3);
    expect(B.s.ingest(r2)).toBe('duplicate');
    // Survives a restart.
    const again = new DocumentStore(B.dir, { signer: k.signer('B2'), keyLookup: k.lookup, standing: () => 'ok' });
    expect(again.rowsOf(DOC).length).toBe(3);
  });

  it('refuses tampered rows, broken chains and rows that fail standing', () => {
    const k = keys(); const A = store('A', k); const B = store('B', k, (r) => (r.eventKind === 'title' ? 'denied' : 'ok'));
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    expect(B.s.ingest({ ...r1, titleHash: H('forged') } as DocRow)).toEqual({ ignored: 'bad-signature' });
    expect(B.s.ingest(r1)).toBe('applied');
    const r2 = A.s.append(DOC, { eventKind: 'title', titleHash: H('x') }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    expect(B.s.ingest(r2)).toEqual({ ignored: 'standing' });
    expect(B.s.health().ignored).toMatchObject({ 'bad-signature': 1, standing: 1 });
  });

  it('holds rows whose standing is not decidable yet, and applies them once it is', () => {
    const k = keys(); let ready = false;
    const A = store('A', k); const B = store('B', k, () => (ready ? 'ok' : 'pending'));
    const r1 = A.s.append(DOC, created, { actor: agent, access: { 'T/i1': 3 }, primaryRow: null });
    expect(B.s.ingest(r1)).toBe('pending');
    expect(B.s.health().pending).toBe(1);
    ready = true;
    expect(B.s.recheckPending()).toBe(1);
    expect(B.s.health().pending).toBe(0);
  });

  it('purge deletes text everywhere and refuses it again; prune keeps blobs a kept version shares', () => {
    const k = keys(); const A = store('A', k);
    const salt = newSalt();
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    const shared = A.s.putBlob(DOC, { salt, text: 'shared paragraph' })!;
    const only = A.s.putBlob(DOC, { salt, text: 'old only' })!;
    const v1 = crypto.randomUUID(); const v2 = crypto.randomUUID();
    A.s.append(DOC, { eventKind: 'version', versionId: v1, label: 1, parents: [], contentHash: H('1'), projectionVersion: 1, chunks: 2 }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    A.s.append(DOC, { eventKind: 'version-chunk', versionId: v1, index: 0, payloadHash: shared }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    A.s.append(DOC, { eventKind: 'version-chunk', versionId: v1, index: 1, payloadHash: only }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    A.s.append(DOC, { eventKind: 'version', versionId: v2, label: 2, parents: [v1], contentHash: H('2'), projectionVersion: 1, chunks: 1 }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    A.s.append(DOC, { eventKind: 'version-chunk', versionId: v2, index: 0, payloadHash: shared }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    A.s.append(DOC, { eventKind: 'prune', versionIds: [v1] }, { actor: owner, access: {}, primaryRow: rowKeyOf(r1) });
    expect(A.s.getBlob(DOC, shared)).not.toBeNull();
    expect(A.s.getBlob(DOC, only)).toBeNull();
    expect(A.s.putBlob(DOC, { salt, text: 'old only' }, { forVersion: v1 })).toBeNull();
    A.s.append(DOC, { eventKind: 'purge' }, { actor: owner, access: {}, primaryRow: rowKeyOf(r1) });
    expect(A.s.getBlob(DOC, shared)).toBeNull();
    expect(A.s.putBlob(DOC, { salt, text: 'shared paragraph' })).toBeNull();
    expect(fs.existsSync(path.join(A.dir, 'documents', 'blobs', docKeyOf(DOC)))).toBe(false);
    expect(blobHash(salt, 'shared paragraph')).toBe(shared);
  });

  it('pages rows beyond a peer vector by bytes, always at least one row', () => {
    const k = keys(); const A = store('A', k);
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    for (let i = 0; i < 5; i++) A.s.append(DOC, { eventKind: 'title', titleHash: H(String(i)) }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    expect(A.s.rowsBeyond({}, 1).length).toBe(1);
    expect(A.s.rowsBeyond({ 'A/i1': 4 }, 1e9).map((r) => r.seq)).toEqual([5, 6]);
  });

  it('export and merge-restore only ever add, and never bring purged text back', () => {
    const k = keys(); const A = store('A', k);
    const salt = newSalt();
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    const h = A.s.putBlob(DOC, { salt, text: 'secret' })!;
    expect(updateExport(A.s, A.dir).rows).toBe(1);
    A.s.append(DOC, { eventKind: 'purge' }, { actor: owner, access: {}, primaryRow: rowKeyOf(r1) });
    updateExport(A.s, A.dir);
    // A fresh store on the same state dir after losing its rows restores from the export.
    SafeFsExecutor.safeRmSync(path.join(A.dir, 'documents'), { recursive: true, force: true, operation: 'tests/unit/documents-store.test.ts:lose-rows' });
    const fresh = new DocumentStore(A.dir, { signer: null, keyLookup: k.lookup, standing: () => 'ok' });
    const res = mergeRestore(fresh, A.dir);
    expect(res.rows).toBe(2);
    expect(fresh.isPurged(DOC)).toBe(true);
    expect(fresh.getBlob(DOC, h)).toBeNull();
  });
});

describe('DocumentStore after review', () => {
  it('a refused row keeps its place, so later rows from that machine still apply', () => {
    const k = keys(); const A = store('A', k); const B = store('B', k, (r) => (r.eventKind === 'title' && r.titleHash === H('bad') ? 'denied' : 'ok'));
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    const bad = A.s.append(DOC, { eventKind: 'title', titleHash: H('bad') }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    const good = A.s.append(DOC, { eventKind: 'title', titleHash: H('good') }, { actor: agent, access: {}, primaryRow: rowKeyOf(r1) });
    expect(B.s.ingest(r1)).toBe('applied');
    expect(B.s.ingest(bad)).toEqual({ ignored: 'standing' });
    expect(B.s.ingest(good)).toBe('applied');
    const again = new DocumentStore(B.dir, { signer: null, keyLookup: k.lookup, standing: () => 'ok' });
    expect(again.rowsOf(DOC).map((r) => r.seq)).toEqual([1, 3]);
    expect(again.have()).toEqual({ 'A/i1': 3 });
  });

  it('counts a fork and refuses a second created row', () => {
    const k = keys(); const A = store('A', k); const B = store('B', k);
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    expect(B.s.ingest(r1)).toBe('applied');
    expect(B.s.ingest({ ...r1, eventId: crypto.randomUUID() })).toEqual({ ignored: 'fork' });
    expect(() => A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null })).toThrow(/second-created/);
  });
});

describe('DocumentStore — device origins (§3.6)', () => {
  const person = (requestId: string): Actor => ({ type: 'person', personKey: 'mara', deviceId: 'mp', client: 'phone', signedOrigin: { keyHash: 'k', deviceId: 'mp', domain: 'instar-docpage-v1', payloadB64: 'e30', host: 'h', timeMs: '1', sig: 's', requestId } });
  const resolve = { eventKind: 'resolve' as const, commentKey: `mara:${'1'.repeat(8)}-1111-4111-8111-111111111111` };

  it('a row whose device is not known yet keeps its place, stays unread, and later rows still apply', () => {
    const k = keys();
    let known = false;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-')); tmp.push(dirA);
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-')); tmp.push(dirB);
    const A = new DocumentStore(dirA, { signer: k.signer('A'), keyLookup: k.lookup, standing: () => 'ok' });
    const B = new DocumentStore(dirB, { signer: k.signer('B'), keyLookup: k.lookup, standing: () => 'ok', origin: (r) => (r.actor.type === 'person' ? (known ? 'ok' : 'pending') : 'ok') });
    const r1 = A.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    const pk = rowKeyOf(r1);
    const r2 = A.append(DOC, resolve, { actor: person(`${Date.now()}-${crypto.randomUUID()}`), access: {}, primaryRow: pk });
    const r3 = A.append(DOC, { eventKind: 'title', titleHash: H('t2') }, { actor: agent, access: {}, primaryRow: pk });
    for (const r of [r1, r2, r3]) B.ingest(r);
    expect(B.rowsOf(DOC).map((r) => r.seq)).toEqual([1, 3]);
    known = true;
    B.recheckPending();
    expect(B.rowsOf(DOC).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('two rows from one signed request: every machine reads the same one (lowest row key)', () => {
    const k = keys();
    const A = store('A', k); const B = store('B', k); const C = store('C', k);
    const r1 = A.s.append(DOC, created, { actor: agent, access: {}, primaryRow: null });
    const pk = rowKeyOf(r1);
    for (const x of [B.s, C.s]) x.ingest(r1);
    const rq = `${Date.now()}-${crypto.randomUUID()}`;
    const a2 = A.s.append(DOC, resolve, { actor: person(rq), access: {}, primaryRow: pk });
    const b2 = B.s.append(DOC, resolve, { actor: person(rq), access: {}, primaryRow: pk });
    expect(a2.eventId).toBe(b2.eventId);
    A.s.ingest(b2); B.s.ingest(a2); C.s.ingest(b2); C.s.ingest(a2);
    const keyOf = (x: DocumentStore) => x.rowsOf(DOC).filter((r) => r.eventKind === 'resolve').map(rowKeyOf);
    expect(keyOf(A.s)).toEqual(keyOf(B.s));
    expect(keyOf(C.s)).toEqual(keyOf(A.s));
    expect(keyOf(A.s)).toHaveLength(1);
  });
});
