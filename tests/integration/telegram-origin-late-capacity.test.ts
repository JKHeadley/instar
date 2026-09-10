import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { lateCapacityHttpHarness } from '../helpers/telegramLateCapacityHttp.js';

let worker: URL;
const closes: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('late capacity through authenticated reply HTTP and owner IPC', () => {
  it.each(['claim', 'markDispatched'] as const)('accepts after delayed %s using a fresh real IPC grant', async method => {
    const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
    const capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve'), consume = vi.spyOn(capacity, 'consume');
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
    const reserve = vi.spyOn(h.runtime.service.options.capacity!, 'reserve'); h.revokeLease();
    const response = await request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
      .send({ text: 'The report must wait for its current owner.' });
    expect(response.status).toBe(409); expect(reserve).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
  });

  it('refuses a lease revoked after durable dispatch without consuming capacity or calling the network', async () => {
    const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
    const capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve'), consume = vi.spyOn(capacity, 'consume');
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
