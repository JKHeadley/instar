import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerRecordStore, type OwnerRecordSelf } from '../../src/core/ownerRecordStore.js';
import { signOwnerRecordEntry, ownerRecordEntryId, type OwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AGENT = 'agent-1';
const proof = (b: Record<string, unknown>) => b.proof === 'route-ok';

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, priv: privateKey as string };
}
const signer = (priv: string) => (t: string) => crypto.sign(null, Buffer.from(t), priv).toString('base64');
const machine = (id: string) => { const k = keypair(); return { id, ...k, self: { machineId: id, publicKeyPem: k.pub, sign: signer(k.priv) } as OwnerRecordSelf }; };

let dir: string;
let registry: Map<string, string>;
const peersQuiet = { allAnswered: false, honouredPeerMarker: false };
const peersDone = { allAnswered: true, honouredPeerMarker: false };

function store(self: OwnerRecordSelf | null, instarDir = dir) {
  const s = new OwnerRecordStore({ instarDir, agentId: AGENT, self: () => self, registeredKey: (m) => registry.get(m) ?? null, verifyFirstOwnerProof: proof });
  s.load();
  return s;
}
function enrol(s: OwnerRecordStore, head: string) {
  const o = keypair();
  const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [head], body: { keyId: 'o_phone', publicKey: o.pub, label: 'phone', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
  s.ingest([add.entry]);
  return { add, o };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-')); registry = new Map(); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/identity-piece2b-owner-record-store.test.ts:cleanup' }); });

describe('bootstrap at Basic', () => {
  it('writes a Basic genesis with the machine key, a seen marker, and no pin', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    expect(s.gate(peersQuiet)).toMatchObject({ act: 'basic', enrolment: 'never', reason: 'no-record-yet' });
    const { state } = s.bootstrap();
    expect(state.status).toBe('ok');
    expect(state.level).toBe('basic');
    expect(s.seenMarker()).toBe(true);
    expect(s.pinned()).toBeNull();
    expect(s.gate(peersQuiet)).toMatchObject({ act: 'basic', enrolment: 'never' });
    expect(fs.statSync(path.join(dir, 'state', 'owner-record', 'entries.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('a machine with no identity creates no record', () => {
    expect(() => store(null).bootstrap()).toThrow(/machine identity/);
  });

  it('a stored record survives a restart (state recomputed from entries)', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    store(m.self).bootstrap();
    const again = store(m.self);
    expect(again.state()?.status).toBe('ok');
    expect(again.hasRecord()).toBe(true);
  });
});

describe('enrolment is sticky', () => {
  it('pins the genesis and writes the enrolled marker at the first owner key', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const g = s.bootstrap();
    enrol(s, g.id);
    expect(s.state()?.everEnrolled).toBe(true);
    expect(s.pinned()).toBe(g.id);
    expect(s.enrolledMarker().kind).toBe('ok');
    expect(s.gate(peersQuiet)).toMatchObject({ act: 'record', enrolment: 'enrolled' });
  });

  it('a deleted record on an enrolled machine holds and never bootstraps', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    enrol(s, s.bootstrap().id);
    SafeFsExecutor.safeRmSync(path.join(dir, 'state', 'owner-record'), { recursive: true, force: true, operation: 'test: delete the record folder' });
    const after = store(m.self);
    expect(after.gate(peersDone)).toMatchObject({ act: 'hold', enrolment: 'enrolled', reason: 'record-missing' });
    expect(() => after.bootstrap()).toThrow(/enrolled/);
  });

  it('an unreadable or other-agent marker holds as unknown', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    s.bootstrap();
    fs.writeFileSync(path.join(dir, 'machine', 'owner-record-enrolled.json'), '{not json');
    expect(s.gate(peersDone)).toMatchObject({ act: 'hold', enrolment: 'unknown', reason: 'enrolment-unknown' });
    fs.writeFileSync(path.join(dir, 'machine', 'owner-record-enrolled.json'), JSON.stringify({ agentId: 'other', genesis: 'x', at: 'now' }));
    expect(s.gate(peersDone)).toMatchObject({ act: 'hold', enrolment: 'unknown' });
  });

  it('an honoured peer marker makes a Basic machine hold', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    s.bootstrap();
    expect(s.gate({ allAnswered: true, honouredPeerMarker: true })).toMatchObject({ act: 'hold', enrolment: 'enrolled' });
  });
});

