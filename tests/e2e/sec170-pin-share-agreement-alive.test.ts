/**
 * Tier-3 E2E "feature is alive" test for SEC-170 part 2 of 3 (docs/specs/pool-wide-pin-budget.md §4).
 *
 * Two real AgentServers with real machine identities, each running a PinShareProvider and a
 * PinBudgetPoller that pulls the other over signed HTTP (POST /api/pin-budget/state):
 *   - an unsigned call to the state route is refused;
 *   - each machine's poller verifies the other's signed report and both settle on one table, 10 each;
 *   - a hand-down to a machine that did not ask for one is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { signRequest } from '../../src/server/machineAuth.js';
import { PinShareProvider, registryMembership } from '../../src/core/PinShare.js';
import { PinBudgetPoller, stateSigningText } from '../../src/core/pinBudgetPoller.js';
import { GoneForGoodStore } from '../../src/core/PinGoneForGood.js';
import { PinOwnerSurface } from '../../src/core/PinOwnerSurface.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';

function env(name: string) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `sec170-agree-${name}-`));
  const mgr = new MachineIdentityManager(stateDir);
  const machineId = generateMachineId();
  const signingKeys = generateSigningKeyPair();
  const encryptionKeys = generateEncryptionKeyPair();
  const b64 = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const identity = { machineId, signingPublicKey: b64(signingKeys.publicKey), encryptionPublicKey: b64(encryptionKeys.publicKey), name, platform: `${os.platform()}-${os.arch()}`, createdAt: new Date().toISOString(), capabilities: ['sessions'] as string[] };
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), signingKeys.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(machineDir, 'encryption-private.pem'), encryptionKeys.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as never, 'awake');
  const config = { projectName: `sec170-${name}`, projectDir: stateDir, stateDir, port: 0, host: '127.0.0.1', authToken: `auth-${name}`, claudePath: 'claude', tmuxPath: 'tmux', scheduler: { enabled: false, timezone: 'UTC' }, messaging: [], monitoring: {}, requestTimeoutMs: 30000 } as unknown as InstarConfig;
  return { stateDir, mgr, identity, machineId, signingKeys, config };
}

type PartThreeHandles = { gone: GoneForGoodStore; surface: PinOwnerSurface };

describe('SEC-170 part 2 — PIN-share agreement over real signed HTTP', () => {
  let a: ReturnType<typeof env>;
  let b: ReturnType<typeof env>;
  let serverA: AgentServer;
  let serverB: AgentServer;
  let baseA = '';
  let baseB = '';
  let pollA: PinBudgetPoller;
  let pollB: PinBudgetPoller;
  let shareA: PinShareProvider;
  let shareB: PinShareProvider;
  let coordA: MultiMachineCoordinator;
  let coordB: MultiMachineCoordinator;
  let wiredA: PartThreeHandles;
  let wiredB: PartThreeHandles;

  const wire = (self: ReturnType<typeof env>, otherBase: () => string) => {
    let poller: PinBudgetPoller;
    const gone = new GoneForGoodStore(self.stateDir);
    const share: PinShareProvider = new PinShareProvider({
      stateDir: self.stateDir, enabled: () => true, membership: registryMembership(self.mgr),
      protocol: {
        reports: () => poller.reports(), pollReady: () => poller.pollReady(), goneForGood: () => gone.standing(poller.contacts().map),
        contacts: () => poller.contacts(), monoNow: () => performance.now(), sendHandDown: () => {},
      },
    });
    poller = new PinBudgetPoller({
      self: () => self.machineId,
      peers: () => Object.keys(self.mgr.loadRegistry().machines).filter((id) => id !== self.machineId),
      members: () => Object.keys(self.mgr.loadRegistry().machines),
      fetchState: async (_id, nonce) => {
        const body = { nonce };
        const r = await fetch(`${otherBase()}/api/pin-budget/state`, { method: 'POST', headers: { ...signRequest(self.machineId, self.signingKeys.privateKey, body), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`status-${r.status}`);
        return r.json();
      },
      verify: (id, text, sig) => { const pem = self.mgr.getSigningPublicKeyPem(id); return !!pem && verify(text, sig, pem); },
      onReport: (_id, r) => { if (r.goneForGood?.length) gone.adopt(r.goneForGood, self.machineId); },
    });
    const hooks = {
      pinBudgetState: (nonce: string, sender: string) => {
        poller.noteSeen(sender);
        const base = share.report();
        if (!base) return null;
        const report = { ...base, goneForGood: gone.reportable(), failuresLastHour: 3 };
        const contacts = Object.fromEntries(poller.contacts().map);
        return { report, contacts, sig: sign(stateSigningText(nonce, report, contacts), self.signingKeys.privateKey) };
      },
      pinBudgetHandDown: (gift: { transferId: string; amount: number; baseSeq: number }, sender: string) => share.receiveHandDown(sender, gift),
    };
    const surface = new PinOwnerSurface({
      stateDir: self.stateDir, store: gone, enabled: () => true, self: () => self.machineId,
      members: () => Object.keys(self.mgr.loadRegistry().machines).map((m) => ({ machineId: m, name: m, lastSeen: 0, pairedAt: 0 })),
      isRetired: () => false, contacts: () => poller.contacts().map, evidenceComplete: () => poller.contacts().complete,
      raiseWaiting: () => false, retire: () => { throw new Error('not in this test'); }, invalidate: () => share.invalidate(),
    });
    return { share, poller: () => poller, hooks, gone, surface };
  };

  beforeAll(async () => {
    a = env('a'); b = env('b');
    a.mgr.registerMachine(b.identity as never, 'standby'); a.mgr.storeRemoteIdentity(b.identity as never);
    b.mgr.registerMachine(a.identity as never, 'awake'); b.mgr.storeRemoteIdentity(a.identity as never);
    const wa = wire(a, () => baseB);
    const wb = wire(b, () => baseA);
    wiredA = wa; wiredB = wb;
    shareA = wa.share; shareB = wb.share;
    // Machine routes (/api/*) mount only with multi-machine coordination on, as in production.
    const stateA = new StateManager(a.stateDir); const stateB = new StateManager(b.stateDir);
    coordA = new MultiMachineCoordinator(stateA, { stateDir: a.stateDir }); coordA.start();
    coordB = new MultiMachineCoordinator(stateB, { stateDir: b.stateDir }); coordB.start();
    serverA = new AgentServer({ config: a.config, coordinator: coordA, sessionManager: new SessionManager({ stateDir: a.stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir: a.stateDir, port: 0 }), state: stateA, localSigningKeyPem: a.signingKeys.privateKey, pinShare: shareA, pinBudgetMachineHooks: wa.hooks } as never);
    serverB = new AgentServer({ config: b.config, coordinator: coordB, sessionManager: new SessionManager({ stateDir: b.stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir: b.stateDir, port: 0 }), state: stateB, localSigningKeyPem: b.signingKeys.privateKey, pinShare: shareB, pinBudgetMachineHooks: wb.hooks } as never);
    await serverA.start(); baseA = boundAgentServerBase(serverA);
    await serverB.start(); baseB = boundAgentServerBase(serverB);
    pollA = wa.poller(); pollB = wb.poller();
  }, 20000);

  afterAll(async () => {
    await serverA?.stop(); await serverB?.stop();
    coordA?.stop(); coordB?.stop();
    for (const d of [a?.stateDir, b?.stateDir]) if (d) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/sec170-pin-share-agreement-alive.test.ts' });
  }, 10000);

  it('an unsigned call to the state route is refused', async () => {
    const r = await fetch(`${baseA}/api/pin-budget/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: '0'.repeat(32) }) });
    expect(r.status).toBe(401);
  });

  it('both pollers verify each other\'s signed reports and both machines settle on one table, 10 each', async () => {
    // Round 1: each learns the other has no table yet (founding members); both decide.
    await pollA.round({ force: true }); await pollB.round({ force: true });
    shareA.invalidate(); shareB.invalidate();
    expect(shareA.share()).toBe(10);
    expect(shareB.share()).toBe(10);
    // Round 2: each sees the other's founding table.
    await pollA.round({ force: true }); await pollB.round({ force: true });
    expect(pollA.reports().get(b.machineId)).toMatchObject({ applied: 10 });
    expect(pollB.reports().get(a.machineId)).toMatchObject({ applied: 10 });
    expect(pollA.reports().get(b.machineId)!.table!.hash).toBe(pollB.reports().get(a.machineId)!.table!.hash);
    expect(pollA.contacts().complete).toBe(true);
  });

  it('part 3: a "gone for good" confirmation saved on one machine reaches the other in its signed report, with the hourly failure count', async () => {
    const lost = 'm_' + 'e'.repeat(32);
    // On a real server this is saved only by the owner's Face ID tap (unit-tested); here the store is written directly.
    wiredA.gone.confirm(lost, a.machineId);
    expect(Object.keys(wiredA.gone.read())).toEqual([lost]);
    await pollB.round({ force: true });
    expect(pollB.reports().get(a.machineId)).toMatchObject({ failuresLastHour: 3, goneForGood: [{ machineId: lost, approvedOn: a.machineId }] });
    expect(wiredB.gone.read()[lost]).toMatchObject({ source: 'relayed', approvedOn: a.machineId });
  });

  it('part 3: a live peer is not on the silent list, so neither choice can act on it', () => {
    const view = wiredA.surface.silent();
    expect(view.rows).toEqual([]);
    expect(view.evidenceComplete).toBe(true);
    expect(wiredA.surface.precheck(b.machineId, 'gone-for-good', view.fingerprint)?.body.error).toBe('not-silent');
    expect(wiredA.surface.precheck(b.machineId, 'retire', view.fingerprint)?.body.error).toBe('not-silent');
  });

  it('a hand-down to a machine that did not ask for one is refused', async () => {
    const body = { transferId: 'gift-1', amount: 3, baseSeq: 0 };
    const r = await fetch(`${baseB}/api/pin-budget/hand-down`, { method: 'POST', headers: { ...signRequest(a.machineId, a.signingKeys.privateKey, body), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ accepted: false });
    shareB.invalidate();
    expect(shareB.share()).toBe(10);
  });
});
