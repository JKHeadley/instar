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

describe('late ordinary capacity is alive across production Boot restart', () => {
  it('preserves an uncharged local refusal and its pacing across production restart', async () => {
    const h = await lateCapacityHttpHarness(worker, true); closes.push(h.close);
    vi.spyOn(h.runtime.service.options.capacity!, 'reserve').mockResolvedValue(null);
    const response = await request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
      .send({ text: 'The requested report remains queued during local capacity refusal.' });
    expect(response.status).toBe(409);
    expect(h.network).not.toHaveBeenCalled();
    const original = (await h.runtime.store.listOrigins()).records[0];
    expect(original.children[0]).toMatchObject({ attempts: 0, state: 'queued' });
    expect(original.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed' });
    await h.restart();
    const restored = await h.runtime.store.getOrigin(original.record.originId);
    expect(restored?.children[0]).toMatchObject({ attempts: 0, state: 'queued' });
    expect(restored?.operation?.deadlineAt).toBe(original.operation?.deadlineAt);
    expect(restored?.attempts).toEqual(original.attempts);
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.network).not.toHaveBeenCalled();
  });
  it('records concrete receipts after slow durable dispatch before and after restart', async () => {
    const h = await lateCapacityHttpHarness(worker, false); closes.push(h.close);
    let firstOperation: string | undefined;
    for (const phase of ['before', 'after']) {
      if (phase === 'after') await h.restart();
      const mark = h.runtime.store.markDispatched.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'markDispatched').mockImplementation(async input => {
        const result = await mark(input); await delay(300); return result;
      });
      const response = await request(h.app).post('/telegram/reply/42')
        .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
        .send({ text: `The requested report ${phase} the server restart is ready.` });
      expect(response.status).toBe(200);
      const rows = (await h.runtime.store.listOrigins()).records;
      expect(rows.every(row => row.operation?.state === 'accepted')).toBe(true);
      expect(rows.every(row => row.attempts.length === 1 && row.attempts[0].outcome === 'accepted')).toBe(true);
      if (phase === 'before') { expect(rows).toHaveLength(1); firstOperation = rows[0].operation?.operationId; }
      else {
        expect(rows).toHaveLength(2);
        expect(rows.some(row => row.operation?.operationId === firstOperation)).toBe(true);
      }
    }
    expect(h.network).toHaveBeenCalledTimes(2);
  });
});
