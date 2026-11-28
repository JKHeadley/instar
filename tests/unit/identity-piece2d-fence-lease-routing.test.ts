import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MESH_VERB_FENCE_CLASS, fenceAllowsTo, fenceAllowsFrom, setMeshFencePolicy, meshFenceRefusesTo, meshFenceRefusesFrom,
  setBelowFencePredicate, isBelowFence,
} from '../../src/core/meshVerbFenceClass.js';
import { installMeshFencePolicy } from '../../src/core/ownerRecordWiring.js';
import { PeerBuildLedger, BELOW_FENCE_TAKEOVER_BUDGET } from '../../src/core/identityBuildFence.js';
import { OwnerRecordStore } from '../../src/core/ownerRecordStore.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MeshCommand } from '../../src/core/MeshRpc.js';
import type { OwnerRecordSync } from '../../src/core/ownerRecordSync.js';

let dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => { dirs = []; });
afterEach(() => {
  setMeshFencePolicy(null); setBelowFencePredicate(null);
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece2d-fence-lease-routing.test.ts:cleanup' });
});

describe('the verb table (§2b)', () => {
  it('has a row for every mesh verb the command union names (ratchet)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/MeshRpc.ts'), 'utf8');
    const block = src.slice(src.indexOf('export type MeshCommand ='), src.indexOf('\n\n', src.indexOf('export type MeshCommand =')));
    const literal = [...block.matchAll(/type: '([A-Za-z0-9-]+)'/g)].map((m) => m[1]);
    for (const t of [...literal, 'deliverMessage', 'telegram-origin', 'app-media-pull', 'owner-record-push', 'owner-record-pull']) {
      expect(MESH_VERB_FENCE_CLASS[t as MeshCommand['type']], `missing row for ${t}`).toBeDefined();
    }
    for (const row of Object.values(MESH_VERB_FENCE_CLASS)) expect(row.why.length).toBeGreaterThan(5);
  });

  it('by direction: nothing but liveness, read and conversation to a below machine; no authority from it', () => {
    expect(fenceAllowsTo('capacity-report')).toBe(true);
    expect(fenceAllowsTo('deliverMessage')).toBe(true);
    expect(fenceAllowsTo('place')).toBe(false);
    expect(fenceAllowsTo('secret-share')).toBe(false);
    expect(fenceAllowsFrom('deliverMessage')).toBe(true);
    expect(fenceAllowsFrom('place')).toBe(true);
    expect(fenceAllowsFrom('claim')).toBe(false);
    expect(fenceAllowsFrom('telegram-origin')).toBe(true); // conversation: the policy allows a submit only for a topic it owns
    expect(fenceAllowsFrom('commitment-mutate')).toBe(false);
  });
});

