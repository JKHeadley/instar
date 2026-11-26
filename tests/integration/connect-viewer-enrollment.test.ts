import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { ConnectViewerAuthority, connectViewerAttachMessage } from '../../src/core/ConnectViewerAuthority.js';
import { ConnectConsentHost } from '../../src/core/ConnectConsentHost.js';
import { connectViewerEnrollmentMessage } from '../../src/core/ConnectViewerEnrollment.js';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';
import { mountConnectViewerEnrollment } from '../../src/server/connectViewerRoutes.js';

const path = '/desktop/connect/viewer/enroll';

it('keeps the route dark and enrollment scoped to the issuing process', async () => {
  const off = express();
  mountConnectViewerEnrollment(off);
  await request(off).post(path).expect(404);

  const authority = new ConnectViewerAuthority();
  const app = express();
  app.use(express.json());
  mountConnectViewerEnrollment(app, authority);

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const encoded = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
  const keyDigest = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  const binding = { agentId: 'agent', targetMachineId: 'machine', keyDigest };
  const challenge = authority.approveEnrollment(binding)!;
  const proof = connectViewerEnrollmentMessage(challenge);
  let signature = sign('sha256', proof, privateKey);
  while (!isStrictLowSDer(signature)) signature = sign('sha256', proof, privateKey);
  const body = { challengeId: challenge.nonce, publicKey: encoded, signature: signature.toString('base64url') };

  const restarted = new ConnectViewerAuthority();
  expect(restarted.enroll(body.challengeId, body.publicKey, body.signature)).toBe(false);
  await request(app).post(path).send(body).expect(204);
  expect(authority.viewer(keyDigest)?.binding).toEqual(binding);
  await request(app).post(path).send(body).expect(403);
  const lifetime = new AbortController();
  const host = new ConnectConsentHost();
  const connection = host.open({ agentId: binding.agentId, targetId: binding.targetMachineId,
    companionKeyDigest: keyDigest, revision: 1 }, publicKey, lifetime.signal, () => true)!;
  function hash(value: Buffer) { return createHash('sha256').update(value).digest(); }
  function frame(domain: string, ...fields: Buffer[]) {
    const type = Buffer.from('instar-connect-' + domain + '-v1');
    const transcript = Buffer.concat([Buffer.from([0, type.length]), type, ...fields]);
    let sig = sign('sha256', transcript, privateKey);
    for (let count = 0; !isStrictLowSDer(sig) && count < 100; count++) sig = sign('sha256', transcript, privateKey);
    if (!isStrictLowSDer(sig)) throw new Error('missing fixture signature');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(transcript.length);
    return { digest: hash(transcript), bytes: Buffer.concat([header, transcript, Buffer.from([0, sig.length]), sig]) };
  }
  const generation = Buffer.from(connection.generation, 'hex');
  expect(connection.admit(frame('connection-proof', hash(connection.challenge), generation,
    connection.challenge.subarray(-40, -8)).bytes)).toBe(true);
  const consent = { ...binding, displayId: 'primary', expiresAt: Date.now() + 10_000 };
  expect(authority.beginConsent({ ...consent, targetMachineId: 'wrong' }, connection, publicKey, () => true)).toBeUndefined();
  expect(authority.beginConsent(consent, { ...connection }, publicKey, () => true)).toBeUndefined();
  expect(authority.beginConsent(consent, connection, publicKey, () => false)).toBeUndefined();
  const exchange = authority.beginConsent(consent, connection, publicKey, () => true)!;
  const pending = exchange.request;
  const sessionId = Buffer.from(pending.sessionId, 'hex');
  const requestDigest = hash(exchange.requestTranscript);
  const nonce = Buffer.from(pending.nonce, 'hex');
  expect(requestDigest.toString('hex')).toBe(pending.requestDigest);
  expect(exchange.decide(frame('consent-decision', requestDigest, sessionId, nonce, generation, Buffer.from([0, 5]), Buffer.from('allow')).bytes)).toBe('allow');
  const deadline = Buffer.alloc(8);
  deadline.writeBigUInt64BE(BigInt(Date.now() + 4000));
  const ack = frame('consent-ack', sessionId, requestDigest, generation, deadline);
  expect(exchange.prepare(ack.bytes)).toBe(true);
  const confirmation = frame('consent-confirm', ack.digest, sessionId, generation).bytes;
  const active = exchange.confirm(confirmation)!;
  expect(active.id).toBe(pending.sessionId);
  expect(active.consent).toEqual(consent);
  expect(exchange.confirm(confirmation)).toBeUndefined();
  const attachProof = connectViewerAttachMessage(active);
  let attachSignature = sign('sha256', attachProof, privateKey);
  for (let count = 0; !isStrictLowSDer(attachSignature) && count < 100; count++) attachSignature = sign('sha256', attachProof, privateKey);
  expect(authority.attach(keyDigest, active.id, body.signature)).toBeUndefined();
  const stream = authority.attach(keyDigest, active.id, attachSignature.toString('base64url'));
  expect(stream?.aborted).toBe(false);
  expect(authority.attach(keyDigest, active.id, attachSignature.toString('base64url'))).toBeUndefined();
  lifetime.abort();
  expect(stream?.aborted).toBe(true);
  authority.revoke(keyDigest);
  expect(authority.viewer(keyDigest)).toBeUndefined();
});