describe('three outcomes: never, enrolled, unknown', () => {
  it('a lost record (seen marker, no record) is unknown until every peer answers', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    store(m.self).bootstrap();
    SafeFsExecutor.safeRmSync(path.join(dir, 'state', 'owner-record'), { recursive: true, force: true, operation: 'test: lose the record' });
    const s = store(m.self);
    expect(s.gate(peersQuiet)).toMatchObject({ act: 'hold', enrolment: 'unknown', reason: 'record-lost-waiting-for-peers' });
    expect(s.gate(peersDone)).toMatchObject({ act: 'basic', enrolment: 'never' });
  });

  it('a legacy install with no record and no seen marker is Basic at once, even with a peer asleep', () => {
    const m = machine('m_A');
    expect(store(m.self).gate(peersQuiet)).toMatchObject({ act: 'basic', enrolment: 'never', reason: 'no-record-yet' });
  });
});

describe('choosing the genesis', () => {
  it('ignores a genesis from an unregistered key, even with a lower machine id', () => {
    const a = machine('m_B'); registry.set(a.id, a.pub);
    const s = store(a.self);
    const mine = s.bootstrap();
    const fake = machine('m_A'); // not in the registry
    const g = signOwnerRecordEntry({ kind: 'genesis', agentId: AGENT, parents: [], body: { machineId: fake.id, publicKey: fake.pub, level: 'basic', agentProducible: true }, signer: { type: 'machine', keyId: fake.id } }, fake.self.sign);
    s.ingest([g.entry]);
    expect(s.state()?.genesis).toBe(mine.id);
  });

  it('two registered Basic geneses converge on the lowest machine id', () => {
    const a = machine('m_A'); const b = machine('m_B'); registry.set(a.id, a.pub); registry.set(b.id, b.pub);
    const sb = store(b.self, fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-b-')));
    const gb = sb.bootstrap();
    const sa = store(a.self);
    const ga = sa.bootstrap();
    sb.ingest(sa.page(new Set(), null).entries);
    sa.ingest(sb.page(new Set(), null).entries);
    expect(sa.state()?.genesis).toBe(ga.id);
    expect(sb.state()?.genesis).toBe(ga.id);
    expect(gb.id).not.toBe(ga.id);
  });

  it('an enrolled record beats a Basic one with a lower machine id', () => {
    const a = machine('m_A'); const b = machine('m_B'); registry.set(a.id, a.pub); registry.set(b.id, b.pub);
    const sb = store(b.self, fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-b-')));
    const gb = sb.bootstrap();
    enrol(sb, gb.id);
    const sa = store(a.self);
    sa.bootstrap();
    sa.ingest(sb.page(new Set(), null).entries);
    expect(sa.state()?.genesis).toBe(gb.id);
    expect(sa.state()?.everEnrolled).toBe(true);
    expect(sa.pinned()).toBe(gb.id);
  });
});

describe('storage', () => {
  it('stores the one verifying signature, never a junk copy', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const g = s.bootstrap();
    const p = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [g.id], body: { path: 'x', value: 1 }, signer: { type: 'machine', keyId: m.id } }, m.self.sign);
    const junk: OwnerRecordEntry = { ...p.entry, sig: 'AAAA' };
    s.ingest([junk, p.entry]);
    const lines = fs.readFileSync(path.join(dir, 'state', 'owner-record', 'entries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as OwnerRecordEntry);
    const stored = lines.find((e) => ownerRecordEntryId(e) === p.id)!;
    expect(stored.sig).toBe(p.entry.sig);
    expect(s.state()?.policies.x).toBe(1);
  });

  it('pages entries by id with a cursor', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    let head = s.bootstrap().id;
    for (let i = 0; i < 5; i++) {
      const p = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [head], body: { path: `p${i}`, value: i }, signer: { type: 'machine', keyId: m.id } }, m.self.sign);
      s.ingest([p.entry]); head = p.id;
    }
    const first = s.page(new Set(), null, 4);
    expect(first.entries.length).toBe(4);
    const second = s.page(new Set(), first.next, 4);
    expect(second.entries.length).toBe(2);
    expect(second.next).toBeNull();
  });

  it('replaces a failing Basic record and excludes the old genesis', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const old = s.bootstrap();
    // The genesis machine's key rotates: the old genesis no longer matches the registry, so the record fails.
    const rotated = machine('m_A'); registry.set(m.id, rotated.pub);
    const s2 = store(rotated.self);
    expect(s2.state()?.status).not.toBe('ok');
    expect(s2.gate(peersDone)).toMatchObject({ act: 'basic', enrolment: 'never' });
    const fresh = s2.bootstrap();
    expect(s2.state()?.status).toBe('ok');
    expect(s2.state()?.genesis).toBe(fresh.id);
    const excluded = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'owner-record', 'excluded-geneses.json'), 'utf8'));
    expect(excluded).toContain(old.id);
    expect(s2.ids()).not.toContain(old.id);
  });
});

