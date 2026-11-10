/** Instar Documents core: row format, chains, the fold, visibility and access (spec §3.1–3.4). */
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { FORMAT, rowKeyOf, validateRow, type DocRow, type RowBody, type UnsignedDocRow, type Actor, type Vector } from '../../src/documents/rows.js';
import { checkChains, heldVector, rowHash, signRow, verifyRowSignature } from '../../src/documents/chain.js';
import { foldDocument, latestVersion, nextLabel, orderRows, versionHeads, visibleRows } from '../../src/documents/fold.js';
import { mayDoDocument, type DocFacts, type Principal, type TeamView } from '../../src/documents/access.js';
import { blobHash, checkBlob, listHash, textToBlobs, newSalt } from '../../src/documents/blobs.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const uuid = (): string => crypto.randomUUID();
const H = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const so = { keyHash: 'k', deviceId: 'd1', domain: 'instar-docpage-v1' as const, payloadB64: 'e30', host: 'h', timeMs: '1', sig: 's' };
const person = (personKey: string): Actor => ({ type: 'person', personKey, deviceId: 'd-' + personKey, client: 'phone', signedOrigin: so });
const owner: Actor = { type: 'owner-phone', deviceId: 'od', signedOrigin: { ...so, domain: 'instar-device-v1' } };
const agent: Actor = { type: 'agent', placeKey: 'place-1' };

function machine(id: string): { signer: MachineSigner; pem: string } {
  const kp = generateSigningKeyPair();
  return {
    pem: kp.publicKey,
    signer: { machineId: () => id, signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: id, signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) },
  };
}

class Writer {
  seq = 0; prev: string | null = null; rows: DocRow[] = [];
  constructor(readonly m: ReturnType<typeof machine>, readonly origin: string) {}
  write(body: RowBody, opts: { actor?: Actor; access?: Vector; docDeps?: Vector; primaryRow?: string | null; sessionAccess?: Vector; docId?: string } = {}): DocRow {
    this.seq += 1;
    const row: UnsignedDocRow = {
      formatVersion: 1, docId: opts.docId ?? DOC, origin: this.origin, incarnation: 'i1', seq: this.seq, prevHash: this.prev,
      eventId: uuid(), receivedAt: new Date().toISOString(), actor: opts.actor ?? agent, access: opts.access ?? {},
      ...(opts.sessionAccess ? { sessionAccess: opts.sessionAccess } : {}),
      docDeps: opts.docDeps ?? {}, primaryRow: opts.primaryRow === undefined ? null : opts.primaryRow, ...body,
    } as UnsignedDocRow;
    const signed = signRow(row, this.m.signer);
    this.prev = rowHash(signed);
    this.rows.push(signed);
    return signed;
  }
}

const created = (primary = 'app:22222222-2222-4222-8222-222222222222'): RowBody =>
  ({ eventKind: 'created', titleHash: H('t'), ownerPerson: 'owner', primary, createdFrom: primary, docSaltHash: H('salt') });
const version = (versionId: string, label: number, parents: string[] = [], chunks = 0): RowBody =>
  ({ eventKind: 'version', versionId, label, parents, contentHash: H(versionId), projectionVersion: 1, chunks });
const comment = (commentId: string, onVersion: string): RowBody =>
  ({ eventKind: 'comment', commentId, anchor: { anchorHash: H('a' + commentId), start: 0, end: 4, blockHint: 'b' }, bodyHash: H('c' + commentId), onVersion });

function permutations<T>(items: T[], limit = 120): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length && out.length < limit; i++) {
    for (const p of permutations([...items.slice(0, i), ...items.slice(i + 1)], limit)) { out.push([items[i], ...p]); if (out.length >= limit) break; }
  }
  return out;
}