describe('the installed policy', () => {
  const sync = (below: string[]) => ({ isBelow: (m: string) => below.includes(m) }) as unknown as OwnerRecordSync;
  const deliver = (session: string, epoch: number) => ({ type: 'deliverMessage', session, messageId: 'x', payload: {}, ownershipEpoch: epoch }) as MeshCommand;

  it('refuses nothing to or from a machine that is not below', () => {
    installMeshFencePolicy(sync([]));
    expect(meshFenceRefusesTo('m_B', { type: 'place', session: 's', machine: 'm_B' } as MeshCommand)).toBeNull();
    expect(meshFenceRefusesFrom('m_B', { type: 'claim', session: 's', epoch: 1 } as MeshCommand)).toBeNull();
  });

  it('to a below machine: reads flow, new work and authority are refused, conversation only for a session it actively owns at that epoch', () => {
    installMeshFencePolicy(sync(['m_B']), (sk) => (sk === 'owned' ? { owner: 'm_B', epoch: 4, status: 'active' } : { owner: 'm_A', epoch: 1, status: 'active' }));
    expect(meshFenceRefusesTo('m_B', { type: 'session-status' } as MeshCommand)).toBeNull();
    expect(meshFenceRefusesTo('m_B', { type: 'place', session: 's', machine: 'm_B' } as MeshCommand)).toBe('below-minimum-build');
    expect(meshFenceRefusesTo('m_B', { type: 'secret-share', encrypted: 'x' } as MeshCommand)).toBe('below-minimum-build');
    expect(meshFenceRefusesTo('m_B', deliver('owned', 4))).toBeNull();
    expect(meshFenceRefusesTo('m_B', deliver('owned', 3))).toBe('below-minimum-build');
    expect(meshFenceRefusesTo('m_B', deliver('new-topic', 1))).toBe('below-minimum-build');
  });

  it('from a below machine: work is accepted, authority refused', () => {
    installMeshFencePolicy(sync(['m_B']));
    expect(meshFenceRefusesFrom('m_B', deliver('s', 1))).toBeNull();
    expect(meshFenceRefusesFrom('m_B', { type: 'claim', session: 's', epoch: 1 } as MeshCommand)).toBe('below-minimum-build');
  });

  it('the mesh client refuses before sending anything', async () => {
    installMeshFencePolicy(sync(['m_B']));
    let fetched = false;
    const client = new MeshRpcClient({ selfMachineId: 'm_A', sign: () => 'sig', nonce: () => 'n', now: () => 1, fetchFn: async () => { fetched = true; return { status: 200, json: async () => ({ ok: true }) }; } } as never);
    const r = await client.send({ machineId: 'm_B', url: 'http://b' }, { type: 'place', session: 's', machine: 'm_B' } as MeshCommand, 0);
    expect(r).toMatchObject({ ok: false, status: 409, reason: 'below-minimum-build' });
    expect(fetched).toBe(false);
  });

  it('the below-fence predicate is false until installed', () => {
    expect(isBelowFence('m_B')).toBe(false);
    setBelowFencePredicate((m) => m === 'm_B');
    expect(isBelowFence('m_B')).toBe(true);
    expect(isBelowFence(null)).toBe(false);
  });
});

describe('the lease (§2)', () => {
  it('canAcquire takes from a below holder through its own input, not the presumed-dead set', async () => {
    const { FencedLease } = await import('../../src/core/FencedLease.js');
    const fl = new FencedLease({ selfMachineId: 'm_A', sign: () => 'x', verify: () => true } as never, { leaseTtlMs: 60_000, failoverThresholdMs: 30_000 } as never);
    const lease = { holder: 'm_B', epoch: 5, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), signature: 's', nonce: 1 } as never;
    expect(fl.canAcquire(lease, new Set(), Date.now()).can).toBe(false);
    const d = fl.canAcquire(lease, new Set(), Date.now(), undefined, undefined, new Set(['m_B']));
    expect(d.can).toBe(true);
    expect(d.reason).toMatch(/holder-below-minimum-build/);
  });

  it('the takeover budget: three per below machine per day, then it settles', () => {
    let now = Date.parse('2026-11-18T12:00:00Z');
    const l = new PeerBuildLedger(path.join(tmp('budget-'), 'pb.json'), () => now);
    for (let i = 0; i < BELOW_FENCE_TAKEOVER_BUDGET; i++) { expect(l.takeoverAllowed('m_B')).toBe(true); l.noteTakeover('m_B'); }
    expect(l.takeoverAllowed('m_B')).toBe(false);
    expect(l.takeoverAllowed('m_C')).toBe(true);
    now += 24 * 60 * 60 * 1000 + 1;
    expect(l.takeoverAllowed('m_B')).toBe(true);
  });
});

describe('the agent-wide hold (§1)', () => {
  it('holds Sensitive and Serious while a machine is below or alive-but-unconfirmed, once enrolled', () => {
    const dir = tmp('hold-');
    const store = new OwnerRecordStore({ instarDir: dir, agentId: 'a', self: () => null, registeredKey: () => null });
    store.load();
    fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine', 'owner-record-enrolled.json'), JSON.stringify({ agentId: 'a', machineId: null, genesis: 'g', at: 'x' }));
    const base = { allAnswered: true, honouredPeerMarker: false };
    expect(store.gate({ ...base, machinesBelow: ['m_B'] })).toMatchObject({ act: 'hold', reason: 'machine-below-fence' });
    expect(store.gate({ ...base, machinesUnconfirmed: ['m_C'] })).toMatchObject({ act: 'hold', reason: 'machine-unconfirmed' });
    expect(store.gate(base)).toMatchObject({ act: 'hold', reason: 'record-missing' });
  });
});

