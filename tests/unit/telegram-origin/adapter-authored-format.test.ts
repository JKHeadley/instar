import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { compileOriginWorker } from '../../helpers/telegramOriginStore.js';
import { lateCapacityHarness } from '../../helpers/telegramLateCapacity.js';

let worker: URL;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe('direct adapter authored representation', () => {
  it.each(['scoped-automation', 'unbound-automation'] as const)('retains Markdown on held %s sends outside HTTP', async mode => {
    const h = await lateCapacityHarness(worker); cleanup.push(h.close);
    const adapter = new TelegramAdapter({ token: h.token, chatId: '-100123' }, h.stateDir, { suppressLifelineAutoCreate: true });
    cleanup.push(() => adapter.stop());
    h.runtime.options.onRecoveredMessage = entry => adapter.logRecoveredOriginMessage(entry);
    const text = 'The *read* action needs **approval**. Keep `<b>literal</b>`.';
    const capacity = vi.spyOn(h.runtime.service.options.capacity!, 'reserveExplained')
      .mockResolvedValue({ grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } });
    const send = () => adapter.sendToTopic(42, text);
    await expect(mode === 'scoped-automation' ? h.runtime.service.runAsAutomation('telegram-server', send) : send())
      .rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(h.network).not.toHaveBeenCalled();
    capacity.mockRestore();
    const row = (await h.runtime.store.listOrigins()).records[0];
    const nextAt = row.attempts.find(attempt => attempt.reason === 'credential-capacity-unavailable')?.nextAttemptAt;
    expect(Number.isSafeInteger(nextAt)).toBe(true);
    const waitMs = Math.max(0, nextAt! - Date.now() + 10);
    expect(waitMs).toBeLessThanOrEqual(31_000);
    if (waitMs) await delay(waitMs);
    expect(await h.runtime.recoverHeld()).toMatchObject({ recovered: 1 });
    expect(h.network).toHaveBeenCalledOnce();
    const wire = JSON.parse(h.network.mock.calls[0][1].body as string);
    expect(wire.parse_mode).toBe('HTML');
    expect(wire.text).toContain('<i>read</i>');
    expect(wire.text).toContain('<b>approval</b>');
    expect(adapter.getTopicHistory(42, 10)).toEqual([expect.objectContaining({ text, fromUser: false })]);
  }, 60_000);
});
