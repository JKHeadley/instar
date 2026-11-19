/**
 * identity-security-piece2a: the owner record, a signed chain every machine evaluates the same way.
 * Spec: docs/specs/identity-security-piece2a-owner-record-chain.md
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { evaluateOwnerRecord, signOwnerRecordEntry, OWNER_RECORD_MAX_INPUT, type EvaluateOptions, type OwnerRecordEntry, type OwnerRecordKind, type SignerType } from '../../src/core/ownerRecord.js';

const AGENT = 'agent-1';
const OPTS: EvaluateOptions = { agentId: AGENT, verifyFirstOwnerProof: (b) => b.proof === 'route-ok' };

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, priv: privateKey as string };
}
const signWith = (priv: string) => (text: string) => crypto.sign(null, Buffer.from(text), priv).toString('base64');
function entry(kind: OwnerRecordKind, parents: string[], body: Record<string, unknown>, by: { type: SignerType; keyId: string; priv: string }, agentId = AGENT) {
  return signOwnerRecordEntry({ kind, agentId, parents, body, signer: { type: by.type, keyId: by.keyId } }, signWith(by.priv));
}

const mA = { ...keypair(), id: 'm_A' };
const mB = { ...keypair(), id: 'm_B' };
const o1 = { ...keypair(), id: 'o_phone' };
const o2 = { ...keypair(), id: 'o_key2' };
const M = (m: { id: string; priv: string }) => ({ type: 'machine' as const, keyId: m.id, priv: m.priv });
const O = (o: { id: string; priv: string }) => ({ type: 'owner-key' as const, keyId: o.id, priv: o.priv });

const genesisOf = (m = mA) => entry('genesis', [], { machineId: m.id, publicKey: m.pub, level: 'basic', agentProducible: true }, M(m));
/** genesis → first owner key (self-signed with the route's proof) → owner adds machine B. */
function enrolled() {
  const g = genesisOf();
  const own = entry('add-owner-key', [g.id], { keyId: o1.id, publicKey: o1.pub, label: 'phone', proof: 'route-ok' }, O(o1));
  const addB = entry('add-machine-key', [own.id], { machineId: mB.id, publicKey: mB.pub }, O(o1));
  return { g, own, addB };
}

describe('Basic: the genesis machine only', () => {
  it('a genesis alone is valid, agent-producible, not enrolled', () => {
    const g = genesisOf();
    const s = evaluateOwnerRecord([g.entry], OPTS);
    expect(s.status).toBe('ok');
    expect(s.genesis).toBe(g.id);
    expect(s.keys.map((k) => k.keyId)).toEqual([mA.id]);
    expect(s.agentProducible).toBe(true);
    expect(s.everEnrolled).toBe(false);
  });

  it('a machine key may set policy and its own TLS key at Basic; nothing else', () => {
    const g = genesisOf();
    const policy = entry('policy', [g.id], { path: 'level', value: 'basic' }, M(mA));
    const tls = entry('tls-key', [policy.id], { machineId: mA.id, fingerprint: 'fp-a', seq: 1 }, M(mA));
    const addMachine = entry('add-machine-key', [g.id], { machineId: mB.id, publicKey: mB.pub }, M(mA));
    const s = evaluateOwnerRecord([g.entry, policy.entry, tls.entry, addMachine.entry], OPTS);
    expect(s.tlsKeys).toEqual({ [mA.id]: 'fp-a' });
    expect(s.rejected.find((r) => r.id === addMachine.id)?.reason).toBe('machine-key-not-allowed-for-kind');
  });
});

