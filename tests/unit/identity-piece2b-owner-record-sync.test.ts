import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerRecordStore, type OwnerRecordSelf } from '../../src/core/ownerRecordStore.js';
import { OwnerRecordSync, type OwnerRecordPullCmd, type OwnerRecordPushCmd } from '../../src/core/ownerRecordSync.js';
import { signOwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AGENT = 'agent-1';
const proof = (b: Record<string, unknown>) => b.proof === 'route-ok';
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, priv: privateKey as string };
}
const signer = (priv: string) => (t: string) => crypto.sign(null, Buffer.from(t), priv).toString('base64');

interface Node { id: string; store: OwnerRecordStore; sync: OwnerRecordSync; self: OwnerRecordSelf; dir: string; up: boolean; lease: boolean; degraded: string[] }
let dirs: string[];
let registry: Map<string, string>;
let nodes: Map<string, Node>;
let clock: number;

function node(id: string, opts: { lease?: boolean } = {}): Node {
  const k = keypair();
  const self: OwnerRecordSelf = { machineId: id, publicKeyPem: k.pub, sign: signer(k.priv) };
  registry.set(id, k.pub);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p2bs-${id}-`)); dirs.push(dir);
  const store = new OwnerRecordStore({ instarDir: dir, agentId: AGENT, self: () => self, registeredKey: (m) => registry.get(m) ?? null, verifyFirstOwnerProof: proof, now: () => clock });
  store.load();
  const n: Node = { id, store, self, dir, up: true, lease: !!opts.lease, degraded: [], sync: undefined as unknown as OwnerRecordSync };
  n.sync = new OwnerRecordSync({
    store, agentId: AGENT, selfMachineId: () => id,
    peers: () => [...nodes.keys()].filter((m) => m !== id),
    send: async (to, cmd) => {
      const peer = nodes.get(to);
      if (!peer?.up) return { ok: false };
      if (cmd.type === 'owner-record-pull') return { ok: true, result: peer.sync.handlePull(id, cmd as OwnerRecordPullCmd) };
      const r = peer.sync.handlePush(id, cmd as OwnerRecordPushCmd);
      await peer.sync.flush(true);
      return { ok: r.ok, result: r };
    },
    isLeaseHolder: () => n.lease, splitBrain: () => false,
    degrade: (msg) => n.degraded.push(msg),
    now: () => clock,
  });
  nodes.set(id, n);
  return n;
}

beforeEach(() => { dirs = []; registry = new Map(); nodes = new Map(); clock = Date.parse('2026-11-18T12:00:00Z'); });
afterEach(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece2b-owner-record-sync.test.ts:cleanup' }); });

describe('bootstrap over the mesh', () => {
  it('the lease holder bootstraps once every peer answered "none", and the peer adopts it', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B');
    await a.sync.tick();
    expect(a.store.state()?.status).toBe('ok');
    await b.sync.tick();
    expect(b.store.state()?.genesis).toBe(a.store.state()?.genesis);
  });

  it('a silent peer blocks bootstrap; Basic still works; backoff; a breaker after 24 h with one report', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B'); b.up = false;
    await a.sync.tick();
    expect(a.store.hasRecord()).toBe(false);
    expect(a.store.gate(a.sync.peerView())).toMatchObject({ act: 'basic', enrolment: 'never' });
    for (let h = 0; h < 30; h++) { clock += 60 * 60 * 1000; await a.sync.tick(); }
    expect(a.degraded.length).toBe(1);
    expect(a.sync.status()).toMatchObject({ breakerOpen: true });
    // Hearing from the peer re-arms it.
    b.up = true; a.sync.heardFrom('m_B');
    await a.sync.tick();
    expect(a.store.hasRecord()).toBe(true);
  });

  it('a peer reporting an enrolled marker blocks bootstrap', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B');
    fs.mkdirSync(path.join(b.dir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(b.dir, 'machine', 'owner-record-enrolled.json'), JSON.stringify({ agentId: AGENT, machineId: 'm_B', genesis: 'f'.repeat(64), at: 'x' }));
    await a.sync.tick();
    expect(a.store.hasRecord()).toBe(false);
  });

  it('only the lease holder bootstraps', async () => {
    const a = node('m_A'); node('m_B');
    await a.sync.tick();
    expect(a.store.hasRecord()).toBe(false);
  });
});

describe('keeping machines in step', () => {
  it('an enrolment on one machine reaches the others by push, and they pin it', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B'); const c = node('m_C');
    await a.sync.tick(); await b.sync.tick(); await c.sync.tick();
    const head = a.store.state()!.head[0];
    const o = keypair();
    const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [head], body: { keyId: 'o_phone', publicKey: o.pub, label: 'phone', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const { added } = a.store.ingest([add.entry]);
    await a.sync.pushToPeers(added);
    for (const n of [b, c]) {
      expect(n.store.state()?.everEnrolled).toBe(true);
      expect(n.store.pinned()).toBe(a.store.state()?.genesis);
      expect(n.store.gate(n.sync.peerView())).toMatchObject({ act: 'record', enrolment: 'enrolled' });
    }
  });

  it('refuses an oversized push whole, and rate-limits a peer that is not on the revocation lane', async () => {
    const a = node('m_A', { lease: true }); node('m_B');
    await a.sync.tick();
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: new Array(501).fill({}) })).toMatchObject({ ok: false, reason: 'too-large' });
    const g = a.store.state()!.head[0];
    const mk = (i: number) => signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [g], body: { path: `p${i}`, value: i }, signer: { type: 'machine', keyId: 'm_A' } }, a.self.sign).entry;
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [mk(1)] }).ok).toBe(true);
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [mk(2)] })).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('a junk revocation does not get the lane; a real one by a valid key does', async () => {
    const a = node('m_A', { lease: true }); node('m_B');
    await a.sync.tick();
    const head = a.store.state()!.head[0];
    const o = keypair(); const o2 = keypair();
    const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [head], body: { keyId: 'o_phone', publicKey: o.pub, label: 'phone', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const add2 = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_two', publicKey: o2.pub, label: 'two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    a.store.ingest([add.entry, add2.entry]);
    const filler = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [add2.id], body: { path: 'f', value: 1 }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [filler.entry] }).ok).toBe(true);
    const junk = { ...signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [add2.id], body: { keyId: 'o_two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv)).entry, sig: 'AAAA' };
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [junk] })).toMatchObject({ ok: false, reason: 'busy' });
    const real = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [add2.id], body: { keyId: 'o_two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv)).entry;
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [real] }).ok).toBe(true);
    await a.sync.flush(true);
    expect(a.store.state()?.revoked).toContain('o_two');
  });

  it('the bootstrap push reaches the peer, and a new lease holder never starts a second record', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B');
    await a.sync.tick();
    expect(b.store.state()?.genesis).toBe(a.store.state()?.genesis); // pushed at bootstrap
    b.lease = true; a.lease = false; a.up = false;
    await b.sync.tick();
    expect(b.store.state()?.genesis).toBe(a.store.state()?.genesis);
    expect(b.sync.maybeBootstrap()).toBe('not-needed');
  });

  it('with a peer down at the start, nobody bootstraps until it answers', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B'); b.up = false;
    await a.sync.tick();
    expect(a.store.hasRecord()).toBe(false);
    expect(b.store.hasRecord()).toBe(false);
    b.up = true; a.sync.heardFrom('m_B');
    await a.sync.tick();
    expect(b.store.state()?.genesis).toBe(a.store.state()?.genesis);
  });

});

describe('regression: the code second pass', () => {
  it('a machine-signed revocation never gets the lane', async () => {
    const a = node('m_A', { lease: true }); node('m_B');
    await a.sync.tick();
    const g = a.store.state()!.head[0];
    const mk = (i: number) => signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [g], body: { keyId: `m_X${i}` }, signer: { type: 'machine', keyId: 'm_A' } }, a.self.sign).entry;
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [mk(1)] }).ok).toBe(true);
    expect(a.sync.handlePush('m_B', { type: 'owner-record-push', entries: [mk(2)] })).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('reports each peer\'s head, and whether it matches', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B');
    await a.sync.tick(); await b.sync.tick(); await a.sync.tick();
    const peers = a.sync.status().peers as Array<{ machineId: string; head: string[]; sameHead: boolean }>;
    expect(peers[0]).toMatchObject({ machineId: 'm_B', sameHead: true });
    expect(peers[0].head).toEqual(a.store.state()!.head);
  });

  it('a change in the machine list re-arms the breaker', async () => {
    const a = node('m_A', { lease: true }); const b = node('m_B'); b.up = false;
    for (let h = 0; h < 30; h++) { clock += 60 * 60 * 1000; await a.sync.tick(); }
    expect(a.sync.status()).toMatchObject({ breakerOpen: true });
    nodes.delete('m_B');
    await a.sync.tick();
    expect(a.store.hasRecord()).toBe(true);
  });
});

describe('regression: the code second pass, round 2', () => {
  it('junk from one peer can neither fill the queue nor push a real revocation out of the lane', async () => {
    const a = node('m_A', { lease: true }); node('m_B'); node('m_C');
    await a.sync.tick();
    const head = a.store.state()!.head[0];
    const o = keypair(); const o2 = keypair();
    const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [head], body: { keyId: 'o_phone', publicKey: o.pub, label: 'phone', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const add2 = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [add.id], body: { keyId: 'o_two', publicKey: o2.pub, label: 'two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    a.store.ingest([add.entry, add2.entry]);
    const junk = Array.from({ length: 500 }, (_, i) => ({ v: 1, kind: 'policy', agentId: AGENT, parents: [add2.id], body: { path: `j${i}`, value: i }, signer: { type: 'owner-key', keyId: 'o_phone' }, sig: 'AAAA' }));
    a.sync.handlePush('m_B', { type: 'owner-record-push', entries: junk });
    clock += 11_000;
    a.sync.handlePush('m_B', { type: 'owner-record-push', entries: junk.map((j) => ({ ...j, body: { ...j.body, value: -1 } })) });
    const real = signOwnerRecordEntry({ kind: 'revoke-key', agentId: AGENT, parents: [add2.id], body: { keyId: 'o_two' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv)).entry;
    expect(a.sync.handlePush('m_C', { type: 'owner-record-push', entries: [real] }).ok).toBe(true);
    await a.sync.flush(true);
    expect(a.store.state()?.revoked).toContain('o_two');
  });
});
