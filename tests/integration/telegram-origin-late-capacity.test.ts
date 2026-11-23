import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { lateCapacityHttpHarness } from '../helpers/telegramLateCapacityHttp.js';

let worker: URL;
const closes: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
// Real Boot teardown awaits native watcher closure on macOS.
afterEach(async () => {
  try {
    for (const close of closes.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 30_000);

describe('late capacity through authenticated reply HTTP and owner IPC', () => {
  it.each(['claim', 'markDispatched'] as const)('accepts after delayed %s using a fresh real IPC grant', async method => {
    const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
    const capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserveExplained'), consume = vi.spyOn(capacity, 'consumeExplained');
    if (method === 'claim') {
      const original = h.runtime.store.claim.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'claim').mockImplementation(async input => {
        const result = await original(input); await delay(300); return result;
      });
    } else {
      const original = h.runtime.store.markDispatched.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'markDispatched').mockImplementation(async input => {
        const result = await original(input); await delay(300); return result;
      });
    }
    const response = await request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
      .send({ text: 'The requested report is ready after storage completed.' });
    expect(response.status).toBe(200);
    expect(reserve).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(h.network).toHaveBeenCalledTimes(1);
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.operation?.state).toBe('accepted'); expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'accepted' });
  });

  it('keeps the real lease refusal ahead of capacity and network', async () => {
    const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
    const reserve = vi.spyOn(h.runtime.service.options.capacity!, 'reserveExplained'); h.revokeLease();
    const response = await request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
      .send({ text: 'The report must wait for its current owner.' });
    expect(response.status).toBe(409); expect(reserve).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
  });

  it('refuses a lease revoked after durable dispatch without consuming capacity or calling the network', async () => {
    const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
    const capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserveExplained'), consume = vi.spyOn(capacity, 'consumeExplained');
    const mark = h.runtime.store.markDispatched.bind(h.runtime.store);
    vi.spyOn(h.runtime.store, 'markDispatched').mockImplementation(async input => {
      const result = await mark(input); h.revokeLease(); return result;
    });
    const response = await request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
      .send({ text: 'The report must wait because ownership changed during dispatch.' });
    expect(response.status).toBe(409);
    expect(reserve).toHaveBeenCalledTimes(1); expect(consume).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed' });
  });

});

import express from 'express';
import { mountTelegramOriginRoutes } from '../../src/server/telegramOriginRoutes.js';
import { wrapOriginCapacityClient } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginCapacityAuthority } from '../../src/messaging/telegram-origin/OriginEgressCapacity.js';
it('returns actual stored capacity evidence through the authorized HTTP audit route', async () => {
  const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
  vi.spyOn(h.runtime.service.options.capacity!, 'reserveExplained').mockResolvedValue({ grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } });
  await request(h.app).post('/telegram/reply/42').set('Authorization', 'Bearer agent-test')
    .set('X-Instar-Origin-Session', h.sessionToken).send({ text: 'The readback fixture report is waiting.' });
  const row = (await h.runtime.store.listOrigins()).records[0];
  const app = express(), router = express.Router();
  mountTelegramOriginRoutes(router, { runtime: () => h.runtime, verifyOperator: proof => proof === 'fixture-operator' } as never);
  app.use(router);
  expect((await request(app).get(`/telegram/origins/${row.record.originId}`)).status).toBe(403);
  const read = await request(app).get(`/telegram/origins/${row.record.originId}`).set('X-Instar-Operator-Session', 'fixture-operator');
  expect(read.status).toBe(200);
  expect(read.body.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'collected', capacityEvidence: { cause: 'rate-window-full' } });
});
it.each(['legacy', 'explained'] as const)('keeps the stored generic IPC lease retry policy for a %s owner through the production runtime wrapper', async version => {
  const h = await lateCapacityHttpHarness(worker, false); closes.push(h.close);
  const authority: OriginCapacityAuthority = {
    diagnosticTransport: 'ipc', reserve: async () => null, consume: async () => false,
    reserveExplained: async () => ({ grant: null, refusal: { cause: version === 'explained' ? 'lease-not-held' : 'legacy-unexplained', leaseFreshness: null } }),
    consumeExplained: async () => ({ consumed: false, refusal: { cause: 'legacy-unexplained', leaseFreshness: null } }),
  };
  h.runtime.service.options.capacity = wrapOriginCapacityClient(authority, () => false);
  const recorded = h.runtime.store.recordOutcome.bind(h.runtime.store);
  const outcomes: Parameters<typeof recorded>[0][] = [];
  vi.spyOn(h.runtime.store, 'recordOutcome').mockImplementation(async input => { outcomes.push(input); return recorded(input); });
  const fixedNow = Date.now(); h.runtime.service.options.now = () => fixedNow;
  await request(h.app).post('/telegram/reply/42').set('Authorization', 'Bearer agent-test')
    .set('X-Instar-Origin-Session', h.sessionToken).send({ text: `The ${version} owner fixture waits for its lease.` });
  expect(h.network).not.toHaveBeenCalled();
  const row = (await h.runtime.store.listOrigins()).records[0];
  expect(row.attempts[0]).toMatchObject({ reason: 'credential-capacity-unavailable', capacityEvidence: { cause: version === 'explained' ? 'lease-not-held' : 'legacy-unexplained' } });
  expect(outcomes[0].nextAttemptAt).toBe(fixedNow + 30_000);
});

it('preserves a received consume refusal when caller closure happens during its wait', async () => {
  let closed = false;
  const refusal = { consumed: false, refusal: { cause: 'grant-expired' as const, leaseFreshness: null } };
  const client: OriginCapacityAuthority = { reserve: async () => null, consume: async () => false,
    consumeExplained: async () => { closed = true; return refusal; } };
  const wrapped = wrapOriginCapacityClient(client, () => closed);
  expect(await wrapped.consumeExplained!({ accountId: '123', ownerBootId: 'owner', nonce: 'one', expiresAt: Date.now() + 250 })).toBe(refusal);
});
it('retains received owner success when the caller close fence prevents network start', async () => {
  let closed = false;
  const client: OriginCapacityAuthority = { reserve: async () => null, consume: async () => true,
    consumeExplained: async () => { closed = true; return { consumed: true, refusal: null }; } };
  expect(await wrapOriginCapacityClient(client, () => closed).consumeExplained!({ accountId: '123', ownerBootId: 'owner', nonce: 'one', expiresAt: Date.now() + 250 }))
    .toMatchObject({ consumed: false, refusal: null, explanation: 'invalid', observedOwnerVerdict: 'consumed' });
});