describe('the first owner key', () => {
  it('is self-signed and needs the route\'s proof; a machine key cannot add it', () => {
    const g = genesisOf();
    const noProof = entry('add-owner-key', [g.id], { keyId: o1.id, publicKey: o1.pub, label: 'phone' }, O(o1));
    const byMachine = entry('add-owner-key', [g.id], { keyId: o1.id, publicKey: o1.pub, label: 'phone', proof: 'route-ok' }, M(mA));
    const ok = entry('add-owner-key', [g.id], { keyId: o1.id, publicKey: o1.pub, label: 'phone', proof: 'route-ok' }, O(o1));
    expect(evaluateOwnerRecord([g.entry, noProof.entry], OPTS).rejected.find((r) => r.id === noProof.id)?.reason).toBe('first-owner-key-proof-missing');
    expect(evaluateOwnerRecord([g.entry, byMachine.entry], OPTS).rejected.find((r) => r.id === byMachine.id)?.reason).toBe('first-owner-key-must-be-self-signed');
    expect(evaluateOwnerRecord([g.entry, ok.entry], { agentId: AGENT }).rejected.find((r) => r.id === ok.id)?.reason).toBe('first-owner-key-proof-missing'); // no checker → refused
    const s = evaluateOwnerRecord([g.entry, ok.entry], OPTS);
    expect(s.everEnrolled).toBe(true);
    expect(s.agentProducible).toBe(false);
  });

  it('after it, a machine key may no longer set policy; the owner may', () => {
    const { g, own } = enrolled();
    const byMachine = entry('policy', [own.id], { path: 'level', value: 'phone' }, M(mA));
    const byOwner = entry('policy', [own.id], { path: 'level', value: 'phone' }, O(o1));
    expect(evaluateOwnerRecord([g.entry, own.entry, byMachine.entry], OPTS).rejected.find((r) => r.id === byMachine.id)?.reason).toBe('machine-key-after-owner');
    expect(evaluateOwnerRecord([g.entry, own.entry, byOwner.entry], OPTS).level).toBe('phone');
  });
});

describe('rejections are reported, never applied', () => {
  it('wrong agent, forged body, unknown parent, foreign genesis, two machine keys for one machine', () => {
    const { g, own, addB } = enrolled();
    const otherAgent = entry('policy', [g.id], { path: 'x', value: 1 }, M(mA), 'agent-2');
    const forged = { ...addB.entry, body: { ...addB.entry.body, machineId: 'm_EVIL' } } as OwnerRecordEntry;
    const orphan = entry('policy', ['f'.repeat(64)], { path: 'x', value: 1 }, O(o1));
    const foreign = genesisOf(mB);
    const dupMachine = entry('add-machine-key', [addB.id], { machineId: mB.id, publicKey: mA.pub }, O(o1));
    const s = evaluateOwnerRecord([g.entry, own.entry, addB.entry, otherAgent.entry, forged, orphan.entry, foreign.entry, dupMachine.entry], { ...OPTS, pinnedGenesis: g.id });
    const reasons = s.rejected.map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['wrong-agent', 'bad-signature', 'unknown-parent', 'not-this-record-genesis', 'machine-already-has-a-key']));
    expect(s.keys.map((k) => k.keyId)).toEqual([mA.id, mB.id, o1.id]);
    expect(s.status).toBe('ok');
    expect(s.genesis).toBe(g.id);
  });

  it('with no pin, the lowest machine id\'s genesis is the record\'s', () => {
    const gA = genesisOf(mA); const gB = genesisOf(mB);
    expect(evaluateOwnerRecord([gB.entry, gA.entry], OPTS).genesis).toBe(gA.id);
  });
});

