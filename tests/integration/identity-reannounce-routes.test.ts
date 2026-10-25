import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { IdentityReannounceService, IssuedRefusalStore } from '../../src/core/IdentityReannounce.js';
import { IdentityStore } from '../../src/core/IdentityStore.js';
import {
  MachineIdentityManager, generateEncryptionKeyPair, generateSigningKeyPair, pemToBase64, sign, verify, base64ToSigningPem,
} from '../../src/core/MachineIdentity.js';
import { MachineRecoveryKey, signingRotationMessage, type RecoverySecretStore, type RotationBinding } from '../../src/core/MachineRecoveryKey.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { createMachineRoutes, identityRecoveryBearerResponseMessage } from '../../src/server/machineRoutes.js';
import { signRequest } from '../../src/server/machineAuth.js';
import { decryptFromSync } from '../../src/core/SecretStore.js';
import {
  acceptMachineOperatorDelegation,
  MachineOperatorDelegationReplayStore,
  machineOperatorGrantMessage,
  recoveryRootDelegationHash,
  signingAckDelegationHash,
  type MachineOperatorAction,
  type MachineOperatorDelegation,
} from '../../src/core/MachineOperatorDelegation.js';
import { acceptIdentityPropagationReceipt } from '../../src/core/IdentityPropagationReceipt.js';
import { sendIdentityAckPropagation, sendIdentityRecoveryRootPropagation } from '../../src/core/IdentityPropagationTransport.js';

class FakeSecrets implements RecoverySecretStore {
  readonly isKeychainBacked = true;
  private readonly data = new Map<string, unknown>();
  get(key: string): unknown { return this.data.get(key); }
  set(key: string, value: unknown): void { this.data.set(key, value); }
  delete(key: string): void { this.data.delete(key); }
}

