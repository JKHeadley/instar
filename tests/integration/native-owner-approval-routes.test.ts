import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createNativeOwnerApprovalRoutes } from '../../src/server/nativeOwnerApprovalRoutes.js';
import vector from '../fixtures/owner-approvals/signin-repair-v1.json';

const root = '/mobile/owner-approvals';
const fields = vector.challenge.challenge as unknown as NonNullable<
  ReturnType<Parameters<typeof createNativeOwnerApprovalRoutes>[0]['open']>>;
const id = fields[10];
const caller = {
  origin: fields[1], authorityId: fields[2], holderEpoch: fields[3], holderIncarnation: fields[4],
  ownerRevision: fields[5], deviceId: fields[6], deviceKeyHash: fields[7], biometricKeyHash: fields[8],
  biometricKeyGeneration: fields[9],
};

it('serves the exact signed fixture and accepts only the matching dedicated phone signature', async () => {
  let now = Number(vector.appClockMs);
  let recorded = false;
  let eligible = false;
  let applied = 0;
  let unexpectedMachine = false;
  const deps: Parameters<typeof createNativeOwnerApprovalRoutes>[0] = {
    authenticate: req => req.get('Authorization') === 'Bearer synthetic-owner' ? caller : null,
    now: () => now,
    sign: bytes => [vector.inventory, vector.disclosure, vector.challenge]
      .find(envelope => Object.entries(vector.exactBytesBase64).some(([field, exact]) => Object.hasOwn(envelope, field)
        && bytes.toString('base64') === exact)) ?? null,
    inventory: () => ({ expiresAtMs: String(vector.disclosure.disclosure[8]), entries: [[id, vector.submit.proposalHash]] }),
    disclosure: () => vector.disclosure.disclosure,
    open: () => fields,
    async consume(_caller, requestId, proof, validate) {
      if (!validate({ challenge: fields, proposalExpiresAtMs: String(vector.disclosure.disclosure[8]),
        keySpkiBase64: vector.keys.phoneP256SpkiBase64, eligible, historical: recorded, targetMachineIds: ['synthetic-mac'] })) return null;
      if (!recorded) { recorded = true; applied++; }
      return { status: 'accepted', requestId, proposalHash: proof.proposalHash, challengeId: proof.challengeId,
        receiptId: 'fixture-receipt', results: [{ machineId: unexpectedMachine ? 'other-machine' : 'synthetic-mac', ok: true, detail: 'private fixture field' }] };
    },
  };
  const app = express().use(express.json()).use(createNativeOwnerApprovalRoutes({ ...deps, enabled: true }));
  const disabled = express().use(createNativeOwnerApprovalRoutes(deps));
  const owner = (r: request.Test) => r.set('Authorization', 'Bearer synthetic-owner');
  expect((await request(disabled).get(root)).status).toBe(404);
  expect((await request(app).get(root)).status).toBe(403);
  expect((await owner(request(app).get(root))).body).toEqual(vector.inventory);
  expect((await owner(request(app).get(`${root}/${id}`))).body).toEqual(vector.disclosure);
  expect((await owner(request(app).get(`${root}/${id}?alias=1`))).status).toBe(404);
  expect((await owner(request(app).post(`${root}/${id}/challenge`)).send({ proposalHash: vector.submit.proposalHash })).body).toEqual(vector.challenge);
  const submit = (body: object) => owner(request(app).post(`${root}/${id}/approve`)).send(body);
  expect((await submit({ ...vector.submit, proposalHash: 'b'.repeat(64) })).status).toBe(409);
  expect((await submit({ ...vector.submit, signature: vector.challenge.signature })).status).toBe(409);
  expect((await submit(vector.submit)).status).toBe(409);
  eligible = true;
  now = Number(fields[15]) + 1;
  expect((await submit(vector.submit)).status).toBe(409);
  now = Number(vector.appClockMs);
  expect(applied).toBe(0);
  const first = await submit(vector.submit);
  expect(first.status).toBe(200);
  expect(first.body.results).toEqual([{ machineId: 'synthetic-mac', ok: true }]);
  unexpectedMachine = true;
  expect((await submit(vector.submit)).status).toBe(503);
  unexpectedMachine = false;
  now = Number(fields[15]) + 1;
  const retry = await submit(vector.submit);
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(first.body);
  expect(applied).toBe(1);
});