describe('forks', () => {
  it('additions on a fork are held until an owner merge; revocations from any branch count', () => {
    const { g, own, addB } = enrolled();
    const left = entry('add-owner-key', [addB.id], { keyId: o2.id, publicKey: o2.pub, label: 'key2' }, O(o1));
    const right = entry('policy', [addB.id], { path: 'level', value: 'phone' }, O(o1));
    const sideRevoke = entry('revoke-key', [addB.id], { keyId: mB.id }, O(o1)); // a side entry: never forks
    const base = [g.entry, own.entry, addB.entry, left.entry, right.entry, sideRevoke.entry];
    const forked = evaluateOwnerRecord(base, OPTS);
    expect(forked.forked).toBe(true);
    expect(forked.keys.map((k) => k.keyId)).not.toContain(o2.id);
    expect(forked.revoked).toContain(mB.id);
    expect(forked.held).toEqual(expect.arrayContaining([left.id, right.id]));
    expect(forked.level).toBe('basic'); // the policy is held too
    const merge = entry('merge', [left.id, right.id].sort(), {}, O(o1));
    const merged = evaluateOwnerRecord([...base, merge.entry], OPTS);
    expect(merged.forked).toBe(false);
    expect(merged.keys.map((k) => k.keyId)).toEqual(expect.arrayContaining([mA.id, o1.id, o2.id]));
    expect(merged.revoked).toContain(mB.id);
    expect(merged.level).toBe('phone');
  });

  it('a later policy on one branch wins over its ancestor after a merge, whatever the ids', () => {
    const { g, own } = enrolled();
    const p1 = entry('policy', [own.id], { path: 'level', value: 'phone' }, O(o1));
    const p2 = entry('policy', [p1.id], { path: 'level', value: 'two-keys' }, O(o1));
    const side = entry('tls-key', [p1.id], { machineId: mA.id, fingerprint: 'fp', seq: 1 }, M(mA));
    const merge = entry('merge', [p2.id, side.id].sort(), {}, O(o1));
    expect(evaluateOwnerRecord([g.entry, own.entry, p1.entry, p2.entry, side.entry, merge.entry], OPTS).level).toBe('two-keys');
  });

  it('mutual revocation leaves no valid key; everEnrolled never goes back', () => {
    const { g, own } = enrolled();
    const add2 = entry('add-owner-key', [own.id], { keyId: o2.id, publicKey: o2.pub, label: 'b' }, O(o1));
    const revA = entry('revoke-key', [add2.id], { keyId: mA.id }, O(o1));
    const a = entry('revoke-key', [revA.id], { keyId: o2.id }, O(o1));
    const b = entry('revoke-key', [revA.id], { keyId: o1.id }, O(o2));
    const s = evaluateOwnerRecord([g.entry, own.entry, add2.entry, revA.entry, a.entry, b.entry], OPTS);
    expect(s.status).toBe('no-valid-key');
    expect(s.everEnrolled).toBe(true);
  });

  it('a machine key cannot fork from before the owner existed and act after it', () => {
    const g = genesisOf();
    const preOwnerPolicy = entry('policy', [g.id], { path: 'level', value: 'basic' }, M(mA));
    const own = entry('add-owner-key', [g.id], { keyId: o1.id, publicKey: o1.pub, label: 'phone', proof: 'route-ok' }, O(o1));
    const sneaky = entry('policy', [preOwnerPolicy.id], { path: 'evil', value: true }, M(mA));
    const s = evaluateOwnerRecord([g.entry, preOwnerPolicy.entry, own.entry, sneaky.entry], OPTS);
    // The whole machine-signed branch beside the owner key is off the owner path, so it counts for nothing.
    expect(s.rejected.find((r) => r.id === preOwnerPolicy.id)?.reason).toBe('machine-key-off-the-owner-path');
    expect(s.rejected.find((r) => r.id === sneaky.id)?.reason).toBe('machine-key-off-the-owner-path'); // ineffective, not cut out
    expect(s.policies.evil).toBeUndefined();
    expect(s.forked).toBe(false);
  });

  it('a revoked key cannot keep forking: its later entries count for nothing', () => {
    const { g, own } = enrolled();
    const add2 = entry('add-owner-key', [own.id], { keyId: o2.id, publicKey: o2.pub, label: 'b' }, O(o1));
    const revoke2 = entry('revoke-key', [add2.id], { keyId: o2.id }, O(o1));
    const stale = entry('policy', [add2.id], { path: 'stolen', value: true }, O(o2)); // signed against an old head
    const s = evaluateOwnerRecord([g.entry, own.entry, add2.entry, revoke2.entry, stale.entry], OPTS);
    expect(s.rejected.find((r) => r.id === stale.id)?.reason).toBe('signer-revoked');
    expect(s.forked).toBe(false);
    expect(s.policies.stolen).toBeUndefined();
  });
});

