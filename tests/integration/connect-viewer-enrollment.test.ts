import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { ConnectViewerAuthority } from '../../src/core/ConnectViewerAuthority.js';
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
  const grant = authority.grant({ ...binding, displayId: 'primary', expiresAt: Date.now() + 10_000 });
  const stream = grant?.attach(binding, 'primary');
  expect(stream?.aborted).toBe(false);
  authority.revoke(keyDigest);
  expect(stream?.aborted).toBe(true);
  expect(authority.viewer(keyDigest)).toBeUndefined();
});