describe('row format', () => {
  it('accepts a well-formed row and refuses an oversize or wrong-writer row', () => {
    const w = new Writer(machine('A'), 'A');
    const r = w.write(created());
    expect(validateRow(r)).toEqual({ ok: true });
    expect(validateRow({ ...r, actor: agent, eventKind: 'primary-set', primary: 'app:22222222-2222-4222-8222-222222222222', docDepsSigned: {} })).toEqual({ ok: false, reason: 'writer-not-allowed' });
    expect(validateRow({ ...r, titleHash: 'x'.repeat(FORMAT.rowBytes) }).ok).toBe(false);
    expect(validateRow({ ...r, formatVersion: 2 })).toEqual({ ok: false, reason: 'format-version' });
  });
  it('refuses an agent row whose session vector exceeds its access vector', () => {
    const w = new Writer(machine('A'), 'A');
    const r = w.write(created(), { access: { 'T/i1': 1 }, sessionAccess: { 'T/i1': 2 } });
    expect(validateRow(r)).toEqual({ ok: false, reason: 'session-access-exceeds-access' });
  });
  it('keeps device-seen rows in the reserved device stream only', () => {
    const w = new Writer(machine('A'), 'A');
    const bad = w.write({ eventKind: 'device-seen', deviceId: 'd' }, { actor: { type: 'machine' } });
    expect(validateRow(bad)).toEqual({ ok: false, reason: 'device-stream' });
  });
});

describe('chains and signatures', () => {
  it('verifies signatures and detects gaps, forks and broken links', () => {
    const m = machine('A');
    const lookup: MachineKeyLookup = (id) => (id === 'A' ? { status: 'ok', publicKeyPem: m.pem } : { status: 'unknown' });
    const w = new Writer(m, 'A');
    const r1 = w.write(created()); const r2 = w.write(version(uuid(), 1)); const r3 = w.write(version(uuid(), 2));
    expect(verifyRowSignature(r2, lookup)).toBe('ok');
    expect(verifyRowSignature({ ...r2, seq: 9 }, lookup)).toBe('bad');
    expect(checkChains([r1, r2, r3])).toEqual([]);
    expect(checkChains([r1, r3])).toEqual([{ kind: 'gap', stream: 'A/i1', afterSeq: 1, nextSeq: 3 }]);
    expect(checkChains([r1, r2, { ...r3, prevHash: H('x') }]).map((p) => p.kind)).toEqual(['broken-link']);
    expect(checkChains([r1, r2, { ...r2, eventId: uuid() }]).map((p) => p.kind)).toEqual(['fork']);
    expect(heldVector([r1, r3])).toEqual({ 'A/i1': 1 });
  });
});

describe('fold', () => {
  it('reaches the same state whatever order rows arrive in', () => {
    const a = new Writer(machine('A'), 'A'); const b = new Writer(machine('B'), 'B');
    const c = a.write(created()); const pk = rowKeyOf(c);
    const v1 = uuid(); a.write(version(v1, 1), { primaryRow: pk, docDeps: { 'A/i1': 1 } });
    const cm = uuid(); b.write(comment(cm, v1), { actor: person('mara'), primaryRow: pk, docDeps: { 'A/i1': 2 } });
    b.write({ eventKind: 'resolve', commentKey: `mara:${cm}` }, { actor: person('mara'), primaryRow: pk, docDeps: { 'A/i1': 2, 'B/i1': 1 } });
    a.write({ eventKind: 'reopen', commentKey: `mara:${cm}` }, { actor: owner, primaryRow: pk, docDeps: { 'A/i1': 2, 'B/i1': 2 } });
    const all = [...a.rows, ...b.rows];
    const answers = new Set(permutations(all).map((p) => JSON.stringify([...foldDocument(DOC, p, { kind: 'owner' }).comments.values()])));
    expect(answers.size).toBe(1);
    const s = foldDocument(DOC, all, { kind: 'owner' });
    expect(s.comments.get(`mara:${cm}`)?.resolved).toBe(false); // the owner's reopen saw the resolve
  });

  it('orders causally, never by clock', () => {
    const a = new Writer(machine('A'), 'A'); const b = new Writer(machine('B'), 'B');
    const c = a.write(created());
    const late = b.write({ eventKind: 'title', titleHash: H('second') }, { docDeps: { 'A/i1': 1 }, primaryRow: rowKeyOf(c) });
    const order = orderRows([{ ...late, receivedAt: '1999-01-01T00:00:00Z' }, c]);
    expect(order.map(rowKeyOf)).toEqual([rowKeyOf(c), rowKeyOf(late)]);
  });

  it('keeps both versions of a concurrent edit and labels stably', () => {
    const a = new Writer(machine('A'), 'A'); const b = new Writer(machine('B'), 'B');
    const c = a.write(created()); const pk = rowKeyOf(c);
    const v1 = uuid(); a.write(version(v1, 1), { primaryRow: pk, docDeps: { 'A/i1': 1 } });
    const va = uuid(); const vb = uuid();
    a.write(version(va, 2, [v1]), { primaryRow: pk, docDeps: { 'A/i1': 2 } });
    b.write(version(vb, 2, [v1]), { primaryRow: pk, docDeps: { 'A/i1': 2 } });
    const s = foldDocument(DOC, [...a.rows, ...b.rows], { kind: 'owner' });
    expect(versionHeads(s).map((v) => v.versionId).sort()).toEqual([va, vb].sort());
    expect(nextLabel(s, [va, vb])).toBe(3);
    expect(latestVersion(s)?.label).toBe(2);
  });
});

