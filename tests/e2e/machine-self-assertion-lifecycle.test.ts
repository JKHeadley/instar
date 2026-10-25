/**
 * Tier 3 lifecycle: real AgentServer + real coordinator + destructive local
 * machine-directory loss rehearsal. Proves the feature is alive, not merely a
 * route factory that works when hand-wired.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { IdentityReannounceService, IssuedRefusalStore } from '../../src/core/IdentityReannounce.js';
import { IdentityStore } from '../../src/core/IdentityStore.js';
import { MachineIdentityManager, generateEncryptionKeyPair, generateSigningKeyPair, pemToBase64, sign } from '../../src/core/MachineIdentity.js';
import { MachineRecoveryKey, signingRotationMessage, type RecoverySecretStore, type RotationBinding } from '../../src/core/MachineRecoveryKey.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { runMachineIdentityBootRecovery } from '../../src/core/MachineIdentityBootRecovery.js';

class FakeKeychain implements RecoverySecretStore {
  readonly isKeychainBacked = true;
  private readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

describe('E2E machine self-assertion lifecycle', () => {
  let root: string;
  let stateDir: string;
  let server: AgentServer;
  let coordinator: MultiMachineCoordinator;
  let manager: MachineIdentityManager;
  let recoveredMachineId: string;
  let quarantineId: string;
  let quarantineClaimHash: string;
  const authToken = 'identity-e2e-auth';
  const recoveryBearerToken = 'a'.repeat(64);
  const pin = '642913';

  beforeAll(async () => {
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('0.0.0-test', null);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-self-assertion-e2e-'));
    stateDir = path.join(root, '.instar');
    manager = new MachineIdentityManager(stateDir);
    const original = await manager.generateIdentity({ name: 'recovery-fixture', role: 'awake' });
    recoveredMachineId = original.machineId;

    const keychain = new FakeKeychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(original.machineId, 0)!;
    recovery.rememberIdentity(manager.establishLocalRecoveryKey(material));
    const snapshot = recovery.recoverIdentitySnapshot();
    expect(snapshot?.machineId).toBe(original.machineId);

    // Destructive rehearsal against the temp universe: only the escrow outside
    // machine/** and the independent epoch store survive.
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'machine'), {
      recursive: true,
      force: true,
      operation: 'machine-self-assertion-lifecycle:delete-machine-dir',
    });
    const bootConfig = {
      projectName: 'identity-e2e', projectDir: root, stateDir,
      developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    expect(await runMachineIdentityBootRecovery({ config: bootConfig, manager, recoveryStore: keychain })).toBe('identity-recovered');
    const recovered = manager.loadIdentity();
    expect(recovered.machineId).toBe(original.machineId);
    expect(recovered.keyEpoch).toBe(1);

    const config = {
      projectName: 'identity-e2e', projectDir: root, stateDir, port: 0, host: '127.0.0.1',
      authToken, dashboardPin: pin, requestTimeoutMs: 10_000, version: '0.0.0-test',
      multiMachine: { identityReannounce: { enabled: true, dryRun: false, sharedBearerToken: recoveryBearerToken } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    const state = new StateManager(stateDir);
    coordinator = new MultiMachineCoordinator(state, { stateDir });
    coordinator.start();
    const identityStore = new IdentityStore({ stateDir });
    const issuedRefusals = new IssuedRefusalStore({ stateDir });
    const reannounce = new IdentityReannounceService({
      stateDir,
      identityStore,
      issuedRefusals,
      challengerMachineId: original.machineId,
      dryRun: () => false,
    });
    const peerSigning = generateSigningKeyPair();
    const peerEncryption = generateEncryptionKeyPair();
    const peer = {
      machineId: 'm-e2e-peer', signingPublicKey: pemToBase64(peerSigning.publicKey), encryptionPublicKey: pemToBase64(peerEncryption.publicKey),
      name: 'e2e-peer', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'], keyEpoch: 0, recoveryEpoch: 0,
    };
    manager.registerMachine(peer, 'standby');
    manager.storeRemoteIdentity(peer);
    const replacementSigning = generateSigningKeyPair();
    const replacementEncryption = generateEncryptionKeyPair();
    const proposed = {
      ...peer,
      signingPublicKey: pemToBase64(replacementSigning.publicKey),
      encryptionPublicKey: pemToBase64(replacementEncryption.publicKey),
      keyEpoch: 1,
    };
    const challenge = reannounce.issueChallenge(proposed, '100.64.0.20');
    const binding: RotationBinding = {
      nonce: challenge.nonce, claimantMachineId: peer.machineId,
      newSigningPublicKey: proposed.signingPublicKey, newEncryptionPublicKey: proposed.encryptionPublicKey,
      challengerMachineId: original.machineId, keyEpoch: 1, recoveryEpoch: 0,
    };
    const quarantined = reannounce.evaluate({
      challengeId: challenge.challengeId,
      possessionSignature: sign(signingRotationMessage(binding), replacementSigning.privateKey),
    }, {
      sourceVerifiedUnderIncumbent: false, recoveryAgreement: 'unverifiable', signingAgreement: 'consistent',
      governorAllowed: false, unackedAcceptedRotation: false,
    });
    if (quarantined.outcome !== 'quarantined') throw new Error('failed to create E2E quarantine fixture');
    quarantineId = quarantined.quarantine.id;
    quarantineClaimHash = quarantined.quarantine.claimHash;
    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, on: () => undefined } as never,
      state,
      coordinator,
      localSigningKeyPem: manager.loadSigningKey(),
    });
    server.setIdentityRecoveryRuntime({
      identityStore,
      identityReannounce: reannounce,
      identityRecoveryPrivateKeyAvailable: (machineId) => recovery.has(machineId),
      identityRecoveryEstablish: async () => ({ identity: manager.loadIdentity(), peers: { 'm-peer': 'already-current' } }),
      resolveIdentityReannounceContext: async () => ({
        sourceVerifiedUnderIncumbent: false,
        recoveryAgreement: 'consistent',
        signingAgreement: 'consistent',
        governorAllowed: true,
        unackedAcceptedRotation: false,
      }),
    });
    await server.start();
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    coordinator?.stop();
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'machine-self-assertion-lifecycle:cleanup' });
  });

  it('FEATURE IS ALIVE: recovery status is 200 and reports the surviving escrow + pending epoch', async () => {
    const res = await request(server.getApp()).get('/identity-recovery').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, machineId: recoveredMachineId, hasRecoveryPublicKey: true, recoveryPrivateKeyAvailable: true });
    expect(res.body.unacknowledgedRotations).toEqual([expect.objectContaining({ machineId: recoveredMachineId, keyEpoch: 1 })]);
  });

  it('FEATURE IS WIRED: the pre-bearer reannounce route is mounted and bound (400, never 404/503)', async () => {
    const res = await request(server.getApp())
      .post('/api/identity/reannounce/challenge')
      .set('Authorization', `Bearer ${recoveryBearerToken}`)
      .send({ machineIdentity: {} });
    expect(res.status).toBe(400);
  });

  it('a recent dashboard PIN unlock can acknowledge the exact epoch once', async () => {
    const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin });
    expect(unlock.status).toBe(200);
    const proof = unlock.body.operatorSessionToken as string;
    const route = `/identity-recovery/rotations/${recoveredMachineId}/1/ack`;
    await request(server.getApp()).post(route).set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof).send({}).expect(200);
    await request(server.getApp()).post(route).set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof).send({}).expect(409);
  });

  it('requires a recent dashboard PIN unlock even to inspect an already-established root action', async () => {
    await request(server.getApp()).post('/identity-recovery/establish')
      .set('Authorization', `Bearer ${authToken}`).send({}).expect(403);
    const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin });
    const response = await request(server.getApp()).post('/identity-recovery/establish')
      .set('Authorization', `Bearer ${authToken}`)
      .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken)
      .send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, machineId: recoveredMachineId, recoveryEpoch: 1, peers: { 'm-peer': 'already-current' } });
  });

  it('binds a single-use approval proof to the exact quarantine and claim hash', async () => {
    const base = `/identity-recovery/quarantines/${encodeURIComponent(quarantineId)}`;
    await request(server.getApp()).post(`${base}/approval-token`)
      .set('Authorization', `Bearer ${authToken}`).send({ claimHash: quarantineClaimHash }).expect(403);
    const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin });
    const proof = unlock.body.operatorSessionToken;
    await request(server.getApp()).post(`${base}/approval-token`)
      .set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof)
      .send({ claimHash: 'wrong-hash' }).expect(409);
    const minted = await request(server.getApp()).post(`${base}/approval-token`)
      .set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof)
      .send({ claimHash: quarantineClaimHash });
    expect(minted.status).toBe(200);
    await request(server.getApp()).post(`${base}/approve`)
      .set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof)
      .send({ claimHash: 'wrong-hash', approvalToken: minted.body.approvalToken }).expect(403);
    await request(server.getApp()).post(`${base}/deny`)
      .set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof)
      .send({ claimHash: quarantineClaimHash, approvalToken: minted.body.approvalToken }).expect(200);
    await request(server.getApp()).post(`${base}/approve`)
      .set('Authorization', `Bearer ${authToken}`).set('X-Instar-Operator-Session', proof)
      .send({ claimHash: quarantineClaimHash, approvalToken: minted.body.approvalToken }).expect(403);
  });
});