describe('regression: the code second pass', () => {
  it('an over-bound flood of junk never wipes the stored record', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    enrol(s, s.bootstrap().id);
    const before = s.ids();
    const junk = Array.from({ length: 2001 }, (_, i) => ({ v: 1, kind: 'policy', agentId: AGENT, parents: ['0'.repeat(64)], body: { path: `j${i}`, value: i }, signer: { type: 'machine', keyId: m.id }, sig: 'AAAA' }));
    const r = s.ingest(junk); // unsigned junk is dropped on arrival, so it never reaches the bound
    expect(r.added).toEqual([]);
    expect(s.ids()).toEqual(before);
    expect(store(m.self).ids()).toEqual(before);
    expect(store(m.self).state()?.everEnrolled).toBe(true);
  });

  it('a result with no genesis (its machine left the registry) never wipes the stored record', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const g = s.bootstrap();
    registry.delete(m.id);
    const p = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [g.id], body: { path: 'x', value: 1 }, signer: { type: 'machine', keyId: m.id } }, m.self.sign);
    expect(s.ingest([p.entry]).refused).toBe('no-genesis');
    expect(s.ids()).toContain(g.id);
  });

  it('stores every ancestor of a kept entry, so a reload gives the same state', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const { add, o } = enrol(s, s.bootstrap().id);
    const o2 = keypair();
    const add2 = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_two', publicKey: o2.pub, label: 'two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const pre = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [add2.id], body: { path: 'pre', value: 1 }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const r1 = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [add2.id], body: { keyId: 'o_two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const r2 = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [pre.id], body: { keyId: 'o_two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const [lo, hi] = r1.id < r2.id ? [r1, r2] : [r2, r1];
    const onHi = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [hi.id], body: { path: 'level', value: 'phone' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    s.ingest([add2.entry, pre.entry, lo.entry, hi.entry, onHi.entry]);
    const live = s.state()!;
    const reloaded = store(m.self).state()!;
    expect(reloaded.level).toBe(live.level);
    expect(reloaded.policies).toEqual(live.policies);
    expect(reloaded.keys.map((k) => k.keyId)).toEqual(live.keys.map((k) => k.keyId));
  });

  it('a genesis naming one this machine never held does not exclude it', () => {
    const a = machine('m_A'); const b = machine('m_B'); registry.set(a.id, a.pub); registry.set(b.id, b.pub);
    const sa = store(a.self, fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-a-')));
    const ga = sa.bootstrap();
    const fresh = store(b.self);
    const gb = signOwnerRecordEntry({ kind: 'genesis', agentId: AGENT, parents: [], body: { machineId: b.id, publicKey: b.pub, level: 'basic', agentProducible: true, replaces: ga.id }, signer: { type: 'machine', keyId: b.id } }, b.self.sign);
    fresh.ingest([gb.entry]);
    expect(fs.existsSync(path.join(dir, 'state', 'owner-record', 'excluded-geneses.json'))).toBe(false);
    fresh.ingest(sa.page(new Set(), null).entries);
    expect(fresh.state()?.genesis).toBe(ga.id); // the tie rule, not an exclusion
  });
});