describe('order independence and bounds', () => {
  it('every order of a small set gives the same state', () => {
    const { g, own, addB } = enrolled();
    const left = entry('policy', [addB.id], { path: 'level', value: 'phone' }, O(o1));
    const right = entry('revoke-key', [addB.id], { keyId: mB.id }, O(o1));
    const all = [g.entry, own.entry, addB.entry, left.entry, right.entry];
    const ref = JSON.stringify(evaluateOwnerRecord(all, OPTS));
    const perms = (a: OwnerRecordEntry[]): OwnerRecordEntry[][] => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of perms(all)) expect(JSON.stringify(evaluateOwnerRecord(p, OPTS))).toBe(ref);
  });

  it('an oversized entry and a non-canonical one are rejected; too much input is refused whole', () => {
    const g = genesisOf();
    const big = entry('policy', [g.id], { path: 'x', value: 'y'.repeat(9000) }, M(mA));
    const s = evaluateOwnerRecord([g.entry, big.entry, { ...big.entry, body: { path: 'x', value: Number.NaN } }], OPTS);
    expect(s.rejected.map((r) => r.reason)).toEqual(expect.arrayContaining(['entry-too-large', 'not-canonical']));
    expect(evaluateOwnerRecord(new Array(OWNER_RECORD_MAX_INPUT + 1).fill(g.entry), OPTS).status).toBe('input-too-large');
  });
});

describe('regression: the second review\'s scenarios', () => {
  const s1 = { ...keypair(), id: 'o_stolen' };
  it('a stolen key revoking the owner against an old head ends in mutual revocation, not takeover', () => {
    const { g, own } = enrolled();
    const addS = entry('add-owner-key', [own.id], { keyId: s1.id, publicKey: s1.pub, label: 's' }, O(o1));
    const addB = entry('add-machine-key', [addS.id], { machineId: mB.id, publicKey: mB.pub }, O(o1));
    const revS = entry('revoke-key', [addB.id], { keyId: s1.id }, O(o1));
    const thief = entry('revoke-key', [addS.id], { keyId: o1.id }, O(s1)); // against the head before machine B
    const s = evaluateOwnerRecord([g.entry, own.entry, addS.entry, addB.entry, revS.entry, thief.entry], OPTS);
    expect(s.revoked).toEqual(expect.arrayContaining([o1.id, s1.id]));
    expect(s.keys.some((k) => k.type === 'owner-key')).toBe(false);
    expect(s.status).toBe('owner-lost'); // machine A remains, but human access is gone
  });

  it('a junk copy of an entry cannot erase it: any verifying signature counts', () => {
    const { g, own, addB } = enrolled();
    const rev = entry('revoke-key', [addB.id], { keyId: mB.id }, O(o1));
    const junk = { ...rev.entry, sig: '+' } as OwnerRecordEntry;
    const s = evaluateOwnerRecord([g.entry, own.entry, addB.entry, junk, rev.entry], OPTS);
    expect(s.revoked).toContain(mB.id);
  });

  it('a TLS-key entry on a stale head never forks the record', () => {
    const { g, own, addB } = enrolled();
    const tls = entry('tls-key', [addB.id], { machineId: mB.id, fingerprint: 'fp-b', seq: 1 }, M(mB));
    const p1 = entry('policy', [addB.id], { path: 'level', value: 'phone' }, O(o1));
    const p2 = entry('policy', [p1.id], { path: 'x', value: 1 }, O(o1));
    const s = evaluateOwnerRecord([g.entry, own.entry, addB.entry, tls.entry, p1.entry, p2.entry], OPTS);
    expect(s.forked).toBe(false);
    expect(s.level).toBe('phone');
    expect(s.tlsKeys[mB.id]).toBe('fp-b');
  });

  it('at Basic, a machine merge clears a fork', () => {
    const g = genesisOf();
    const a = entry('policy', [g.id], { path: 'a', value: 1 }, M(mA));
    const b = entry('policy', [g.id], { path: 'b', value: 2 }, M(mA));
    const merge = entry('merge', [a.id, b.id].sort(), {}, M(mA));
    const s = evaluateOwnerRecord([g.entry, a.entry, b.entry, merge.entry], OPTS);
    expect(s.forked).toBe(false);
    expect(s.policies).toEqual({ a: 1, b: 2 });
  });

  it('a machine re-added with a new key can publish its TLS key again', () => {
    const { g, own, addB } = enrolled();
    const mB2 = keypair();
    const rev = entry('revoke-key', [addB.id], { keyId: mB.id }, O(o1));
    const readd = entry('add-machine-key', [rev.id], { machineId: mB.id, publicKey: mB2.pub }, O(o1));
    const tls = entry('tls-key', [readd.id], { machineId: mB.id, fingerprint: 'fp-new', seq: 2 }, { type: 'machine', keyId: mB.id, priv: mB2.priv });
    const old = entry('tls-key', [addB.id], { machineId: mB.id, fingerprint: 'fp-old', seq: 1 }, M(mB)); // by the revoked instance
    const s = evaluateOwnerRecord([g.entry, own.entry, addB.entry, rev.entry, readd.entry, tls.entry, old.entry], OPTS);
    expect(s.tlsKeys[mB.id]).toBe('fp-new');
    expect(s.keys.find((k) => k.keyId === mB.id)?.publicKey).toBe(mB2.pub);
  });
});