describe('identity re-announce HTTP lifecycle', () => {
  let root: string;
  let nonceStore: NonceStore;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-route-')); });
  afterEach(() => {
    nonceStore?.destroy();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'identity-reannounce-routes.test.ts' });
  });

  function setup(dryRun = false) {
    let now = Date.parse('2026-08-30T12:00:00Z');
    const identityManager = new MachineIdentityManager(root);
    const localSigning = generateSigningKeyPair();
    const peerSigning = generateSigningKeyPair();
    const peerEncryption = generateEncryptionKeyPair();
    const recovery = new MachineRecoveryKey(new FakeSecrets());
    const recoveryMaterial = recovery.ensure('m-peer')!;
    const local: MachineIdentity = {
      machineId: 'm-local', signingPublicKey: pemToBase64(localSigning.publicKey), encryptionPublicKey: 'local-enc',
      name: 'local', platform: 'test', createdAt: new Date(now).toISOString(), capabilities: ['sessions'], keyEpoch: 0,
    };
    const peer: MachineIdentity = {
      machineId: 'm-peer', signingPublicKey: pemToBase64(peerSigning.publicKey), encryptionPublicKey: pemToBase64(peerEncryption.publicKey),
      name: 'peer', platform: 'test', createdAt: new Date(now).toISOString(), capabilities: ['sessions'], keyEpoch: 0,
      recoveryPublicKey: recoveryMaterial.recoveryPublicKey, recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand',
    };
    fs.mkdirSync(path.join(root, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(root, 'machine', 'identity.json'), JSON.stringify(local));
    identityManager.registerMachine(local, 'awake');
    identityManager.registerMachine(peer, 'standby');
    identityManager.storeRemoteIdentity(peer);
    const store = new IdentityStore({ stateDir: root, now: () => now });
    const refusals = new IssuedRefusalStore({ stateDir: root, now: () => now });
    for (let i = 0; i < 10; i += 1) { refusals.recordSignatureInvalid(peer.machineId); now += 100_000; }
    const service = new IdentityReannounceService({
      stateDir: root, identityStore: store, issuedRefusals: refusals, challengerMachineId: local.machineId,
      now: () => now, dryRun: () => dryRun,
    });
    nonceStore = new NonceStore(path.join(root, 'nonces'));
    const securityLog = new SecurityLog(root);
    securityLog.initialize();
    const replayStore = new MachineOperatorDelegationReplayStore(root, () => now);
    const verifyGrant = (grant: unknown, action: MachineOperatorAction, fromMachineId: string, subjectMachineId: string, epoch: number, contentHash: string) => {
      const result = acceptMachineOperatorDelegation({
        grant,
        expected: { action, issuerMachineId: fromMachineId, recipientMachineId: local.machineId, subjectMachineId, epoch, contentHash },
        issuerRecoveryPublicKey: store.loadIdentity(fromMachineId, 'remote')?.recoveryPublicKey,
        replayStore: dryRun ? undefined : replayStore,
        now,
      });
      if (!result.ok) throw new Error(result.reason);
    };
    const routes = createMachineRoutes({
      identityManager,
      heartbeatManager: new HeartbeatManager(root, local.machineId),
      securityLog,
      authDeps: { identityManager, nonceStore, securityLog, localMachineId: local.machineId },
      localMachineId: local.machineId,
      localSigningKeyPem: localSigning.privateKey,
      identityReannounce: service,
      getIdentityRecoveryBearerToken: () => 'shared-token',
      establishPeerRecoveryRoot: (machineIdentity, fromMachineId, operatorDelegation) => {
        const current = store.loadIdentity(machineIdentity.machineId, 'remote');
        if (current?.recoveryPublicKey === machineIdentity.recoveryPublicKey
          && current.recoveryEpoch === machineIdentity.recoveryEpoch) return 'already-current';
        if (!current?.recoveryPublicKey) throw new Error('recovery-root-first-establishment-requires-pairing');
        verifyGrant(operatorDelegation, 'rotate-recovery-root', fromMachineId, machineIdentity.machineId,
          machineIdentity.recoveryEpoch ?? 0, recoveryRootDelegationHash(machineIdentity));
        if (dryRun) return 'would-rotate';
        store.apply({
          identity: machineIdentity,
          scope: 'remote',
          actor: 'operator',
          path: 'recovery-rotation',
          acceptedBy: fromMachineId,
          corroboration: ['pinned-recovery-root-grant'],
        });
        return 'rotated';
      },
      acknowledgePeerIdentityRotation: (machineId, keyEpoch, _fromMachineId, operatorDelegation) => {
        verifyGrant(operatorDelegation, 'acknowledge-signing-rotation', _fromMachineId, machineId,
          keyEpoch, signingAckDelegationHash(machineId, keyEpoch));
        if (dryRun) return 'would-acknowledge';
        if (store.acknowledge(machineId, keyEpoch)) return 'acknowledged';
        return store.acknowledgementStatus(machineId, keyEpoch) === 'acknowledged' ? 'already-acknowledged' : 'unknown';
      },
      resolveIdentityReannounceContext: () => ({
        sourceVerifiedUnderIncumbent: false,
        recoveryAgreement: 'consistent',
        signingAgreement: 'consistent',
        governorAllowed: true,
        unackedAcceptedRotation: false,
      }),
    });
    const app = express();
    app.use(express.json());
    app.use(routes);
    const mintGrant = (action: MachineOperatorAction, subjectMachineId: string, epoch: number, contentHash: string): MachineOperatorDelegation => {
      const unsigned = {
        version: 1 as const, action, issuerMachineId: peer.machineId, recipientMachineId: local.machineId,
        subjectMachineId, epoch, contentHash, nonce: crypto.randomBytes(32).toString('hex'),
        issuedAt: now, expiresAt: now + 60_000,
      };
      return { ...unsigned, signature: recovery.signOperatorGrant(peer.machineId, peer.recoveryPublicKey!, unsigned)! };
    };
    return { app, store, service, identityManager, local, localSigning, peer, recovery, peerSigning, peerEncryption, now: () => now, mintGrant };
  }

  it('requires bearer auth and accepts a challenge-bound recovery-continuity claim', async () => {
    const f = setup(false);
    const replacement = generateSigningKeyPair();
    const replacementEncryption = generateEncryptionKeyPair();
    const proposed: MachineIdentity = {
      ...f.peer,
      signingPublicKey: pemToBase64(replacement.publicKey),
      encryptionPublicKey: pemToBase64(replacementEncryption.publicKey),
      keyEpoch: 1,
    };
    expect((await request(f.app).post('/api/identity/reannounce/challenge').send({ machineIdentity: proposed })).status).toBe(401);
    const challenged = await request(f.app).post('/api/identity/reannounce/challenge')
      .set('Authorization', 'Bearer shared-token').send({ machineIdentity: proposed });
    expect(challenged.status).toBe(200);
    const binding: RotationBinding = {
      nonce: challenged.body.nonce,
      claimantMachineId: proposed.machineId,
      newSigningPublicKey: proposed.signingPublicKey,
      newEncryptionPublicKey: proposed.encryptionPublicKey,
      challengerMachineId: 'm-local',
      keyEpoch: 1,
      recoveryEpoch: 1,
      newRecoveryPublicKey: proposed.recoveryPublicKey,
    };
    const claimed = await request(f.app).post('/api/identity/reannounce/claim')
      .set('Authorization', 'Bearer shared-token').send({ claim: {
        challengeId: challenged.body.challengeId,
        possessionSignature: sign(signingRotationMessage(binding), replacement.privateKey),
        continuitySignature: f.recovery.signContinuity('m-peer', binding),
      } });
    expect(claimed.status).toBe(200);
    expect(claimed.body.outcome).toBe('accepted');
    expect(f.store.loadIdentity('m-peer', 'remote')).toMatchObject({ keyEpoch: 1, signingPublicKey: proposed.signingPublicKey });
    expect(f.store.listUnacknowledged()).toEqual([expect.objectContaining({ machineId: 'm-peer', keyEpoch: 1 })]);
    const ackNonce = 'f'.repeat(64);
    const ackBody = {
      machineId: 'm-peer', keyEpoch: 1, requestNonce: ackNonce,
      operatorDelegation: f.mintGrant('acknowledge-signing-rotation', 'm-peer', 1, signingAckDelegationHash('m-peer', 1)),
    };
    const ack = await request(f.app).post('/api/identity/reannounce/ack')
      .set(signRequest('m-peer', replacement.privateKey, ackBody)).send(ackBody);
    expect(ack.status).toBe(200);
    expect(acceptIdentityPropagationReceipt({
      receipt: ack.body,
      expected: {
        action: 'signing-ack', responderMachineId: 'm-local', requesterMachineId: 'm-peer',
        requestNonce: ackNonce, subjectMachineId: 'm-peer', epoch: 1,
        contentHash: signingAckDelegationHash('m-peer', 1),
      },
      allowedStatuses: ['acknowledged', 'already-acknowledged'],
      responderSigningPublicKeyPem: f.localSigning.publicKey,
    })).toBe('acknowledged');
    expect(f.store.listUnacknowledged()).toEqual([]);
    const retryNonce = 'e'.repeat(64);
    const retryBody = { ...ackBody, requestNonce: retryNonce };
    const retried = await request(f.app).post('/api/identity/reannounce/ack')
      .set(signRequest('m-peer', replacement.privateKey, retryBody)).send(retryBody).expect(200);
    expect(retried.body.status).toBe('already-acknowledged');
  });

  it('serves the current promoted projection only to the pairing-established recovery bearer', async () => {
    const f = setup(false);
    expect((await request(f.app).get('/api/identity/projection/by-machine/m-peer')).status).toBe(401);
    expect((await request(f.app).get('/api/identity/projection/by-machine/m-peer').set('Authorization', 'Bearer ordinary-local-api-token')).status).toBe(401);
    const nonce = 'b'.repeat(64);
    const response = await request(f.app).get(`/api/identity/projection/by-machine/m-peer?nonce=${nonce}`)
      .set('Authorization', 'Bearer shared-token');
    expect(response.status).toBe(200);
    expect(response.body.projection).toMatchObject({
      machineId: 'm-peer', keyEpoch: 0, recoveryEpoch: 1, registryStatus: 'active',
    });
    expect(response.body.projection.signingFingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(response.body).toMatchObject({ responderMachineId: 'm-local', nonce });
    expect(verify(
      `instar-identity-projection-v1|${nonce}|m-local|${JSON.stringify(response.body.projection)}`,
      response.body.signature,
      base64ToSigningPem(f.local.signingPublicKey),
    )).toBe(true);

    await request(f.app).get('/api/identity/projections')
      .set('Authorization', 'Bearer shared-token').expect(400);
    const bulkNonce = 'd'.repeat(64);
    const bulk = await request(f.app).get(`/api/identity/projections?nonce=${bulkNonce}`)
      .set('Authorization', 'Bearer shared-token').expect(200);
    expect(bulk.body).toMatchObject({ responderMachineId: 'm-local', nonce: bulkNonce });
    expect(verify(
      `instar-identity-projections-v1|${bulkNonce}|m-local|${JSON.stringify(bulk.body.projections)}`,
      bulk.body.signature,
      base64ToSigningPem(f.local.signingPublicKey),
    )).toBe(true);
  });

  it('bootstraps the shared recovery bearer to an incumbent-authenticated peer encrypted to that peer', async () => {
    const f = setup(false);
    const body = { requestNonce: 'c'.repeat(64) };
    const response = await request(f.app).post('/api/identity/recovery-channel/pull')
      .set(signRequest('m-peer', f.peerSigning.privateKey, body))
      .send(body);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('shared-token');
    expect(response.body).toMatchObject({
      responderMachineId: 'm-local', recipientMachineId: 'm-peer', requestNonce: body.requestNonce,
    });
    expect(verify(identityRecoveryBearerResponseMessage({
      responderMachineId: response.body.responderMachineId,
      recipientMachineId: response.body.recipientMachineId,
      requestNonce: response.body.requestNonce,
      tokenHash: response.body.tokenHash,
      encrypted: response.body.encrypted,
    }), response.body.signature, base64ToSigningPem(f.local.signingPublicKey))).toBe(true);
    const decrypted = decryptFromSync(
      JSON.parse(response.body.encrypted),
      crypto.createPrivateKey(f.peerEncryption.privateKey),
    );
    expect(decrypted).toEqual({ identityRecoveryBearerToken: 'shared-token' });
  });

  it('refuses first recovery-root establishment over machine auth and requires a scoped operator grant for rotation', async () => {
    const f = setup(false);
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const legacy: MachineIdentity = {
      machineId: 'm-legacy', signingPublicKey: pemToBase64(signing.publicKey), encryptionPublicKey: pemToBase64(encryption.publicKey),
      name: 'legacy', platform: 'test', createdAt: '2026-08-30T00:00:00Z', capabilities: ['sessions'], keyEpoch: 0, recoveryEpoch: 0,
    };
    f.identityManager.registerMachine(legacy, 'standby');
    f.identityManager.storeRemoteIdentity(legacy);
    const material = new MachineRecoveryKey(new FakeSecrets()).ensure(legacy.machineId)!;
    const established = { ...legacy, recoveryPublicKey: material.recoveryPublicKey, recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand' as const };
    const body = { machineIdentity: established, operatorDelegation: {}, requestNonce: '1'.repeat(64) };

    await request(f.app).post('/api/identity/recovery-root/establish').send(body).expect(401);
    const response = await request(f.app).post('/api/identity/recovery-root/establish')
      .set(signRequest(legacy.machineId, signing.privateKey, body)).send(body);
    expect(response.status).toBe(403);
    expect(f.store.loadIdentity(legacy.machineId, 'remote')?.recoveryPublicKey).toBeUndefined();
    const rotatedRoot = pemToBase64(generateSigningKeyPair().publicKey);
    const rotatedIdentity = { ...f.peer, recoveryPublicKey: rotatedRoot, recoveryEpoch: 2 };
    const requestNonce = '2'.repeat(64);
    const rotateBody = {
      machineIdentity: rotatedIdentity, requestNonce,
      operatorDelegation: f.mintGrant('rotate-recovery-root', f.peer.machineId, 2, recoveryRootDelegationHash(rotatedIdentity)),
    };
    const rotated = await request(f.app).post('/api/identity/recovery-root/establish')
      .set(signRequest(f.peer.machineId, f.peerSigning.privateKey, rotateBody)).send(rotateBody).expect(200);
    expect(acceptIdentityPropagationReceipt({
      receipt: rotated.body,
      expected: {
        action: 'recovery-root', responderMachineId: 'm-local', requesterMachineId: 'm-peer',
        requestNonce, subjectMachineId: 'm-peer', epoch: 2,
        contentHash: recoveryRootDelegationHash(rotatedIdentity),
      },
      allowedStatuses: ['rotated', 'already-current'],
      responderSigningPublicKeyPem: f.localSigning.publicKey,
    })).toBe('rotated');
    expect(f.store.loadIdentity(f.peer.machineId, 'remote')).toMatchObject({ recoveryPublicKey: rotatedRoot, recoveryEpoch: 2 });
    const retryBody = { ...rotateBody, requestNonce: '3'.repeat(64) };
    const retry = await request(f.app).post('/api/identity/recovery-root/establish')
      .set(signRequest(f.peer.machineId, f.peerSigning.privateKey, retryBody)).send(retryBody).expect(200);
    expect(retry.body.status).toBe('already-current');
  });

  it('signs dry-run verdicts but they are not acceptable as committed receipts', async () => {
    const f = setup(true);
    const rotatedIdentity = { ...f.peer, recoveryPublicKey: pemToBase64(generateSigningKeyPair().publicKey), recoveryEpoch: 2 };
    const requestNonce = '4'.repeat(64);
    const body = {
      machineIdentity: rotatedIdentity, requestNonce,
      operatorDelegation: f.mintGrant('rotate-recovery-root', f.peer.machineId, 2, recoveryRootDelegationHash(rotatedIdentity)),
    };
    const response = await request(f.app).post('/api/identity/recovery-root/establish')
      .set(signRequest(f.peer.machineId, f.peerSigning.privateKey, body)).send(body).expect(200);
    expect(response.body.status).toBe('would-rotate');
    expect(acceptIdentityPropagationReceipt({
      receipt: response.body,
      expected: {
        action: 'recovery-root', responderMachineId: 'm-local', requesterMachineId: 'm-peer',
        requestNonce, subjectMachineId: 'm-peer', epoch: 2,
        contentHash: recoveryRootDelegationHash(rotatedIdentity),
      },
      allowedStatuses: ['rotated', 'already-current'],
      responderSigningPublicKeyPem: f.localSigning.publicKey,
    })).toBeNull();
    expect(f.store.loadIdentity(f.peer.machineId, 'remote')?.recoveryEpoch).toBe(1);
  });

  it('production transport completes only from a fresh receiver-signed committed receipt', async () => {
    const f = setup(false);
    const listener = await new Promise<import('node:http').Server>((resolve) => {
      const server = f.app.listen(0, '127.0.0.1', () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('listener address unavailable');
      const peerUrl = `http://127.0.0.1:${address.port}`;
      const proposed = { ...f.peer, recoveryPublicKey: pemToBase64(generateSigningKeyPair().publicKey), recoveryEpoch: 2 };
      const operatorDelegation = f.mintGrant('rotate-recovery-root', f.peer.machineId, 2, recoveryRootDelegationHash(proposed));
      const common = {
        peerUrl, peerMachineId: f.local.machineId, selfMachineId: f.peer.machineId,
        selfSigningPrivateKeyPem: f.peerSigning.privateKey,
        peerSigningPublicKeyPem: f.localSigning.publicKey,
        machineIdentity: proposed, operatorDelegation,
      };
      expect(await sendIdentityRecoveryRootPropagation(common)).toBe('rotated');
      // Simulates a lost first response: the retry receives a fresh signed
      // already-current receipt and completes idempotently.
      expect(await sendIdentityRecoveryRootPropagation(common)).toBe('already-current');
      expect(await sendIdentityRecoveryRootPropagation({
        ...common,
        fetchImpl: async () => new Response(JSON.stringify({ status: 'rotated' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      })).toBe('pending');
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('production transport leaves a live queue pending against a dry-run receiver', async () => {
    const f = setup(true);
    const listener = await new Promise<import('node:http').Server>((resolve) => {
      const server = f.app.listen(0, '127.0.0.1', () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('listener address unavailable');
      const proposed = { ...f.peer, recoveryPublicKey: pemToBase64(generateSigningKeyPair().publicKey), recoveryEpoch: 2 };
      expect(await sendIdentityRecoveryRootPropagation({
        peerUrl: `http://127.0.0.1:${address.port}`,
        peerMachineId: f.local.machineId, selfMachineId: f.peer.machineId,
        selfSigningPrivateKeyPem: f.peerSigning.privateKey,
        peerSigningPublicKeyPem: f.localSigning.publicKey,
        machineIdentity: proposed,
        operatorDelegation: f.mintGrant('rotate-recovery-root', f.peer.machineId, 2, recoveryRootDelegationHash(proposed)),
      })).toBe('pending');
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('ACK production transport requires a receiver-signed committed receipt and retries idempotently', async () => {
    const f = setup(false);
    const replacement = generateSigningKeyPair();
    f.store.apply({
      identity: { ...f.peer, signingPublicKey: pemToBase64(replacement.publicKey), keyEpoch: 1 },
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation', acceptedBy: f.local.machineId,
    });
    const listener = await new Promise<import('node:http').Server>((resolve) => {
      const server = f.app.listen(0, '127.0.0.1', () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('listener address unavailable');
      const common = {
        peerUrl: `http://127.0.0.1:${address.port}`,
        peerMachineId: f.local.machineId, selfMachineId: f.peer.machineId,
        selfSigningPrivateKeyPem: replacement.privateKey,
        peerSigningPublicKeyPem: f.localSigning.publicKey,
        machineId: f.peer.machineId, keyEpoch: 1,
        operatorDelegation: f.mintGrant('acknowledge-signing-rotation', f.peer.machineId, 1,
          signingAckDelegationHash(f.peer.machineId, 1)),
      };
      expect(await sendIdentityAckPropagation(common)).toBe('acknowledged');
      expect(await sendIdentityAckPropagation(common)).toBe('already-acknowledged');
      expect(await sendIdentityAckPropagation({
        ...common,
        fetchImpl: async () => new Response(JSON.stringify({ status: 'acknowledged' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      })).toBe('pending');
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('ACK production transport refuses a signed dry-run receipt', async () => {
    const f = setup(true);
    const listener = await new Promise<import('node:http').Server>((resolve) => {
      const server = f.app.listen(0, '127.0.0.1', () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('listener address unavailable');
      expect(await sendIdentityAckPropagation({
        peerUrl: `http://127.0.0.1:${address.port}`,
        peerMachineId: f.local.machineId, selfMachineId: f.peer.machineId,
        selfSigningPrivateKeyPem: f.peerSigning.privateKey,
        peerSigningPublicKeyPem: f.localSigning.publicKey,
        machineId: f.peer.machineId, keyEpoch: 0,
        operatorDelegation: f.mintGrant('acknowledge-signing-rotation', f.peer.machineId, 0,
          signingAckDelegationHash(f.peer.machineId, 0)),
      })).toBe('pending');
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
    }
  });
});