describe('regression: the code second pass, round 2', () => {
  it('junk that does not verify never counts toward the bound', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    enrol(s, s.bootstrap().id);
    const head = s.state()!.head[0];
    const junk = Array.from({ length: 2001 }, (_, i) => ({ v: 1, kind: 'policy', agentId: AGENT, parents: [head], body: { path: `j${i}`, value: i }, signer: { type: 'owner-key', keyId: 'o_phone' }, sig: 'AAAA' }));
    const r = s.ingest(junk);
    expect(r.refused).toBeUndefined();
    expect(r.added).toEqual([]);
    expect(s.state()?.status).toBe('ok');
  });

  it('a verified flood past the bound reads input-too-large and holds, here and after a restart, and keeps revocations', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const { add, o } = enrol(s, s.bootstrap().id);
    // A stolen second owner key floods the record.
    const thief = keypair();
    const addThief = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_thief', publicKey: thief.pub, label: 't' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    s.ingest([addThief.entry]);
    let head = addThief.id;
    const flood: OwnerRecordEntry[] = [];
    for (let i = 0; i < 2000; i++) {
      const p = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [head], body: { path: 'f', value: i }, signer: { type: 'owner-key', keyId: 'o_thief' } }, signer(thief.priv));
      flood.push(p.entry); head = p.id;
    }
    s.ingest(flood);
    const revoke = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [addThief.id], body: { keyId: 'o_thief' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    s.ingest([revoke.entry]);
    expect(s.ids()).toContain(revoke.id);
    expect(s.gate(peersDone)).toMatchObject({ act: 'hold', enrolment: 'enrolled' });
    const again = store(m.self);
    expect(again.state()?.status).toBe('input-too-large');
    expect(again.gate(peersDone)).toMatchObject({ act: 'hold', enrolment: 'enrolled' });
    expect(again.ids().length).toBeLessThanOrEqual(2_501);
  }, 60_000);
});

describe('regression: the code second pass, round 3', () => {
  it('a key chain of any depth arriving in reverse order is stored in one pass, and the revoked key is not valid', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const src = store(m.self, fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-src-')));
    const g = src.bootstrap();
    const { add, o } = enrol(src, g.id);
    let head = add.id; let prevKey = { id: 'o_phone', priv: o.priv };
    const all: OwnerRecordEntry[] = [];
    for (let k = 1; k <= 5; k++) {
      const kp = keypair();
      const addK = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [head], body: { keyId: `o_k${k}`, publicKey: kp.pub, label: `k${k}` }, signer: { type: 'owner-key', keyId: prevKey.id } }, signer(prevKey.priv));
      const rev = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [addK.id], body: { keyId: prevKey.id }, signer: { type: 'owner-key', keyId: `o_k${k}` } }, signer(kp.priv));
      all.push(addK.entry, rev.entry); head = rev.id; prevKey = { id: `o_k${k}`, priv: kp.priv };
    }
    src.ingest(all);
    expect(src.state()?.keys.filter((k) => k.type === 'owner-key').map((k) => k.keyId)).toEqual(['o_k5']);
    const fresh = store(m.self);
    fresh.ingest(src.page(new Set(), null).entries.slice().reverse());
    expect(fresh.ids()).toEqual(src.ids());
    expect(fresh.state()?.keys.filter((k) => k.type === 'owner-key').map((k) => k.keyId)).toEqual(['o_k5']);
  });

  it('past the cap, only owner revocations of known keys are kept, at most 50, never machine-signed ones', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const { add, o } = enrol(s, s.bootstrap().id);
    const thief = keypair();
    const addThief = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_thief', publicKey: thief.pub, label: 't' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    s.ingest([addThief.entry]);
    let head = addThief.id;
    for (let batch = 0; batch < 6; batch++) {
      const flood: OwnerRecordEntry[] = [];
      for (let i = 0; i < 500; i++) {
        const p = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [head], body: { path: 'f', value: batch * 500 + i }, signer: { type: 'owner-key', keyId: 'o_thief' } }, signer(thief.priv));
        flood.push(p.entry); head = p.id;
      }
      s.ingest(flood);
    }
    expect(s.ids().length).toBeLessThanOrEqual(2_500);
    const machineRevs = Array.from({ length: 100 }, (_, i) => signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [g0(s)], body: { keyId: `m_X${i}` }, signer: { type: 'machine', keyId: m.id } }, m.self.sign).entry);
    s.ingest(machineRevs);
    expect(s.ids().length).toBeLessThanOrEqual(2_500);
    const ownerRev = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [addThief.id], body: { keyId: 'o_thief' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    s.ingest([ownerRev.entry]);
    expect(s.ids()).toContain(ownerRev.id);
    expect(s.ids().length).toBeLessThanOrEqual(2_550);
  }, 120_000);
});