describe('visibility', () => {
  it('a move discloses exactly the signed history and withholds rows concurrent with it', () => {
    const a = new Writer(machine('A'), 'A'); const b = new Writer(machine('B'), 'B');
    const c = a.write(created()); const pk = rowKeyOf(c);
    const v1 = uuid(); const r2 = a.write(version(v1, 1), { primaryRow: pk, docDeps: { 'A/i1': 1 } });
    // An owner-reach write on B concurrent with the move (it never saw the move).
    const concurrent = b.write({ eventKind: 'title', titleHash: H('private') }, { primaryRow: pk, docDeps: { 'A/i1': 2 } });
    const move = a.write({ eventKind: 'primary-set', primary: 'telegram:500', docDepsSigned: { 'A/i1': 2 } }, { actor: owner, primaryRow: pk, docDeps: { 'A/i1': 2 } });
    const after = a.write(comment(uuid(), v1), { actor: person('mara'), primaryRow: rowKeyOf(move), docDeps: { 'A/i1': 3 } });
    const seen = visibleRows(orderRows([...a.rows, ...b.rows]), { kind: 'place' });
    expect(seen.has(rowKeyOf(c))).toBe(true);
    expect(seen.has(rowKeyOf(r2))).toBe(true);
    expect(seen.has(rowKeyOf(move))).toBe(true);
    expect(seen.has(rowKeyOf(after))).toBe(true);
    expect(seen.has(rowKeyOf(concurrent))).toBe(false);
  });

  it('a later grantee sees an agent row only if the session knew the grant, or a disclosure covers it', () => {
    const a = new Writer(machine('A'), 'A');
    const c = a.write(created()); const pk = rowKeyOf(c);
    const grant = { stream: 'T/i1', seq: 5, grantRowKey: 'T/i1#5' };
    const unaware = a.write({ eventKind: 'title', titleHash: H('x') }, { primaryRow: pk, access: { 'T/i1': 9 }, sessionAccess: { 'T/i1': 4 }, docDeps: { 'A/i1': 1 } });
    const aware = a.write({ eventKind: 'title', titleHash: H('y') }, { primaryRow: pk, access: { 'T/i1': 9 }, sessionAccess: { 'T/i1': 6 }, docDeps: { 'A/i1': 2 } });
    const reader = { kind: 'person' as const, personKey: 'li', grants: [grant] };
    let seen = visibleRows(orderRows(a.rows), reader);
    expect(seen.has(rowKeyOf(unaware))).toBe(false);
    expect(seen.has(rowKeyOf(aware))).toBe(true);
    const disc = a.write({ eventKind: 'place-disclosure', grantRow: 'T/i1#5', heads: { 'A/i1': 2 } }, { actor: { type: 'machine' }, primaryRow: pk, access: { 'T/i1': 9 }, docDeps: { 'A/i1': 3 } });
    seen = visibleRows(orderRows(a.rows), reader);
    expect(seen.has(rowKeyOf(unaware))).toBe(true);
    expect(seen.has(rowKeyOf(disc))).toBe(true);
  });

  it('withholds the replies and resolves of a withheld comment (cascade)', () => {
    const a = new Writer(machine('A'), 'A'); const b = new Writer(machine('B'), 'B');
    const c = a.write(created()); const pk = rowKeyOf(c);
    const v1 = uuid(); a.write(version(v1, 1), { primaryRow: pk, docDeps: { 'A/i1': 1 } });
    const cm = uuid();
    b.write(comment(cm, v1), { actor: person('mara'), primaryRow: pk, docDeps: { 'A/i1': 2 } });
    const move = a.write({ eventKind: 'primary-set', primary: 'telegram:500', docDepsSigned: { 'A/i1': 2 } }, { actor: owner, primaryRow: pk, docDeps: { 'A/i1': 2 } });
    const reply = a.write({ eventKind: 'reply', commentKey: `mara:${cm}`, replyId: uuid(), bodyHash: H('r') }, { primaryRow: rowKeyOf(move), docDeps: { 'A/i1': 3, 'B/i1': 1 } });
    const seen = visibleRows(orderRows([...a.rows, ...b.rows]), { kind: 'place' });
    expect(seen.has(rowKeyOf(reply))).toBe(false);
  });
});

