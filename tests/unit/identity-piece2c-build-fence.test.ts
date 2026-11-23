import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PeerBuildLedger, fenceInForce, fenceStatus, belowFence, validateFenceWrite, keyFingerprint, BUILD_STATEMENT_FRESH_MS,
} from '../../src/core/identityBuildFence.js';
import { OwnerRecordStore, type OwnerRecordSelf } from '../../src/core/ownerRecordStore.js';
import { OwnerRecordSync, type OwnerRecordPullCmd, type OwnerRecordPushCmd } from '../../src/core/ownerRecordSync.js';
import { signOwnerRecordEntry, type OwnerRecordState } from '../../src/core/ownerRecord.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AGENT = 'agent-1';
let dirs: string[];
let clock: number;
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => { dirs = []; clock = Date.parse('2026-11-18T12:00:00Z'); });
afterEach(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece2c-build-fence.test.ts:cleanup' }); });

const state = (over: Partial<OwnerRecordState>): OwnerRecordState => ({
  status: 'ok', genesis: 'g', head: [], forked: false, keys: [], revoked: [], level: 'basic', policies: {}, tlsKeys: {},
  everEnrolled: false, agentProducible: true, held: [], rejected: [], effective: [], keep: [], signatures: {}, contested: [], ...over,
}) as OwnerRecordState;

describe('the build ledger (§2)', () => {
  it('four states: confirmed when fresh at the fence, below (sticky), unconfirmed when stale or unheard', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'peer-builds.json'), () => clock);
    expect(l.stateOf('m_B', 'k', '1.3.0')).toBe('unconfirmed');
    l.record('m_B', 'k', '1.3.5', [], clock);
    expect(l.stateOf('m_B', 'k', '1.3.0')).toBe('confirmed');
    expect(l.stateOf('m_B', 'k', '1.4.0')).toBe('below');
    clock += BUILD_STATEMENT_FRESH_MS + 1;
    expect(l.stateOf('m_B', 'k', '1.3.0')).toBe('unconfirmed');
    expect(l.stateOf('m_B', 'k', '1.4.0')).toBe('below'); // time never turns below into unknown
  });

  it('a pull with no build is below; an older statement never overwrites a newer one; a new key starts fresh', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'peer-builds.json'), () => clock);
    l.record('m_B', 'k', null, [], clock);
    expect(l.stateOf('m_B', 'k', '1.0.0')).toBe('below');
    l.record('m_B', 'k', '2.0.0', ['fence-lease'], clock + 10);
    l.record('m_B', 'k', '0.1.0', [], clock + 5); // delayed, older
    expect(l.stateOf('m_B', 'k', '1.0.0')).toBe('confirmed');
    expect(l.guardsOf('m_B', 'k')).toEqual(['fence-lease']);
    expect(l.stateOf('m_B', 'k2', '1.0.0')).toBe('unconfirmed');
  });

  it('survives a restart', () => {
    const f = path.join(tmp('led-'), 'peer-builds.json');
    new PeerBuildLedger(f, () => clock).record('m_B', 'k', '1.3.5', [], clock);
    expect(new PeerBuildLedger(f, () => clock).stateOf('m_B', 'k', '1.3.0')).toBe('confirmed');
  });
});

describe('the fence in force (§1)', () => {
  it('none at Basic or before enrolment', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    expect(fenceInForce(state({}), l).value).toBeNull();
    expect(fenceInForce(state({ everEnrolled: true, level: 'basic', policies: { minimumBuild: '1.0.0' } }), l).value).toBeNull();
    expect(fenceInForce(null, l).value).toBeNull();
  });

  it('the record value once enrolled above Basic, saved as the last verified fence', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    const f = fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), l);
    expect(f).toMatchObject({ value: '1.3.1900', source: 'record', unusable: false });
    expect(l.lastVerifiedFence()).toBe('1.3.1900');
  });

  it('a bad value keeps the last verified fence; with none, the fence is unusable (hold), never relaxed', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    expect(fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: 'banana' } }), l)).toMatchObject({ value: null, unusable: true });
    fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), l);
    expect(fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: 'banana' } }), l)).toMatchObject({ value: '1.3.1900', source: 'last-verified', unusable: false });
  });

  it('the owner lowering the level to Basic clears the saved fence; a lost record does not', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), l);
    fenceInForce(null, l);
    expect(l.lastVerifiedFence()).toBe('1.3.1900');
    fenceInForce(state({ everEnrolled: true, level: 'basic' }), l);
    expect(l.lastVerifiedFence()).toBeNull();
  });

  it('validates writes', () => {
    expect(validateFenceWrite('phone', '1.3.1900')).toEqual({ ok: true });
    expect(validateFenceWrite('phone', 'v-next')).toMatchObject({ ok: false });
  });
});

