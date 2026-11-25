import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager, sign } from '../../src/core/MachineIdentity.js';
import { deviceKeyHashOf, identityKeyLookup, loadMachineSigner, signerKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MobilePairingService, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createSignedLocalHistoryIntake, LOCAL_HISTORY_CONSENT_CHALLENGE_PATH, LOCAL_HISTORY_CONSENT_CONFIRM_PATH,
  LOCAL_HISTORY_CONSENT_PREVIEW_PATH, SIGNED_LOCAL_HISTORY_PREFIX, type SignedLocalHistoryIntakeService }
  from '../../src/server/signedLocalHistoryIntake.js';
import { LocalHistoryChannel } from '../../src/import/LocalHistoryChannel.js';
import { LocalHistoryChannelRegistry } from '../../src/import/LocalHistoryChannelRegistry.js';
import { finishLocalHistoryHandshake } from '../../src/import/LocalHistoryHandshake.js';
import { createLocalHistoryConsentPreview } from '../../src/server/localHistoryConsentPreview.js';
import { createLocalHistoryCaptureResolver, localHistoryCaptureProofMessage, type LocalHistoryCaptureProof }
  from '../../src/server/localHistoryConsentSourceProof.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { localHistoryConsentCardRevision, LocalHistoryConsentChallenges } from '../../src/server/localHistoryConsentSlip.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const host = 'synthetic-history.example.test';
const applyPath = SIGNED_LOCAL_HISTORY_PREFIX + '/apply';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-history-intake-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'signed history fixture' }));
  const identity = new MachineIdentityManager(stateDir);
  await identity.generateIdentity({ name: 'Synthetic intake machine' });
  const owner = { id: 'synthetic-owner', name: 'Synthetic Owner', permissions: ['owner'], channels: [], preferences: {} };
  fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([owner]));
  const config = { projectName: 'synthetic-intake', stateDir, authToken: 'test-bearer', developmentAgent: true,
    mobilePairing: { enabled: true, native: { enabled: true }, multiRoute: { enabled: false } }, users: [owner] } as never;
  const pairing = new MobilePairingService({ config, stateDir, holdsLease: () => true } as MobilePairingDeps);
  pairing.nativeOn = true;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir, signer: loadMachineSigner(stateDir)!, keyLookup: identityKeyLookup(stateDir) });
  cleanups.push(() => pairing.stop());
  const phone = makeDevice();
  const enrolled = pairing.devices.createPending({ publicKey: phone.publicKey, host, userId: owner.id,
    role: 'owner', deviceName: 'Synthetic owner phone', label: null });
  if (!enrolled.ok) throw new Error('synthetic enrollment refused');
  pairing.devices.applyConfirm(enrolled.device.id, { ok: true });
  pairing.keyLedger.reconcile(pairing.devices);
  const app = express();
  let selected: SignedLocalHistoryIntakeService | undefined;
  let consentPreview: SignedLocalHistoryIntakeService | undefined;
  app.use(createSignedLocalHistoryIntake({ pairing, service: () => selected, consent: () => consentPreview, wireBytes: 8192 }));
  app.get('/unrelated', (_req, res) => res.status(204).end());
  let lastTime = 0;
  const send = (body: Buffer, signedBytes = body, url = applyPath, contentType = 'application/octet-stream') => {
    const time = String(lastTime = Math.max(lastTime + 1, Date.now()));
    return request(app).post(url).set('Host', host).set('Content-Type', contentType).set('X-Instar-Device', enrolled.device.id)
      .set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', phone.sign(canonicalString(enrolled.device.id, host, 'POST', url, time, signedBytes)))
      .send(body);
  };
  return { app, send, select(service: SignedLocalHistoryIntakeService) { selected = service; },
    selectConsent(service: SignedLocalHistoryIntakeService) { consentPreview = service; },
    deviceId: enrolled.device.id, identity, signer: loadMachineSigner(stateDir)!, phone };
}