describe('access', () => {
  const team = (over: Partial<TeamView> = {}): TeamView => ({
    personMay: (k, _ref, op) => k === 'mara' || (k === 'gus' && op === 'read'),
    ownerOnly: () => false, placeOf: (ref) => `place:${ref}`, teamRefusal: () => null, sendReachesOwner: () => false, ...over,
  });
  const doc: DocFacts = { primary: 'telegram:500', ownerPerson: 'owner', everShared: true, tombstoned: false, purged: false };
  const may = (p: Principal, op: Parameters<typeof mayDoDocument>[2], t = team(), d = doc) => mayDoDocument(p, d, op, t).ok;

  it('follows the conversation audience for team people, and keeps guests read-only', () => {
    expect(may({ kind: 'person', personKey: 'mara', tier: 'member', client: 'phone' }, 'comment')).toBe(true);
    expect(may({ kind: 'person', personKey: 'gus', tier: 'guest', client: 'phone' }, 'read')).toBe(true);
    expect(may({ kind: 'person', personKey: 'gus', tier: 'guest', client: 'phone' }, 'comment')).toBe(false);
    expect(may({ kind: 'person', personKey: 'zed', tier: 'member', client: 'phone' }, 'read')).toBe(false);
  });
  it('refuses msp phones, PIN sessions and agents any write, and keeps moves on the owner phone', () => {
    expect(may({ kind: 'msp' }, 'read')).toBe(false);
    expect(may({ kind: 'pin-session' }, 'read')).toBe(false);
    expect(may({ kind: 'pin-session' }, 'read', team({ ownerOnly: () => true }), { ...doc, everShared: false })).toBe(true);
    expect(may({ kind: 'pin-session' }, 'comment', team({ ownerOnly: () => true }))).toBe(false);
    expect(may({ kind: 'agent', placeKey: 'place:telegram:500', ownerReach: false }, 'send')).toBe(false);
    expect(may({ kind: 'owner-device', client: 'browser', approvedVia: 'telegram-dm' }, 'move')).toBe(false);
    expect(may({ kind: 'owner-device', client: 'phone', approvedVia: 'phone' }, 'move')).toBe(true);
    expect(may({ kind: 'owner-device', client: 'browser', approvedVia: 'dashboard-pin' }, 'comment')).toBe(false);
  });
  it('confines agent sessions to their own place, and owner-reach to never-shared owner-only documents', () => {
    expect(may({ kind: 'agent', placeKey: 'place:telegram:500', ownerReach: false }, 'read')).toBe(true);
    expect(may({ kind: 'agent', placeKey: 'place:telegram:9', ownerReach: false }, 'read')).toBe(false);
    expect(may({ kind: 'bearer' }, 'read')).toBe(false);
    expect(may({ kind: 'bearer' }, 'read-metadata')).toBe(true);
    expect(may({ kind: 'bearer' }, 'read', team({ ownerOnly: () => true }), { ...doc, everShared: false })).toBe(true);
    expect(may({ kind: 'bearer' }, 'read', team({ ownerOnly: () => true }), { ...doc, everShared: true })).toBe(false);
  });
  it('waits on the team log and refuses sends that would reach an owner-reach session', () => {
    const m: Principal = { kind: 'person', personKey: 'mara', tier: 'member', client: 'phone' };
    expect(may(m, 'comment', team({ teamRefusal: () => 'access-being-checked' }))).toBe(false);
    expect(may(m, 'send', team({ sendReachesOwner: () => true }))).toBe(false);
  });
  it('limits a documents-read browser to reading', () => {
    expect(may({ kind: 'person', personKey: 'mara', tier: 'member', client: 'browser', scope: 'documents-read' }, 'comment')).toBe(false);
  });
});