describe('placement (§2b)', () => {
  it('never places on a machine below the fence', async () => {
    const { PlacementExecutor } = await import('../../src/core/PlacementExecutor.js');
    setBelowFencePredicate((m) => m === 'm_B');
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/PlacementExecutor.ts'), 'utf8');
    expect(src).toContain("!isBelowFence(m.machineId)");
    expect(typeof PlacementExecutor).toBe('function');
  });
});

describe('the sync lists the machines the hold is for (§0, §1)', () => {
  it('below: a signed statement under the fence; unconfirmed: alive with no statement for a day; asleep: neither', async () => {
    const { OwnerRecordSync } = await import('../../src/core/ownerRecordSync.js');
    const dir = tmp('held-');
    let now = Date.parse('2026-11-18T12:00:00Z');
    const ledger = PeerBuildLedger.at(dir, () => now);
    const store = { state: () => ({ status: 'ok', everEnrolled: true, level: 'phone', policies: { minimumBuild: '1.3.1900' } }), ids: () => [], hasRecord: () => true, enrolledMarker: () => ({ kind: 'absent' }) } as never;
    const sync = new OwnerRecordSync({ store, agentId: 'a', selfMachineId: () => 'm_A', peers: () => ['m_old', 'm_quiet', 'm_asleep', 'm_ok'], send: async () => ({ ok: false }), isLeaseHolder: () => false, splitBrain: () => false, degrade: () => {}, now: () => now, peerKey: (m) => `k-${m}`, ledger });
    ledger.record('m_old', 'k-m_old', '1.3.1800', [], now);
    ledger.record('m_ok', 'k-m_ok', '1.3.2000', [], now);
    now += 25 * 60 * 60 * 1000;
    ledger.record('m_ok', 'k-m_ok', '1.3.2000', [], now);
    sync.heardFrom('m_asleep'); // a reply only: never evidence it is alive
    sync.heardVerified('m_quiet');
    expect(sync.machinesHeld()).toEqual({ below: ['m_old'], unconfirmed: ['m_quiet'] });
    expect(sync.peerView()).toMatchObject({ machinesBelow: ['m_old'], machinesUnconfirmed: ['m_quiet'] });
  });
});

describe('regression: the code second pass', () => {
  it('one shared ledger per file, so a sync pull cannot erase the takeover count', async () => {
    const { resetPeerBuildLedgersForTests } = await import('../../src/core/identityBuildFence.js');
    const dir = tmp('shared-');
    const a = PeerBuildLedger.at(dir); const b = PeerBuildLedger.at(dir);
    expect(a).toBe(b);
    for (let i = 0; i < BELOW_FENCE_TAKEOVER_BUDGET; i++) a.noteTakeover('m_B');
    b.record('m_C', 'k', '1.3.2000', [], Date.now()); // a sync pull writes the same file
    expect(PeerBuildLedger.at(dir).takeoverAllowed('m_B')).toBe(false);
    resetPeerBuildLedgersForTests();
  });

  it("a below standby's reply submit posts only for a topic it actively owns", () => {
    installMeshFencePolicy({ isBelow: (m: string) => m === 'm_B' } as never, (sk) => (sk === '42' ? { owner: 'm_B', epoch: 3, status: 'active' } : { owner: 'm_A', epoch: 1, status: 'active' }));
    const submit = (topicId: string) => ({ type: 'telegram-origin', protocol: 'x', action: 'submit', operation: { record: { destination: { topicId } } } }) as unknown as MeshCommand;
    expect(meshFenceRefusesFrom('m_B', submit('42'))).toBeNull();
    expect(meshFenceRefusesFrom('m_B', submit('7'))).toBe('below-minimum-build');
    expect(meshFenceRefusesFrom('m_B', { type: 'telegram-origin', protocol: 'x', action: 'receipt', operationId: 'o' } as unknown as MeshCommand)).toBeNull();
    expect(meshFenceRefusesTo('m_B', { type: 'telegram-origin', protocol: 'x', action: 'capabilities' } as unknown as MeshCommand)).toBeNull();
  });
});
