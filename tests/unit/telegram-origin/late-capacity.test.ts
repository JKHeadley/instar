import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { OriginBotTransport } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { OriginCapacityUnavailable } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';
import { consumeOriginLocalRefusal } from '../../../src/messaging/telegram-origin/OriginBotEgress.js';
import { compileOriginWorker } from '../../helpers/telegramOriginStore.js';
import { lateCapacityHarness } from '../../helpers/telegramLateCapacity.js';

let worker: URL;
const closes: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function harness() {
  const h = await lateCapacityHarness(worker); closes.push(h.close); return h;
}

describe('ordinary capacity acquired at the network boundary', () => {
  it('binds local-refusal proof to one request and consumes it only once', async () => {
    const h = await harness();
    vi.spyOn(h.runtime.service.options.capacity!, 'reserve').mockResolvedValue(null);
    let proof: unknown, originalRequest: Parameters<typeof consumeOriginLocalRefusal>[1] | undefined;
    const execute = h.runtime.service.executePreparedBot.bind(h.runtime.service);
    vi.spyOn(h.runtime.service, 'executePreparedBot').mockImplementation((operation, transport) => {
      const prepare = transport.prepare!;
      transport.prepare = async request => {
        const prepared = await prepare(request);
        return { ...prepared, send: async () => {
          try { return await prepared.send(); }
          catch (error) {
            proof = error; originalRequest = request;
            expect(consumeOriginLocalRefusal(error, { ...request })).toBe(false);
            throw error;
          }
        } };
      };
      return execute(operation, transport);
    });
    await expect(h.send()).rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(originalRequest).toBeDefined();
    expect(consumeOriginLocalRefusal(proof, originalRequest!)).toBe(false);
    expect((await h.runtime.store.listOrigins()).records[0].children[0].attempts).toBe(0);
  });

  it('keeps dispatch uncertain if local-refusal persistence fails before recovery', async () => {
    const h = await harness();
    vi.spyOn(h.runtime.service.options.capacity!, 'reserve').mockResolvedValue(null);
    vi.spyOn(h.runtime.store, 'recordOutcome').mockRejectedValue(new Error('outcome storage unavailable'));
    await expect(h.send()).rejects.toMatchObject({ reason: 'origin-execution-state-unavailable' });
    expect(h.network).not.toHaveBeenCalled();
    await h.runtime.store.reapAbandoned(Date.now() + 60_001);
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.children[0]).toMatchObject({ attempts: 1, state: 'outcome-unknown' });
    expect(await h.runtime.store.recoverableAdmissions()).toEqual([]);
  });
  it.each(['claim', 'markDispatched'] as const)('excludes delayed durable %s response from the short grant lifetime', async method => {
    const h = await harness(), capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve'), consume = vi.spyOn(capacity, 'consume');
    if (method === 'claim') {
      const original = h.runtime.store.claim.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'claim').mockImplementation(async input => {
        const claimed = await original(input); await delay(300); return claimed;
      });
    } else {
      const original = h.runtime.store.markDispatched.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'markDispatched').mockImplementation(async input => {
        const marked = await original(input); await delay(300); return marked;
      });
    }
    expect((await h.send()).ok).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(h.network).toHaveBeenCalledTimes(1);
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.operation?.state).toBe('accepted');
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'accepted' });
    expect(row.operation?.operationId).toBe(JSON.parse(row.record.envelopeJson).operationId);
  });

  it('does not acquire capacity when durable dispatch marking refuses', async () => {
    const h = await harness(), capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve'), consume = vi.spyOn(capacity, 'consume');
    vi.spyOn(h.runtime.store, 'markDispatched').mockResolvedValue(false);
    await expect(h.send()).rejects.toMatchObject({ reason: 'stale-dispatch-fence' });
    expect(reserve).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
  });

  it('retains local refusal audit without charging a transport attempt', async () => {
    const h = await harness(), capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve').mockResolvedValue(null);
    const consume = vi.spyOn(capacity, 'consume');
    await expect(h.send()).rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(reserve).toHaveBeenCalledTimes(1); expect(consume).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed',
      reason: 'credential-capacity-unavailable' });
    expect(row.children[0].state).toBe('queued');
    expect(row.operation?.maxAttempts).toBe(9);
    expect(row.children[0].attempts).toBe(0);
    expect(row.attempts[0].nextAttemptAt).toBeGreaterThan(row.attempts[0].resolvedAt!);
  });

  it('reserves only after the real store confirms dispatch intent', async () => {
    const h = await harness(), capacity = h.runtime.service.options.capacity!;
    const original = capacity.reserve.bind(capacity);
    vi.spyOn(capacity, 'reserve').mockImplementation(async account => {
      const row = (await h.runtime.store.listOrigins()).records[0];
      expect(row.attempts).toHaveLength(1);
      expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: null });
      return original(account);
    });
    expect((await h.send()).ok).toBe(true);
  });

  it('holds a missing capacity dependency before taking a durable claim', async () => {
    const h = await harness(); h.runtime.service.options.capacity = undefined;
    const claim = vi.spyOn(h.runtime.store, 'claim');
    await expect(h.send()).rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(claim).not.toHaveBeenCalled(); expect(h.network).not.toHaveBeenCalled();
    expect((await h.runtime.store.listOrigins()).records[0].attempts).toEqual([]);
  });

  it.each(['refused', 'expired-response'] as const)('keeps %s consumption uncharged without renewing the capacity grant', async mode => {
    const h = await harness(), capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve');
    const original = capacity.consume.bind(capacity);
    const consume = vi.spyOn(capacity, 'consume').mockImplementation(async grant => {
      if (mode === 'refused') return false;
      const consumed = await original(grant); await delay(300); return consumed;
    });
    await expect(h.send()).rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(reserve).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(h.network).not.toHaveBeenCalled();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed',
      reason: 'credential-capacity-unavailable' });
    expect(row.children[0].state).toBe('queued');
    expect(row.children[0].attempts).toBe(0);
  });

  it('does not refund an error of the same class thrown by the network callback', async () => {
    const h = await harness();
    h.network.mockRejectedValue(new OriginCapacityUnavailable());
    await expect(h.send()).rejects.toMatchObject({ reason: 'transport-acceptance-unknown' });
    expect(h.network).toHaveBeenCalledOnce();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.children[0].attempts).toBe(1);
    expect(row.children[0].state).toBe('outcome-unknown');
  });

  it('returns the transport attempt on a capacity IPC exception before network', async () => {
    const h = await harness();
    vi.spyOn(h.runtime.service.options.capacity!, 'reserve').mockRejectedValue(new Error('IPC unavailable'));
    await expect(h.send()).rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(h.network).not.toHaveBeenCalled();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(row.children[0]).toMatchObject({ attempts: 0, state: 'queued' });
  });

  it('latches before reserve so concurrent and repeated closure calls cannot acquire another grant', async () => {
    const h = await harness(), capacity = h.runtime.service.options.capacity!;
    const reserve = vi.spyOn(capacity, 'reserve'), consume = vi.spyOn(capacity, 'consume');
    type Prepared = Awaited<ReturnType<NonNullable<OriginBotTransport['prepare']>>>;
    let prepared: Prepared | undefined;
    const execute = h.runtime.service.executePreparedBot.bind(h.runtime.service);
    vi.spyOn(h.runtime.service, 'executePreparedBot').mockImplementation(async (operation, network) => {
      const prepare = network.prepare!;
      network.prepare = async request => {
        prepared = await prepare(request);
        const original = prepared;
        return { ...original, send: async () => {
          const outcomes = await Promise.allSettled([original.send(), original.send()]);
          expect(outcomes[0].status).toBe('fulfilled');
          expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: expect.any(OriginCapacityUnavailable) });
          if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
          return outcomes[0].value;
        } };
      };
      return execute(operation, network);
    });
    expect((await h.send()).ok).toBe(true);
    await expect(prepared!.send()).rejects.toBeInstanceOf(OriginCapacityUnavailable);
    expect(reserve).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(h.network).toHaveBeenCalledTimes(1);
  });
});
