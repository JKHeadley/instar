// safe-fs-allow: temporary fixture cleanup uses SafeFsExecutor.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { authMiddleware } from '../../src/server/middleware.js';
import { createJobFixedRegistryFetcher, mountJobFixedRegistryRoutes } from '../../src/server/jobFixedRegistryRoutes.js';
import { JobFixedRegistryAuthorityStore } from '../../src/scheduler/JobFixedRegistryAuthorityStore.js';
import { verifyFixedRegistrySnapshot } from '../../src/scheduler/JobFixedCertificateRegistry.js';
import { fixedCertificateBody, type FixedResultCertificate } from '../../src/scheduler/JobFixedResultCertificate.js';
import { signFixedRevocationProof } from '../../src/scheduler/JobFixedRegistryRevocation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('fixed registry authenticated HTTP read', () => {
  it('serves a fresh signed writer snapshot, denies unauthenticated reads and fails closed without writer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-http-'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const now = Date.parse('2026-11-02T04:00:00Z');
    const owner = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');
    const signer = {
      machineId: () => 'm_authority', signerKeyHash: () => 'key-hash',
      sign: payload => ({ machineId: 'm_authority', signerKeyHash: 'key-hash',
        sig: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') }),
    };
    const writer = new JobFixedRegistryAuthorityStore(dir, signer, 'm_authority',
      { owner: owner.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      { reviewer: reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    try {
      const app = express();
      app.use(express.json());
      app.use(authMiddleware(() => 'secret', 'test'));
      const keyLookup = (id: string, hash: string) => id === 'm_authority' && hash === 'key-hash'
        ? { status: 'ok' as const, publicKeyPem: pem } : { status: 'unknown' as const };
      mountJobFixedRegistryRoutes(app, { authority: () => writer, keyLookup,
        sourceAllowed: machineId => machineId === 'm_authority', now: () => now + 1000 });
      expect((await request(app).get('/jobs/fixed-registry')).status).toBe(401);
      const response = await request(app).get('/jobs/fixed-registry').set('Authorization', 'Bearer secret');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const verified = verifyFixedRegistrySnapshot(response.body, {
        pinnedAuthorityMachineId: 'm_authority', now: now + 1000, minimumEpoch: 0,
        keyLookup,
      });
      expect(verified?.authority.epoch).toBe(0);
      const fetcher = createJobFixedRegistryFetcher({ authorityMachineId: 'm_authority',
        resolvePeer: () => ({ machineId: 'm_authority', url: 'http://127.0.0.1:4042', kind: 'lan' }),
        authToken: 'secret', fetchPeer: async (_peer, route, init) => {
          expect(route).toBe('/jobs/fixed-registry');
          expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
          return new Response(JSON.stringify(response.body), { status: 200 });
        } });
      expect((await fetcher()).epoch).toBe(0);
      const cert: FixedResultCertificate = {
        id: 'health-ok-v1', version: 1, registryEpoch: 1, slug: 'health-check',
        templateDigest: 'script-v1', featureStateHash: 'features-v1', result: 'success',
        summary: 'healthy', reasonCode: 'ok', fields: {}, observedOutcomes: 300,
        gradableOutcomes: 300, confirmedMisses: 0, reviewedMissEpoch: 0, testEvidenceId: 'tests',
        shadowEvidenceId: 'shadow-300', canaryAssertionId: 'canary',
        canaryPassedAt: new Date(now - 1000).toISOString(), owner: 'owner', reviewer: 'reviewer',
        ownerSignature: '', reviewerSignature: '',
      };
      const body = fixedCertificateBody(cert);
      cert.ownerSignature = crypto.sign(null, Buffer.from(body), owner.privateKey).toString('base64');
      cert.reviewerSignature = crypto.sign(null, Buffer.from(body), reviewer.privateKey).toString('base64');
      expect((await request(app).post('/jobs/fixed-registry/issue')
        .set('Authorization', 'Bearer secret').send({ ...cert, reviewerSignature: 'invalid' })).status).toBe(403);
      expect((await request(app).post('/jobs/fixed-registry/issue')
        .set('Authorization', 'Bearer secret').send({ ...cert, observedOutcomes: '300' })).status).toBe(403);
      const issued = await request(app).post('/jobs/fixed-registry/issue')
        .set('Authorization', 'Bearer secret').send(cert);
      expect(issued.status).toBe(200);
      expect(issued.body).toMatchObject({ certificateId: cert.id, epoch: 1 });
      const renewed: FixedResultCertificate = { ...cert, id: 'health-ok-v2', registryEpoch: 2,
        canaryAssertionId: 'fresh-canary', canaryPassedAt: new Date(now).toISOString(),
        ownerSignature: '', reviewerSignature: '' };
      const renewalBody = fixedCertificateBody(renewed);
      renewed.ownerSignature = crypto.sign(null, Buffer.from(renewalBody), owner.privateKey).toString('base64');
      renewed.reviewerSignature = crypto.sign(null, Buffer.from(renewalBody), reviewer.privateKey).toString('base64');
      expect((await request(app).post('/jobs/fixed-registry/renew').set('Authorization', 'Bearer secret')
        .send({ priorCertificateId: cert.id, certificate: { ...renewed, reviewerSignature: 'bad' } })).status).toBe(403);
      const renewedResponse = await request(app).post('/jobs/fixed-registry/renew')
        .set('Authorization', 'Bearer secret').send({ priorCertificateId: cert.id, certificate: renewed });
      expect(renewedResponse.status).toBe(200);
      expect(renewedResponse.body).toMatchObject({ certificateId: renewed.id,
        retiredCertificateId: cert.id, epoch: 2 });
      const proof = signFixedRevocationProof({ version: 2, sourceMachineId: 'm_authority',
        attemptId: 'graded-attempt', certificateId: cert.id, evidenceId: 'independent-miss',
        gradedAt: new Date(now).toISOString(), signedAt: new Date(now + 1000).toISOString(),
        grade: 'incorrect', provider: 'fixed', verdict: 'routine' }, signer);
      const unpaired = express();
      unpaired.use(express.json());
      unpaired.use(authMiddleware(() => 'secret', 'test'));
      mountJobFixedRegistryRoutes(unpaired, { authority: () => writer, keyLookup,
        sourceAllowed: () => false, now: () => now + 1000 });
      expect((await request(unpaired).post('/jobs/fixed-registry/revoke')
        .set('Authorization', 'Bearer secret').send(proof)).status).toBe(403);
      expect((await request(app).post('/jobs/fixed-registry/revoke').set('Authorization', 'Bearer secret')
        .send({ ...proof, certificateId: 'tampered' })).status).toBe(403);
      const revoked = await request(app).post('/jobs/fixed-registry/revoke')
        .set('Authorization', 'Bearer secret').send(proof);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ certificateId: cert.id, epoch: 3 });
      const after = await request(app).get('/jobs/fixed-registry').set('Authorization', 'Bearer secret');
      expect(verifyFixedRegistrySnapshot(after.body, { pinnedAuthorityMachineId: 'm_authority',
        keyLookup, now: now + 1000, minimumEpoch: 1 })?.authority.revokedIds.has(renewed.id)).toBe(true);
      expect(Object.values(after.body.missEpochs)).toEqual([3]);
      const recovery: FixedResultCertificate = { ...renewed, id: 'health-ok-v3', registryEpoch: 4,
        reviewedMissEpoch: 0, ownerSignature: '', reviewerSignature: '' };
      const signRecovery = () => {
        const text = fixedCertificateBody(recovery);
        recovery.ownerSignature = crypto.sign(null, Buffer.from(text), owner.privateKey).toString('base64');
        recovery.reviewerSignature = crypto.sign(null, Buffer.from(text), reviewer.privateKey).toString('base64');
      };
      signRecovery();
      expect((await request(app).post('/jobs/fixed-registry/issue').set('Authorization', 'Bearer secret')
        .send(recovery)).status).toBe(403); // reviewers did not attest to the accepted miss
      recovery.reviewedMissEpoch = 3;
      signRecovery();
      expect((await request(app).post('/jobs/fixed-registry/issue').set('Authorization', 'Bearer secret')
        .send(recovery)).status).toBe(200);
      expect((await request(app).post('/jobs/fixed-registry/revoke').set('Authorization', 'Bearer secret')
        .send(proof)).body.epoch).toBe(4); // replay does not revoke reviewed recovery
      const secondMiss = signFixedRevocationProof({ version: 2, sourceMachineId: 'm_authority',
        attemptId: 'other-graded-attempt', certificateId: cert.id, evidenceId: 'other-independent-miss',
        gradedAt: new Date(now).toISOString(), signedAt: new Date(now + 1000).toISOString(),
        grade: 'incorrect', provider: 'fixed', verdict: 'routine' }, signer);
      expect((await request(app).post('/jobs/fixed-registry/revoke').set('Authorization', 'Bearer secret')
        .send(secondMiss)).body.epoch).toBe(5);
      const afterSecondMiss = await request(app).get('/jobs/fixed-registry').set('Authorization', 'Bearer secret');
      expect(afterSecondMiss.body.revokedIds).toContain(recovery.id);
      const dark = express();
      dark.use(authMiddleware(() => 'secret', 'test'));
      mountJobFixedRegistryRoutes(dark, { authority: () => null });
      expect((await request(dark).get('/jobs/fixed-registry').set('Authorization', 'Bearer secret')).status).toBe(503);
    } finally {
      writer.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-fixed-registry-routes.test.ts' });
    }
  });
});