it('is dark with no service and authenticates the exact signed bytes before dispatch', async () => {
  const f = await fixture();
  const bytes = crypto.randomBytes(32);
  expect((await f.send(bytes)).status).toBe(503);
  let dispatches = 0;
  f.select({ async withExchange(work) { await work(); return true; }, dispatch(input) {
    dispatches++;
    expect(input.pathname).toBe(applyPath);
    expect(input.body.equals(bytes)).toBe(true);
    expect(input.device).toMatchObject({ deviceId: f.deviceId, ownerUserId: 'synthetic-owner' });
    return { status: 202, type: 'application/octet-stream', body: Buffer.from('synthetic receipt') };
  } });
  expect((await request(f.app).post(applyPath).set('Authorization', 'Bearer test-bearer')
    .set('Content-Type', 'application/octet-stream').send(bytes)).status).toBe(403);
  expect((await f.send(bytes, crypto.randomBytes(32))).status).toBe(401);
  expect((await f.send(bytes, bytes, applyPath.toUpperCase())).status).toBe(404);
  expect((await f.send(bytes, bytes, applyPath, 'text/plain')).status).toBe(400);
  expect((await f.send(Buffer.alloc(8193))).status).toBe(400);
  const reply = await f.send(bytes);
  expect(reply.status).toBe(202);
  expect(reply.body).toEqual(Buffer.from('synthetic receipt'));
  expect(dispatches).toBe(1);
  expect((await request(f.app).get('/unrelated')).status).toBe(204);
});

it('keeps one exchange until an abandoned signed dispatch settles and clears borrowed bytes', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>(), cleanupRelease = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined, borrowed: Buffer | undefined;
  f.select({ async withExchange(work) { await work(); return true; }, async dispatch(input) {
    signal = input.signal; borrowed = input.body;
    input.onDispose(async () => { cleanupEntered.resolve(); await cleanupRelease.promise; });
    entered.resolve();
    await release.promise;
    return { status: 200, type: 'application/octet-stream', body: Buffer.from('synthetic receipt') };
  } });
  const bytes = crypto.randomBytes(32);
  const sent = f.send(bytes);
  void sent.then(() => {}, () => {});
  try {
    await entered.promise;
    const closed = new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    sent.abort();
    await closed;
    expect((await f.send(bytes)).status).toBe(429);
    expect(borrowed?.equals(bytes)).toBe(true);
    release.resolve();
    await cleanupEntered.promise;
    expect((await f.send(bytes)).status).toBe(429);
  } finally {
    release.resolve(); cleanupRelease.resolve();
  }
  await new Promise(resolve => setImmediate(resolve));
  expect(borrowed?.equals(Buffer.alloc(bytes.length))).toBe(true);
  expect((await f.send(bytes)).status).toBe(200);
});