describe('regression: the third review', () => {
  it('a revoked key cannot fork the record with revocations (they are side entries); unknown-key revocations do nothing', () => {
    const { g, own } = enrolled();
    const thiefKey = { ...keypair(), id: 'o_thief' };
    const addT = entry('add-owner-key', [own.id], { keyId: thiefKey.id, publicKey: thiefKey.pub, label: 't' }, O(o1));
    const revT = entry('revoke-key', [addT.id], { keyId: thiefKey.id }, O(o1));
    const junk = [1, 2, 3].map((i) => entry('revoke-key', [addT.id], { keyId: `o_ghost${i}` }, O(thiefKey)));
    const next = entry('policy', [revT.id], { path: 'level', value: 'phone' }, O(o1));
    const s = evaluateOwnerRecord([g.entry, own.entry, addT.entry, revT.entry, ...junk.map((j) => j.entry), next.entry], OPTS);
    expect(s.forked).toBe(false);
    expect(s.level).toBe('phone');
    for (const j of junk) expect(s.effective).not.toContain(j.id);
  });
});

describe('regression: the fourth review', () => {
  it('a revoked key cannot legitimise a backdated key by revoking itself on its own branch (probe G)', () => {
    const { g, own } = enrolled();
    const S = { ...keypair(), id: 'o_stolen2' };
    const K2 = { ...keypair(), id: 'o_k2' };
    const addS = entry('add-owner-key', [own.id], { keyId: S.id, publicKey: S.pub, label: 's' }, O(o1));
    const revS = entry('revoke-key', [addS.id], { keyId: S.id }, O(o1));
    const sAddsK2 = entry('add-owner-key', [addS.id], { keyId: K2.id, publicKey: K2.pub, label: 'k2' }, O(S)); // backdated
    const k2Evil = entry('policy', [sAddsK2.id], { path: 'level', value: 'evil' }, O(K2));
    const k2RevokesS = entry('revoke-key', [k2Evil.id], { keyId: S.id }, O(K2));
    const next = entry('policy', [revS.id], { path: 'level', value: 'phone' }, O(o1));
    const all = [g.entry, own.entry, addS.entry, revS.entry, sAddsK2.entry, k2Evil.entry, k2RevokesS.entry, next.entry];
    const s = evaluateOwnerRecord(all, OPTS);
    expect(s.keys.map((k) => k.keyId)).not.toContain(K2.id);
    expect(s.level).toBe('phone');
    expect(s.forked).toBe(false);
    const merge = entry('merge', [next.id, k2Evil.id].sort(), {}, O(o1));
    const merged = evaluateOwnerRecord([...all, merge.entry], OPTS);
    expect(merged.keys.map((k) => k.keyId)).not.toContain(K2.id);
    expect(merged.level).not.toBe('evil');
  });

  it('re-revoking an already-revoked key does nothing and is never kept (probe E)', () => {
    const { g, own } = enrolled();
    const S = { ...keypair(), id: 'o_stolen3' };
    const addS = entry('add-owner-key', [own.id], { keyId: S.id, publicKey: S.pub, label: 's' }, O(o1));
    const rev1 = entry('revoke-key', [addS.id], { keyId: S.id }, O(o1));
    const rev2 = entry('revoke-key', [rev1.id], { keyId: S.id }, O(o1));
    const s = evaluateOwnerRecord([g.entry, own.entry, addS.entry, rev1.entry, rev2.entry], OPTS);
    expect(s.rejected.find((r) => r.id === rev2.id)?.reason).toBe('already-revoked');
    expect(s.effective).not.toContain(rev2.id);
    expect(s.effective).toContain(rev1.id);
  });
});

