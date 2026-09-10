import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { OriginBotTransport } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { OriginCapacityUnavailable } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';
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

  it('charges unavailable capacity after durable intent without invoking network', async () => {
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

  it.each(['refused', 'expired-response'] as const)('keeps %s consumption provably unsent and charged, without renewal', async mode => {
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