it('opens the consent preview only for a signed sealed request with current card and source bindings', async () => {
  const f = await fixture();
  const url = LOCAL_HISTORY_CONSENT_PREVIEW_PATH, ownerUserId = 'synthetic-owner';
  const principal = { deviceId: f.deviceId, deviceKeyHash: deviceKeyHashOf(f.phone.publicKey), ownerUserId };
  const issuer = { agentId: 'synthetic-history', machineId: f.signer.machineId(),
    bootId: 'synthetic-boot', signingKeyHash: f.signer.signerKeyHash() };
  const channels = new LocalHistoryChannelRegistry({
    principal: () => principal, issuer: () => issuer, sign: bytes => f.signer.sign(bytes.toString()).sig,
  });
  cleanups.push(() => channels.stop());
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const handshake = { machineId: issuer.machineId, clientPublicKey: ecdh.getPublicKey().toString('base64'),
    clientNonce: crypto.randomBytes(32).toString('base64') };
  const grant = channels.issue(principal, handshake);
  const pin = crypto.createPublicKey(f.identity.getSigningPublicKeyPem(issuer.machineId)!);
  const keys = finishLocalHistoryHandshake(grant, handshake, { ...issuer, ...principal }, ecdh, pin, Date.now());
  const channel = new LocalHistoryChannel(keys, { ...issuer, ...principal, channelId: grant.channelId }, 'client');
  keys.request.fill(0); keys.response.fill(0);
  const cardId = 'wc_' + 'a'.repeat(16), operationId = 'b'.repeat(32);
  const artifact = { fileId: 'fixture', kind: 'codex' as const, captureDigest: 'c'.repeat(64), artifactDigest: 'd'.repeat(64),
    projectPath: '/synthetic/selected', messages: 3, newMessages: 2, redactions: 1 };
  const destination = { agentId: issuer.agentId, machineId: issuer.machineId, bootId: issuer.bootId,
    machineKeyHash: issuer.signingKeyHash, origin: 'https://' + host, ownerUserId };
  const preview = { operationId, ownerUserId, previewId: 'e'.repeat(32), previewDigest: 'f'.repeat(64),
    expiresAt: Date.now() + 1000, destination, artifacts: [artifact] };
  let card = { cardId, created: true, materialHash: '0'.repeat(64), materialRevision: '1'.repeat(64), reopens: [], taps: [] };
  const binding = { cardId, operationId, ownerUserId, previewId: preview.previewId, previewDigest: preview.previewDigest,
    materialHash: card.materialHash, cardRevision: localHistoryConsentCardRevision(card) };
  const source = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = source.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sourceKey = { machineId: 'synthetic-source', signerKeyHash: signerKeyHashOf(publicKeyPem) };
  const now = 1000;
  const unsigned = { proofId: '9'.repeat(32), operationId, destination, sourceOwnerId: 'different-source-owner-id',
    issuedAt: now - 100, expiresAt: now + 100,
    files: [{ fileId: artifact.fileId, kind: artifact.kind, captureDigest: artifact.captureDigest }] };
  const signProof = (proof: typeof unsigned): LocalHistoryCaptureProof => ({
    ...proof, signature: { ...sourceKey, sig: sign(localHistoryCaptureProofMessage(proof, sourceKey), source.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()) },
  });
  const exactProof = signProof(unsigned);
  let proof: LocalHistoryCaptureProof | undefined = exactProof;
  let authority: { publicKeyPem: string; destinationOwnerId: string } | undefined = { publicKeyPem, destinationOwnerId: ownerUserId };
  const resolveOwnedCapture = createLocalHistoryCaptureResolver({
    now: () => now,
    loadProof: () => proof,
    currentAuthority(query) {
      if (query.operationId !== operationId || query.proofId !== unsigned.proofId || query.sourceOwnerId !== unsigned.sourceOwnerId
        || query.machineId !== sourceKey.machineId || query.signerKeyHash !== sourceKey.signerKeyHash
        || query.destination !== destination) return undefined;
      return authority;
    },
  });
  const review = {
    staging: { readOwnerConsentPreview: () => preview, readOwnerConsentCard: () => binding },
    board: { view: () => ({ status: 'not-started', card }) as never },
    resolveOwnedCapture,
  };
  const phone = makeDevice();
  const challenges = new LocalHistoryConsentChallenges(() => ({
    host, deviceId: principal.deviceId, ownerUserId, presenceKey: phone.publicKey,
  }), () => now);
  const service = createLocalHistoryConsentPreview({
    ...review, withExchange: async work => { await work(); return true; }, channels, challenges,
  });
  const challengePath = LOCAL_HISTORY_CONSENT_CHALLENGE_PATH, confirmPath = LOCAL_HISTORY_CONSENT_CONFIRM_PATH;
  const paths = [url, challengePath, confirmPath];
  for (const path of paths) expect((await f.send(Buffer.alloc(24), undefined, path)).status).toBe(503);
  f.selectConsent(service);
  for (const path of paths) {
    expect((await request(f.app).post(path).set('Authorization', 'Bearer test-bearer')
      .set('Content-Type', 'application/octet-stream').send(Buffer.alloc(24))).status).toBe(403);
  }
  const sealed = async (input: object, expectedStatus: number, path = url) => {
    const route = { method: 'POST' as const, path };
    const record = channel.sealRequest(Buffer.from(JSON.stringify(input)), route);
    const target = path + '?channelId=' + grant.channelId + '&sequence=' + record.readBigUInt64BE();
    const res = await f.send(record, record, target).buffer(true).parse((stream, done) => {
      const parts: Buffer[] = [];
      stream.on('data', part => parts.push(part));
      stream.on('end', () => done(null, Buffer.concat(parts)));
      stream.on('error', done);
    });
    expect(res.status).toBe(expectedStatus);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('application/octet-stream');
    const decoded = channel.openResponse(res.body, route);
    try { return JSON.parse(decoded.toString()); } finally { decoded.fill(0); }
  };
  cleanups.push(() => channel.dispose());
  const input = { cardId, operationId };
  const reply = await sealed(input, 200);
  expect(reply).toMatchObject({ cardId, previewId: preview.previewId, destination,
    files: [{ projectPath: artifact.projectPath, artifactDigest: artifact.artifactDigest, machineId: sourceKey.machineId }] });
  expect(JSON.stringify(reply)).not.toContain(artifact.captureDigest);
  expect(JSON.stringify(reply)).not.toContain('challenge');
  const refused = { error: 'local-history-consent-preview-unavailable' };
  expect(await sealed({ ...input, cardId: 'wc_' + 'f'.repeat(16) }, 404)).toEqual(refused);
  expect(await sealed({ ...input, machineId: 'claimed-source' }, 404)).toEqual(refused);
  for (const invalid of [
    undefined,
    signProof({ ...unsigned, expiresAt: now }),
    signProof({ ...unsigned, issuedAt: now + 1 }),
    signProof({ ...unsigned, destination: { ...destination, bootId: 'other-boot' } }),
    signProof({ ...unsigned, operationId: '8'.repeat(32) }),
    signProof({ ...unsigned, sourceOwnerId: ownerUserId }),
    { ...exactProof, signature: { ...exactProof.signature, sig: Buffer.alloc(64).toString('base64') } },
    signProof({ ...unsigned, files: [{ ...unsigned.files[0], captureDigest: artifact.artifactDigest }] }),
  ]) {
    proof = invalid;
    expect(await sealed(input, 404)).toEqual(refused);
  }
  proof = exactProof;
  authority = undefined;
  expect(await sealed(input, 404)).toEqual(refused);
  authority = { publicKeyPem: f.identity.getSigningPublicKeyPem(issuer.machineId)!, destinationOwnerId: ownerUserId };
  expect(await sealed(input, 404)).toEqual(refused);
  authority = { publicKeyPem, destinationOwnerId: 'other-owner' };
  expect(await sealed(input, 404)).toEqual(refused);
  authority = { publicKeyPem, destinationOwnerId: ownerUserId };
  expect(await sealed(input, 200)).toEqual(reply);
  const actionRefusal = { error: 'local-history-consent-unavailable' };
  const selection = { ...input, disclosureHash: reply.disclosureHash, applyRequestId: '7'.repeat(32) };
  expect(await sealed({ ...selection, disclosureHash: '1'.repeat(64) }, 404, challengePath)).toEqual(actionRefusal);
  expect(await sealed({ ...selection, host }, 404, challengePath)).toEqual(actionRefusal);
  const issued = await sealed(selection, 200, challengePath);
  expect(issued).toEqual({ actionLine: expect.any(String), challenge: expect.any(String), expiresAt: expect.any(Number) });
  const signature = phone.sign(permissionPresenceMessage(principal.deviceId, host, issued.challenge, issued.actionLine));
  const confirmation = { ...selection, challenge: issued.challenge, signature };
  expect(await sealed({ ...confirmation, applyRequestId: '6'.repeat(32) }, 404, confirmPath)).toEqual(actionRefusal);
  const otherHost = phone.sign(permissionPresenceMessage(principal.deviceId, 'different.example', issued.challenge, issued.actionLine));
  expect(await sealed({ ...confirmation, signature: otherHost }, 404, confirmPath)).toEqual(actionRefusal);
  authority = undefined;
  expect(await sealed(confirmation, 404, confirmPath)).toEqual(actionRefusal);
  expect(await sealed(selection, 404, challengePath)).toEqual(actionRefusal);
  authority = { publicKeyPem, destinationOwnerId: ownerUserId };
  expect(await sealed(confirmation, 200, confirmPath)).toEqual({
    actionLine: issued.actionLine, proofRef: expect.any(String),
  });
  expect(await sealed(confirmation, 404, confirmPath)).toEqual(actionRefusal);
  card = { ...card, materialRevision: '2'.repeat(64) };
  expect(await sealed(input, 404)).toEqual(refused);
  expect(await sealed(selection, 404, challengePath)).toEqual(actionRefusal);
});