describe('regression: the fifth review', () => {
  it('a revoked key revoking itself against an old head is reported as contested, never a silent downgrade (probe H)', () => {
    const { g, own } = enrolled();
    const S = { ...keypair(), id: 'o_tablet' };
    const K3 = { ...keypair(), id: 'o_k3' };
    const addS = entry('add-owner-key', [own.id], { keyId: S.id, publicKey: S.pub, label: 'tablet' }, O(o1));
    const sLevel = entry('policy', [addS.id], { path: 'level', value: 'phone' }, O(S));
    const sAddsK3 = entry('add-owner-key', [sLevel.id], { keyId: K3.id, publicKey: K3.pub, label: 'k3' }, O(S));
    const k3q = entry('policy', [sAddsK3.id], { path: 'q', value: 1 }, O(K3));
    const ownerRevokesS = entry('revoke-key', [k3q.id], { keyId: S.id }, O(o1));
    const thiefSelfRevoke = entry('revoke-key', [addS.id], { keyId: S.id }, O(S)); // against the old head
    const s = evaluateOwnerRecord([g.entry, own.entry, addS.entry, sLevel.entry, sAddsK3.entry, k3q.entry, ownerRevokesS.entry, thiefSelfRevoke.entry], OPTS);
    // An evaluator can't tell the thief's self-revocation from an honest one: never a silent downgrade.
    expect(s.status).toBe('contested');
    expect(s.contested.length).toBeGreaterThan(0);
    expect(s.revoked).toContain(S.id);
  });
});

describe('regression: the sixth review', () => {
  it('a device added by the first owner key can still revoke it, and the thief gains nothing (probe I)', () => {
    const { g, own } = enrolled();
    const o2b = { ...keypair(), id: 'o_two' };
    const evil = { ...keypair(), id: 'o_evil' };
    const addO2 = entry('add-owner-key', [own.id], { keyId: o2b.id, publicKey: o2b.pub, label: 'two' }, O(o1));
    const o2RevokesO1 = entry('revoke-key', [addO2.id], { keyId: o1.id }, O(o2b));
    const thiefAdd = entry('add-owner-key', [own.id], { keyId: evil.id, publicKey: evil.pub, label: 'evil' }, O(o1)); // old head
    const evilLevel = entry('policy', [thiefAdd.id], { path: 'level', value: 'evil' }, O(evil));
    const next = entry('policy', [o2RevokesO1.id], { path: 'level', value: 'phone' }, O(o2b));
    const all = [g.entry, own.entry, addO2.entry, o2RevokesO1.entry, thiefAdd.entry, evilLevel.entry, next.entry];
    const s = evaluateOwnerRecord(all, OPTS);
    expect(s.keys.map((k) => k.keyId)).not.toContain(evil.id);
    expect(s.level).toBe('phone');
    expect(s.forked).toBe(false);
  });
});