describe('readiness and refusal checks (§3, §4)', () => {
  it('ready only when every registered peer is confirmed at the target', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'), () => clock);
    l.record('m_B', 'kb', '1.3.1900', [], clock);
    const peers = [{ machineId: 'm_B', key: 'kb' }, { machineId: 'm_C', key: 'kc' }];
    expect(fenceStatus('1.3.1900', peers, l)).toMatchObject({ confirmed: ['m_B'], unconfirmed: ['m_C'], ready: false });
    l.record('m_C', 'kc', '1.3.1800', [], clock);
    expect(fenceStatus('1.3.1900', peers, l)).toMatchObject({ below: ['m_C'], ready: false });
    l.record('m_C', 'kc', '1.3.1901', [], clock + 1);
    expect(fenceStatus('1.3.1900', peers, l).ready).toBe(true);
  });

  it('belowFence: nothing before a fence; missing or older builds refused, naming the build needed', () => {
    expect(belowFence(undefined, null)).toEqual({ refused: false });
    expect(belowFence(undefined, '1.3.1900')).toEqual({ refused: true, needed: '1.3.1900' });
    expect(belowFence('1.3.1899', '1.3.1900')).toEqual({ refused: true, needed: '1.3.1900' });
    expect(belowFence('1.3.1900', '1.3.1900')).toEqual({ refused: false });
  });
});

// ── the sync applying the fence ────────────────────────────────────

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { pub: publicKey as string, priv: privateKey as string };
}
const signer = (priv: string) => (t: string) => crypto.sign(null, Buffer.from(t), priv).toString('base64');

describe('the sync applies the fence only after enrolment (§4)', () => {
  function setup(fenceValue: string | null) {
    const k = keypair();
    const self: OwnerRecordSelf = { machineId: 'm_A', publicKeyPem: k.pub, sign: signer(k.priv) };
    const dir = tmp('fence-sync-');
    const store = new OwnerRecordStore({ instarDir: dir, agentId: AGENT, self: () => self, registeredKey: (m) => (m === 'm_A' ? k.pub : null), verifyFirstOwnerProof: (b) => b.proof === 'route-ok', now: () => clock });
    store.load();
    const g = store.bootstrap();
    const notices: string[] = [];
    if (fenceValue) {
      const o = keypair();
      const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [g.id], body: { keyId: 'o_phone', publicKey: o.pub, label: 'p', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
      const lvl = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [add.id], body: { path: 'level', value: 'phone' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
      const mb = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [lvl.id], body: { path: 'minimumBuild', value: fenceValue }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
      store.ingest([add.entry, lvl.entry, mb.entry]);
    }
    const ledger = PeerBuildLedger.at(dir, () => clock);
    const sync = new OwnerRecordSync({
      store, agentId: AGENT, selfMachineId: () => 'm_A', peers: () => ['m_B', 'm_C'],
      send: async () => ({ ok: false }), isLeaseHolder: () => true, splitBrain: () => false, degrade: () => {},
      now: () => clock, selfBuild: () => '1.3.2000', selfGuards: () => [], peerKey: (m) => keyFingerprint(`key-${m}`), ledger,
      notify: (s) => notices.push(s),
    });
    return { store, sync, notices };
  }
  const pull = (build?: string): OwnerRecordPullCmd => ({ type: 'owner-record-pull', have: [], after: null, ...(build ? { build, guards: [] } : {}) });

  it('at Basic every peer gets the record, whatever its build', () => {
    const { sync } = setup(null);
    expect(sync.handlePull('m_B', pull('0.0.1'), clock).entries.length).toBeGreaterThan(0);
    expect(sync.handlePull('m_C', pull(), clock).entries.length).toBeGreaterThan(0);
  });

  it('after enrolment: a confirmed peer gets it in its first exchange; an older or silent one gets nothing', () => {
    const { sync } = setup('1.3.1900');
    const ok = sync.handlePull('m_B', pull('1.3.1950'), clock);
    expect(ok.refused).toBeUndefined();
    expect(ok.entries.length).toBeGreaterThan(0);
    const old = sync.handlePull('m_C', pull('1.3.1800'), clock);
    expect(old).toMatchObject({ refused: 'build-not-confirmed', entries: [] });
    expect(sync.handlePush('m_C', { type: 'owner-record-push', entries: [] } as OwnerRecordPushCmd)).toMatchObject({ ok: false, reason: 'build-not-confirmed' });
    const noBuild = sync.handlePull('m_C', pull(), clock + 1);
    expect(noBuild.refused).toBe('build-not-confirmed');
  });

  it('one aggregated notice from the lease holder, not repeated within a day', async () => {
    const { sync, notices } = setup('1.3.1900');
    sync.handlePull('m_B', pull('1.3.1800'), clock);
    await sync.tick();
    await sync.tick();
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/m_B/);
    expect(notices[0]).not.toMatch(/m_C/); // never heard from, but not yet watched for a day
    clock += 25 * 60 * 60 * 1000;
    await sync.tick();
    expect(notices.length).toBe(2);
    expect(notices[1]).toMatch(/m_C/);
  });

  it('reports the fence and each peer in status', () => {
    const { sync } = setup('1.3.1900');
    sync.handlePull('m_B', pull('1.3.1950'), clock);
    const f = (sync.status() as { fence: { inForce: string; peers: Array<{ machineId: string; state: string }> } }).fence;
    expect(f.inForce).toBe('1.3.1900');
    expect(f.peers).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'm_B', state: 'confirmed' }), expect.objectContaining({ machineId: 'm_C', state: 'unconfirmed' })]));
  });
});