function g0(s: OwnerRecordStore): string {
  return s.page(new Set(), null, 10_000).entries.find((e) => e.kind === 'genesis')!.parents.length === 0
    ? ownerRecordEntryId(s.page(new Set(), null, 10_000).entries.find((e) => e.kind === 'genesis')!)
    : '';
}

describe('regression: the code second pass, round 4', () => {
  it('a junk self-signed add under the same key id cannot stand in for the real one', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const { add, o } = enrol(s, s.bootstrap().id);
    const k2 = keypair(); const evil = keypair();
    const junkAdd = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: ['e'.repeat(64)], body: { keyId: 'o_k2', publicKey: evil.pub, label: 'x' }, signer: { type: 'owner-key', keyId: 'o_k2' } }, signer(evil.priv));
    const realAdd = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_k2', publicKey: k2.pub, label: 'k2' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const rev = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [realAdd.id], body: { keyId: 'o_phone' }, signer: { type: 'owner-key', keyId: 'o_k2' } }, signer(k2.priv));
    s.ingest([junkAdd.entry, realAdd.entry, rev.entry]); // the junk comes first
    expect(s.state()?.keys.filter((k) => k.type === 'owner-key').map((k) => k.keyId)).toEqual(['o_k2']);
  });
});

describe('regression: the code second pass, round 5', () => {
  it('500 self-signed introducers plus 500 entries signed under that key id are checked in well under a second', () => {
    const m = machine('m_A'); registry.set(m.id, m.pub);
    const s = store(m.self);
    const { add } = enrol(s, s.bootstrap().id);
    const batch: OwnerRecordEntry[] = [];
    for (let i = 0; i < 500; i++) {
      const k = keypair();
      batch.push(signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_x', publicKey: k.pub, label: `x${i}` }, signer: { type: 'owner-key', keyId: 'o_x' } }, signer(k.priv)).entry);
    }
    const other = keypair();
    for (let i = 0; i < 500; i++) {
      batch.push(signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [add.id], body: { path: `p${i}`, value: i }, signer: { type: 'owner-key', keyId: 'o_x' } }, signer(other.priv)).entry);
    }
    const t = Date.now();
    s.ingest(batch);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(s.state()?.keys.map((k) => k.keyId)).not.toContain('o_x');
  }, 60_000);
});

describe('regression: the code second pass, round 6', () => {
  for (const mode of ['self', 'other'] as const) {
    it(`20 junk introducers (${mode}-signed) can't crowd out the real one`, () => {
      const m = machine('m_A'); registry.set(m.id, m.pub);
      const s = store(m.self);
      const { add, o } = enrol(s, s.bootstrap().id);
      const junk: OwnerRecordEntry[] = [];
      for (let i = 0; i < 20; i++) {
        const k = keypair();
        const signerId = mode === 'self' ? 'o_k2' : 'o_k9';
        junk.push(signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_k2', publicKey: k.pub, label: `j${i}` }, signer: { type: 'owner-key', keyId: signerId } }, signer(k.priv)).entry);
      }
      const k2 = keypair();
      const realAdd = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_k2', publicKey: k2.pub, label: 'k2' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
      const rev = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [realAdd.id], body: { keyId: 'o_phone' }, signer: { type: 'owner-key', keyId: 'o_k2' } }, signer(k2.priv));
      s.ingest([...junk, realAdd.entry, rev.entry]);
      expect(s.ids()).toContain(rev.id);
      expect(s.state()?.keys.filter((k) => k.type === 'owner-key').map((k) => k.keyId)).toEqual(['o_k2']);
    });
  }
});