describe('regression: the seventh review', () => {
  it('a stolen key outside the line revoking the honest one, against an old head, is contested, never silent (probe J)', () => {
    const { g, own } = enrolled();
    const T = { ...keypair(), id: 'o_t' };
    const S = { ...keypair(), id: 'o_s' };
    const NEW = { ...keypair(), id: 'o_new' };
    const addT = entry('add-owner-key', [own.id], { keyId: T.id, publicKey: T.pub, label: 't' }, O(o1));
    const addS = entry('add-owner-key', [addT.id], { keyId: S.id, publicKey: S.pub, label: 's' }, O(o1));
    const sLevel = entry('policy', [addS.id], { path: 'level', value: 'phone' }, O(S));
    const sNew = entry('add-owner-key', [sLevel.id], { keyId: NEW.id, publicKey: NEW.pub, label: 'new' }, O(S));
    const sRevT = entry('revoke-key', [sNew.id], { keyId: T.id }, O(S));
    const tRevS = entry('revoke-key', [addS.id], { keyId: S.id }, O(T)); // thief, old head
    const s = evaluateOwnerRecord([g.entry, own.entry, addT.entry, addS.entry, sLevel.entry, sNew.entry, sRevT.entry, tRevS.entry], OPTS);
    expect(s.revoked).toEqual(expect.arrayContaining([S.id, T.id]));
    expect(s.status).toBe('contested');
  });

  it('an honest revocation by a still-valid key is not contested (probe I stays ok)', () => {
    const { g, own } = enrolled();
    const o2b = { ...keypair(), id: 'o_two2' };
    const addO2 = entry('add-owner-key', [own.id], { keyId: o2b.id, publicKey: o2b.pub, label: 'two' }, O(o1));
    const o2RevokesO1 = entry('revoke-key', [addO2.id], { keyId: o1.id }, O(o2b));
    const late = entry('policy', [own.id], { path: 'x', value: 1 }, O(o1)); // by o1 on an old head: excluded by o2's revocation
    const s = evaluateOwnerRecord([g.entry, own.entry, addO2.entry, o2RevokesO1.entry, late.entry], OPTS);
    expect(s.status).toBe('ok');
    expect(s.policies.x).toBeUndefined();
  });
});

/** What 2b stores: `keep` plus ancestors. A stored copy must evaluate to the same state. */
function storedCopy(all: Array<{ id: string; entry: unknown }>, s: ReturnType<typeof evaluateOwnerRecord>) {
  const byId = new Map(all.map((x) => [x.id, x.entry as { parents: string[] }]));
  const kept = new Set<string>(); const stack = [...s.keep];
  while (stack.length) { const id = stack.pop()!; if (kept.has(id) || !byId.has(id)) continue; kept.add(id); stack.push(...byId.get(id)!.parents); }
  return evaluateOwnerRecord(all.filter((x) => kept.has(x.id)).map((x) => x.entry), OPTS);
}
const sameState = (a: ReturnType<typeof evaluateOwnerRecord>, b: ReturnType<typeof evaluateOwnerRecord>) => {
  for (const k of ['status', 'level', 'policies', 'keys', 'revoked', 'contested', 'everEnrolled', 'agentProducible'] as const) expect(b[k]).toEqual(a[k]);
};