describe('blobs', () => {
  it('hashes salted text, splits by serialized size and verifies on receipt', () => {
    const salt = newSalt();
    const text = '\\"'.repeat(40_000);
    const blobs = textToBlobs(text, salt);
    expect(blobs.map((b) => b.text).join('')).toBe(text);
    for (const b of blobs) expect(checkBlob(b, blobHash(salt, b.text)).ok).toBe(true);
    expect(checkBlob({ salt, text: 'x' }, blobHash(salt, 'y'))).toEqual({ ok: false, reason: 'hash-mismatch' });
    expect(blobHash(newSalt(), 'same')).not.toBe(blobHash(newSalt(), 'same'));
    expect(listHash(['a', 'b'])).not.toBe(listHash(['b', 'a']));
  });
});

describe('review fixes', () => {
  it('a person granted the new place sees the history the move disclosed', () => {
    const a = new Writer(machine('A'), 'A');
    const c = a.write(created()); const pk = rowKeyOf(c);
    const v1 = crypto.randomUUID(); const pre = a.write(version(v1, 1), { primaryRow: pk, docDeps: { 'A/i1': 1 }, access: { 'T/i1': 1 } });
    const move = a.write({ eventKind: 'primary-set', primary: 'telegram:500', docDepsSigned: { 'A/i1': 2 } }, { actor: owner, primaryRow: pk, docDeps: { 'A/i1': 2 }, access: { 'T/i1': 2 } });
    const reader = { kind: 'person' as const, personKey: 'li', grants: [{ stream: 'T/i1', seq: 2, grantRowKey: 'T/i1#2' }] };
    const seen = visibleRows(orderRows(a.rows), reader);
    expect(seen.has(rowKeyOf(pre))).toBe(true);
    expect(seen.has(rowKeyOf(move))).toBe(true);
  });
  it('treats a PIN-approved owner browser as a PIN session, and lets a confined session reply', () => {
    const t: TeamView = { personMay: () => true, ownerOnly: () => false, placeOf: (r) => `place:${r}`, teamRefusal: () => null, sendReachesOwner: () => false };
    const d: DocFacts = { primary: 'telegram:500', ownerPerson: 'owner', everShared: true, tombstoned: false, purged: false };
    expect(mayDoDocument({ kind: 'owner-device', client: 'browser', approvedVia: 'dashboard-pin' }, d, 'read', t).ok).toBe(false);
    expect(mayDoDocument({ kind: 'owner-device', client: 'browser', approvedVia: 'dashboard-pin' }, d, 'read-metadata', t).ok).toBe(true);
    expect(mayDoDocument({ kind: 'agent', placeKey: 'place:telegram:500', ownerReach: false }, d, 'reply', t).ok).toBe(true);
    expect(mayDoDocument({ kind: 'agent', placeKey: 'place:telegram:9', ownerReach: false }, d, 'read-metadata', t).ok).toBe(false);
    expect(mayDoDocument({ kind: 'owner-device', client: 'browser', approvedVia: 'telegram-dm' }, d, 'tombstone', t).ok).toBe(false);
  });
});