describe('rollback below the fence is refused (§4)', () => {
  it('refuses with one plain message, and allows a rollback at or above the fence', async () => {
    const { UpdateChecker } = await import('../../src/core/UpdateChecker.js');
    const dir = tmp('fence-rb-');
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const ledger = PeerBuildLedger.at(dir);
    fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), ledger);
    fs.writeFileSync(path.join(dir, 'state', 'update-rollback.json'), JSON.stringify({ previousVersion: '1.3.1800', updatedVersion: '1.3.2000', updatedAt: new Date().toISOString() }));
    const checker = new UpdateChecker(dir);
    const r = await checker.rollback();
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/minimum build \(1\.3\.1900\)/);
  });
});

describe('regression: the code second pass', () => {
  it('a lost, failing or contested record never relaxes or lowers the saved fence', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), l);
    expect(fenceInForce(null, l).value).toBe('1.3.1900');
    expect(fenceInForce(state({ status: 'record-invalid' }), l).value).toBe('1.3.1900');
    expect(fenceInForce(state({ status: 'contested', everEnrolled: true, level: 'phone', policies: { minimumBuild: '0.0.1' } }), l).value).toBe('1.3.1900');
    expect(fenceInForce(state({ status: 'contested', everEnrolled: true, level: 'basic' }), l).value).toBe('1.3.1900');
    expect(l.lastVerifiedFence()).toBe('1.3.1900');
    expect(fenceInForce(state({ everEnrolled: false }), l).value).toBe('1.3.1900'); // a fresh Basic record after a lost enrolled one
  });

  it('readiness counts this machine too', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'), () => clock);
    l.record('m_B', 'kb', '1.3.2000', [], clock);
    expect(fenceStatus('1.3.1900', [{ machineId: 'm_B', key: 'kb' }], l, { machineId: 'm_A', build: '1.3.1800' })).toMatchObject({ below: ['m_A'], ready: false });
    expect(fenceStatus('1.3.1900', [{ machineId: 'm_B', key: 'kb' }], l, { machineId: 'm_A', build: '1.3.1950' }).ready).toBe(true);
  });

  it('a bad record value keeps the last fence and is reported', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), l);
    expect(fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: 'oops' } }), l)).toMatchObject({ value: '1.3.1900', badValue: 'oops' });
  });

  it('an explicit install below the fence is refused', async () => {
    const { UpdateChecker } = await import('../../src/core/UpdateChecker.js');
    const dir = tmp('fence-up-');
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), PeerBuildLedger.at(dir));
    const checker = new UpdateChecker(dir);
    const r = await (checker as unknown as { applySelectedUpdate: (i: unknown) => Promise<{ success: boolean; message: string }> }).applySelectedUpdate({ currentVersion: '1.3.2000', latestVersion: '1.3.1800', updateAvailable: true });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/minimum build/);
  });
});

