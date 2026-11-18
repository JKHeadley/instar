import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateOwnerRecord, signOwnerRecordEntry, ownerRecordEntryId, type OwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { ownerKeyIdFor, recordEntryPresenceMessage, makeFirstOwnerProof, makeFirstOwnerProofVerifier, firstOwnerKeyDraft, AGENT_ID_PATTERN } from '../../src/core/ownerApprover.js';
import { OwnerRecordStore, type OwnerRecordSelf } from '../../src/core/ownerRecordStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AGENT = 'agent-1';
function ed() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, sign: (t: string) => crypto.sign(null, Buffer.from(t), privateKey).toString('base64') };
}
/** A phone's presence key: P-256, raw 65-byte point (base64url), strict low-S DER signatures (base64url). */
function phone() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const sign = (msg: string): string => {
    const der = crypto.sign('sha256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'der' });
    // normalise to low-S
    const rLen = der[3]; const r = der.subarray(4, 4 + rLen); const sLen = der[5 + rLen]; let s = BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
    if (s > n / 2n) s = n - s;
    let sHex = s.toString(16); if (sHex.length % 2) sHex = '0' + sHex; let sb = Buffer.from(sHex, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
    const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
  };
  return { raw, sign };
}

let dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece3a-approver-record.test.ts:cleanup' }); });

function genesisFor(m: ReturnType<typeof ed>, id = 'm_A') {
  return signOwnerRecordEntry({ kind: 'genesis', agentId: AGENT, parents: [], body: { machineId: id, publicKey: m.pub, level: 'basic', agentProducible: true }, signer: { type: 'machine', keyId: id } }, m.sign);
}
function firstOwner(m: ReturnType<typeof ed>, parentId: string, p: ReturnType<typeof phone>, deviceId = 'dev1', by = 'm_A') {
  const proof = makeFirstOwnerProof({ agentId: AGENT, parentId, deviceId, ownerKeyId: ownerKeyIdFor(p.raw), presenceKey: p.raw, machineId: by, sign: m.sign });
  const draft = firstOwnerKeyDraft({ agentId: AGENT, parentId, deviceId, label: 'Phone', presenceKey: p.raw, proof });
  const id = ownerRecordEntryId(draft as OwnerRecordEntry);
  const entry = { ...draft, sig: p.sign(recordEntryPresenceMessage(AGENT, id)) } as OwnerRecordEntry;
  return { entry, id };
}
const OPTS = { agentId: AGENT, verifyFirstOwnerProof: makeFirstOwnerProofVerifier(AGENT) };

describe('owner keys are presence keys (§1)', () => {
  it('a P-256 first owner key, attested by a machine key in the record, makes the record enrolled', () => {
    const m = ed(); const g = genesisFor(m); const p = phone();
    const fo = firstOwner(m, g.id, p);
    const s = evaluateOwnerRecord([g.entry, fo.entry], OPTS);
    expect(s.status).toBe('ok');
    expect(s.everEnrolled).toBe(true);
    expect(s.keys.find((k) => k.type === 'owner-key')).toMatchObject({ keyId: ownerKeyIdFor(p.raw), publicKey: p.raw, keyType: 'p256' });
  });

  it('a P-256 owner key signs later entries (a policy) through the record presence message', () => {
    const m = ed(); const g = genesisFor(m); const p = phone();
    const fo = firstOwner(m, g.id, p);
    const draft = { v: 1 as const, kind: 'policy' as const, agentId: AGENT, parents: [fo.id], body: { path: 'x', value: 1 }, signer: { type: 'owner-key' as const, keyId: ownerKeyIdFor(p.raw) } };
    const pid = ownerRecordEntryId(draft as OwnerRecordEntry);
    const pol = { ...draft, sig: p.sign(recordEntryPresenceMessage(AGENT, pid)) } as OwnerRecordEntry;
    expect(evaluateOwnerRecord([g.entry, fo.entry, pol], OPTS).policies.x).toBe(1);
    const forged = { ...pol, sig: phone().sign(recordEntryPresenceMessage(AGENT, pid)) } as OwnerRecordEntry;
    expect(evaluateOwnerRecord([g.entry, fo.entry, forged], OPTS).policies.x).toBeUndefined();
  });

  it('refuses a first owner key with no proof, a proof by a machine not in the record, or a replayed proof', () => {
    const m = ed(); const g = genesisFor(m); const p = phone();
    const stranger = ed();
    const bad = firstOwner(stranger, g.id, p, 'dev1', 'm_X');
    expect(evaluateOwnerRecord([g.entry, bad.entry], OPTS).everEnrolled).toBe(false);
    // a valid proof for dev1 replayed onto dev2 fails
    const good = firstOwner(m, g.id, p, 'dev1');
    const replay = { ...good.entry, body: { ...good.entry.body, deviceId: 'dev2' } } as OwnerRecordEntry;
    const rid = ownerRecordEntryId(replay);
    const replaySigned = { ...replay, sig: p.sign(recordEntryPresenceMessage(AGENT, rid)) } as OwnerRecordEntry;
    expect(evaluateOwnerRecord([g.entry, replaySigned], OPTS).everEnrolled).toBe(false);
  });

  it('key ids come from the presence key, and agent ids that could forge framing are refused', () => {
    const p = phone();
    expect(ownerKeyIdFor(p.raw)).toBe(ownerKeyIdFor(p.raw));
    expect(ownerKeyIdFor(p.raw)).not.toBe(ownerKeyIdFor(phone().raw));
    expect(AGENT_ID_PATTERN.test('agent\nx')).toBe(false);
    expect(() => recordEntryPresenceMessage('a\nb', 'x')).toThrow();
  });
});

describe('machine keys before any owner key (§2)', () => {
  it('a machine adds its own key self-signed at Basic; after an owner key it cannot', () => {
    const a = ed(); const b = ed(); const g = genesisFor(a);
    const addB = signOwnerRecordEntry({ kind: 'add-machine-key', agentId: AGENT, parents: [g.id], body: { machineId: 'm_B', publicKey: b.pub }, signer: { type: 'machine', keyId: 'm_B' } }, b.sign);
    expect(evaluateOwnerRecord([g.entry, addB.entry], OPTS).keys.map((k) => k.keyId)).toContain('m_B');
    const p = phone(); const fo = firstOwner(a, g.id, p);
    const late = signOwnerRecordEntry({ kind: 'add-machine-key', agentId: AGENT, parents: [fo.id], body: { machineId: 'm_C', publicKey: ed().pub }, signer: { type: 'machine', keyId: 'm_C' } }, ed().sign);
    expect(evaluateOwnerRecord([g.entry, fo.entry, late.entry], OPTS).keys.map((k) => k.keyId)).not.toContain('m_C');
  });

  it('the store adds this machine once, only its registered key, and merges a fork at Basic', () => {
    const a = ed(); const b = ed();
    const registry = new Map([['m_A', a.pub], ['m_B', b.pub]]);
    const mk = (self: OwnerRecordSelf, dir: string) => { const s = new OwnerRecordStore({ instarDir: dir, agentId: AGENT, self: () => self, registeredKey: (x) => registry.get(x) ?? null }); s.load(); return s; };
    const sa = mk({ machineId: 'm_A', publicKeyPem: a.pub, sign: a.sign }, tmp('a-'));
    sa.bootstrap();
    const sb = mk({ machineId: 'm_B', publicKeyPem: b.pub, sign: b.sign }, tmp('b-'));
    sb.ingest(sa.page(new Set(), null).entries);
    expect(sb.ensureOwnMachineKey()).toBe('added');
    expect(sb.ensureOwnMachineKey()).toBe('present');
    sa.ingest(sb.page(new Set(), null).entries);
    expect(sa.state()?.keys.map((k) => k.keyId)).toEqual(expect.arrayContaining(['m_A', 'm_B']));
    // an impostor's self-add (a key that isn't m_C's registered one) is dropped on arrival
    const imp = ed();
    const head = sa.state()!.head[0];
    const bogus = signOwnerRecordEntry({ kind: 'add-machine-key', agentId: AGENT, parents: [head], body: { machineId: 'm_B2', publicKey: imp.pub }, signer: { type: 'machine', keyId: 'm_B2' } }, imp.sign);
    expect(sa.ingest([bogus.entry]).added).toEqual([]);
    expect(sa.isWhole(['m_A', 'm_B'])).toBe(true);
    expect(sa.isWhole(['m_A', 'm_B', 'm_C'])).toBe(false);
  });
});

describe('the claim asks every machine (§3)', () => {
  it('names a silent machine, an older build, an enrolled one and one with unvouched devices; a clean pool passes', async () => {
    const { OwnerRecordSync } = await import('../../src/core/ownerRecordSync.js');
    const a = ed();
    const store = new OwnerRecordStore({ instarDir: tmp('cc-'), agentId: AGENT, self: () => ({ machineId: 'm_A', publicKeyPem: a.pub, sign: a.sign }), registeredKey: () => a.pub });
    store.load();
    const replies: Record<string, unknown> = {
      m_ok: { entries: [], everEnrolled: false, marker: null, approver: { v: 1, unvouched: 0 } },
      m_old: { entries: [], everEnrolled: false, marker: null },
      m_enr: { entries: [], everEnrolled: true, marker: null, approver: { v: 1, unvouched: 0 } },
      m_dev: { entries: [], everEnrolled: false, marker: null, approver: { v: 1, unvouched: 2 } },
    };
    const { PeerBuildLedger } = await import('../../src/core/identityBuildFence.js');
    const ledger = PeerBuildLedger.at(tmp('ledger-'));
    // each peer's own signed statement (what its signed pulls record); m_unsigned says the right thing only in its reply
    for (const m of ['m_ok', 'm_old', 'm_enr', 'm_dev']) ledger.record(m, 'k-' + m, '1.3.2000', m === 'm_old' ? ['fence-lease'] : ['fence-lease', 'approver-record'], Date.now());
    replies.m_unsigned = { entries: [], everEnrolled: false, marker: null, approver: { v: 1, unvouched: 0 } };
    const mk = (peers: string[]) => new OwnerRecordSync({ store, agentId: AGENT, selfMachineId: () => 'm_A', peers: () => peers, isLeaseHolder: () => true, splitBrain: () => false, degrade: () => {},
      ledger, peerKey: (m) => 'k-' + m,
      send: async (m) => (m === 'm_silent' ? new Promise(() => {}) : { ok: true, result: replies[m] }) });
    const r = await mk(['m_ok', 'm_old', 'm_enr', 'm_dev', 'm_silent', 'm_unsigned']).claimCheck(50);
    expect(r).toEqual({ silent: ['m_silent'], olderBuild: ['m_old', 'm_unsigned'], enrolled: ['m_enr'], unvouched: ['m_dev'] });
    expect(await mk(['m_ok']).claimCheck(50)).toEqual({ silent: [], olderBuild: [], enrolled: [], unvouched: [] });
  });
});