describe('regression: the code second pass', () => {
  it('a sender-controlled object with a bad toString is rejected, never a crash', () => {
    const { g, own } = enrolled();
    const raw = JSON.parse(JSON.stringify({ v: 1, kind: 'add-machine-key', agentId: AGENT, parents: [own.id], signer: { type: 'owner-key', keyId: o1.id }, sig: 'AAAA' }));
    raw.body = JSON.parse('{"machineId":{"toString":1},"publicKey":"x"}');
    const raw2 = JSON.parse(`{"v":1,"kind":{"toString":1},"agentId":"${AGENT}"}`);
    const s = evaluateOwnerRecord([g.entry, own.entry, raw, raw2], OPTS);
    expect(s.status).toBe('ok');
    expect(s.rejected.length).toBe(2);
  });

  it('the stored copy keeps every exclusion: a revoked key cannot come back after storage', () => {
    const { g, own } = enrolled();
    const o2b = { ...keypair(), id: 'o_two3' };
    const addK = entry('add-owner-key', [own.id], { keyId: o2b.id, publicKey: o2b.pub, label: 'k' }, O(o1));
    const kEntry = entry('policy', [addK.id], { path: 'byK', value: 1 }, O(o2b));
    let tried = 0;
    for (let i = 0; i < 200; i++) {
      const brX = entry('policy', [addK.id], { path: 'x', value: i }, O(o1));
      const rConc = entry('revoke-key', [brX.id], { keyId: o2b.id }, O(o1));
      const rDesc = entry('revoke-key', [kEntry.id], { keyId: o2b.id }, O(o1));
      if (!(rDesc.id < rConc.id)) continue;
      const m = entry('merge', [brX.id, kEntry.id].sort(), {}, O(o1));
      const all = [g, own, addK, kEntry, brX, rConc, rDesc, m];
      const full = evaluateOwnerRecord(all.map((x) => x.entry), OPTS);
      expect(full.policies.byK).toBeUndefined();
      sameState(full, storedCopy(all, full));
      tried++; break;
    }
    expect(tried).toBe(1);
  });

  it('a contested record stays contested after storage (probe J)', () => {
    const { g, own } = enrolled();
    const T = { ...keypair(), id: 'o_t2' }; const S = { ...keypair(), id: 'o_s2' }; const NEW = { ...keypair(), id: 'o_new2' };
    const addT = entry('add-owner-key', [own.id], { keyId: T.id, publicKey: T.pub, label: 't' }, O(o1));
    const addS = entry('add-owner-key', [addT.id], { keyId: S.id, publicKey: S.pub, label: 's' }, O(o1));
    const sLevel = entry('policy', [addS.id], { path: 'level', value: 'phone' }, O(S));
    const sNew = entry('add-owner-key', [sLevel.id], { keyId: NEW.id, publicKey: NEW.pub, label: 'new' }, O(S));
    const sRevT = entry('revoke-key', [sNew.id], { keyId: T.id }, O(S));
    const tRevS = entry('revoke-key', [addS.id], { keyId: S.id }, O(T));
    const all = [g, own, addT, addS, sLevel, sNew, sRevT, tRevS];
    const full = evaluateOwnerRecord(all.map((x) => x.entry), OPTS);
    expect(full.status).toBe('contested');
    sameState(full, storedCopy(all, full));
  });

  it('the rejected list is the same for any input order and for duplicates', () => {
    const { g, own } = enrolled();
    const bad1 = { v: 2, kind: 'policy', agentId: AGENT };
    const bad2 = { v: 1, kind: 'nope', agentId: AGENT };
    const a = evaluateOwnerRecord([g.entry, own.entry, bad1, bad2], OPTS).rejected;
    const b = evaluateOwnerRecord([bad2, bad1, bad1, own.entry, g.entry], OPTS).rejected;
    expect(b).toEqual(a);
  });
});

describe('regression: TLS flood (2b review)', () => {
  it('only the latest TLS entry per machine is kept, and nothing may build on a TLS entry', () => {
    const { g, own } = enrolled();
    const tlsEntries = Array.from({ length: 50 }, (_, i) => entry('tls-key', [own.id], { machineId: mA.id, fingerprint: `fp${i}`, seq: i }, M(mA)));
    const onTls = entry('policy', [tlsEntries[0].id], { path: 'z', value: 1 }, O(o1));
    const all = [g, own, ...tlsEntries, onTls];
    const full = evaluateOwnerRecord(all.map((x) => x.entry), OPTS);
    expect(full.tlsKeys[mA.id]).toBe('fp49');
    expect(full.keep.filter((id) => tlsEntries.some((t) => t.id === id))).toEqual([tlsEntries[49].id]);
    expect(full.rejected).toContainEqual({ id: onTls.id, reason: 'parent-is-tls-key' });
    expect(full.policies.z).toBeUndefined();
    sameState(full, storedCopy(all, full));
    expect(storedCopy(all, full).tlsKeys).toEqual(full.tlsKeys);
  });
});