describe('regression: the code second pass, round 2', () => {
  it('a parseable value below a newer build\'s floor stays in force (raise due); only an unparseable one is bad', () => {
    const l = new PeerBuildLedger(path.join(tmp('led-'), 'pb.json'));
    const f = fenceInForce(state({ everEnrolled: true, level: 'phone', policies: { minimumBuild: '0.0.1' } }), l);
    expect(f).toMatchObject({ value: '0.0.1', source: 'record', unusable: false, badValue: null });
  });

  it('an unusable fence stops sending the record but still accepts entries, so a fix can arrive', () => {
    const k = keypair();
    const self: OwnerRecordSelf = { machineId: 'm_A', publicKeyPem: k.pub, sign: signer(k.priv) };
    const dir = tmp('unusable-');
    const store = new OwnerRecordStore({ instarDir: dir, agentId: AGENT, self: () => self, registeredKey: (m) => (m === 'm_A' ? k.pub : null), verifyFirstOwnerProof: (b) => b.proof === 'route-ok', now: () => clock });
    store.load();
    const g = store.bootstrap();
    const o = keypair();
    const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [g.id], body: { keyId: 'o_phone', publicKey: o.pub, label: 'p', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const lvl = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [add.id], body: { path: 'level', value: 'phone' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const bad = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [lvl.id], body: { path: 'minimumBuild', value: 'oops' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    store.ingest([add.entry, lvl.entry, bad.entry]);
    const degraded: string[] = [];
    const sync = new OwnerRecordSync({ store, agentId: AGENT, selfMachineId: () => 'm_A', peers: () => ['m_B'], send: async () => ({ ok: false }), isLeaseHolder: () => true, splitBrain: () => false, degrade: (m) => degraded.push(m), now: () => clock, selfBuild: () => '1.3.2000', peerKey: (m) => `k-${m}`, ledger: PeerBuildLedger.at(dir, () => clock) });
    expect(sync.fence().unusable).toBe(true);
    expect(degraded.length).toBe(1);
    expect(sync.peerMayHaveRecord('m_B')).toBe(false);
    const fix = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [bad.id], body: { path: 'minimumBuild', value: '1.3.1900' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    expect(sync.handlePush('m_B', { type: 'owner-record-push', entries: [fix.entry] } as OwnerRecordPushCmd).ok).toBe(true);
  });

  it('a machine paired minutes ago is not reported as long-unconfirmed', async () => {
    const k = keypair();
    const self: OwnerRecordSelf = { machineId: 'm_A', publicKeyPem: k.pub, sign: signer(k.priv) };
    const dir = tmp('paired-');
    const store = new OwnerRecordStore({ instarDir: dir, agentId: AGENT, self: () => self, registeredKey: (m) => (m === 'm_A' ? k.pub : null), verifyFirstOwnerProof: (b) => b.proof === 'route-ok', now: () => clock });
    store.load();
    const g = store.bootstrap();
    const o = keypair();
    const add = signOwnerRecordEntry({ kind: 'add-owner-key', agentId: AGENT, parents: [g.id], body: { keyId: 'o_phone', publicKey: o.pub, label: 'p', proof: 'route-ok' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const lvl = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [add.id], body: { path: 'level', value: 'phone' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    const mb = signOwnerRecordEntry({ kind: 'policy', agentId: AGENT, parents: [lvl.id], body: { path: 'minimumBuild', value: '1.3.1900' }, signer: { type: 'owner-key', keyId: 'o_phone' } }, signer(o.priv));
    store.ingest([add.entry, lvl.entry, mb.entry]);
    const ledger = PeerBuildLedger.at(dir, () => clock);
    clock += 3 * 24 * 60 * 60 * 1000; // the ledger has watched for days
    const notices: string[] = [];
    const sync = new OwnerRecordSync({ store, agentId: AGENT, selfMachineId: () => 'm_A', peers: () => ['m_new'], send: async () => ({ ok: false }), isLeaseHolder: () => true, splitBrain: () => false, degrade: () => {}, now: () => clock, selfBuild: () => '1.3.2000', peerKey: (m) => `k-${m}`, ledger, notify: (n) => notices.push(n), peerSince: () => clock - 60_000 });
    await sync.tick();
    expect(notices).toEqual([]);
  });
});
