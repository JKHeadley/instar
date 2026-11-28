import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { formatForTelegram } from '../../../src/messaging/TelegramMarkdownFormatter.js';
import { telegramFetch } from '../../../src/messaging/telegram-egress.js';
import { compileOriginWorker } from '../../helpers/telegramOriginStore.js';
import { lateCapacityHarness } from '../../helpers/telegramLateCapacity.js';
import { setTimeout as delay } from 'node:timers/promises';

let worker: URL;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

/** Recovery is a repeated pass by contract: a pass that skips a due reply (a busy store, a hold
 * still settling under load) leaves it eligible for the next pass. The full unit suite on a loaded
 * Studio once saw the first pass after the wait process nothing, so a single pass is not the
 * contract to assert. Run passes until one sends, bounded; if none does, fail with the stored
 * attempts and what the store considers recoverable, never a bare count. */
async function recoverUntilSent(h: Awaited<ReturnType<typeof lateCapacityHarness>>, boundMs = 15_000): Promise<number> {
  const passes: Array<{ processed: number; recovered: number }> = [];
  const end = Date.now() + boundMs;
  while (Date.now() < end) {
    const pass = await h.runtime.recoverHeld();
    passes.push(pass);
    if (pass.recovered > 0) return pass.recovered;
    await delay(250);
  }
  const recoverable = await h.runtime.store.recoverableAdmissions();
  const row = (await h.runtime.store.listOrigins()).records[0];
  const attempts = row?.attempts.map(attempt => ({ outcome: attempt.outcome, reason: attempt.reason, nextAttemptAt: attempt.nextAttemptAt }));
  throw new Error(`no recovery pass sent the held reply within ${boundMs} ms: passes ${JSON.stringify(passes)}; `
    + `recoverable now ${recoverable.length}; now ${Date.now()}; attempts ${JSON.stringify(attempts)}`);
}

describe('origin recovery history representation', () => {
  it.each(['Markdown', 'plain'])('retains original %s queue text before import formatting', async format => {
    const h = await lateCapacityHarness(worker);
    cleanup.push(h.close);
    const text = 'The *read* action needs **approval**. Keep `<b>literal code</b>` unchanged.';
    const operation = h.runtime.service.prepareImportedLegacy({ deliveryId: 'legacy-format-fixture', topicId: 42,
      text, format, preparedAt: Date.now(), attempts: 0, nextAttemptAt: null, state: 'queued',
      snapshotDigest: 'd'.repeat(64), replaySafe: true, originSessionDigest: null }, '123', '-100123');
    const sealed = JSON.parse(operation.admission.children[0].materializations[0].requestJson);
    expect(sealed.policy.text).toBe(text);
    expect(JSON.parse(sealed.body).parse_mode).toBe('HTML');
    expect(h.network).not.toHaveBeenCalled();
  });

  it('records authored Markdown after a capacity hold while replaying sealed HTML once', async () => {
    const h = await lateCapacityHarness(worker);
    cleanup.push(h.close);
    const adapter = new TelegramAdapter({ token: h.token, chatId: '-100123' }, h.stateDir, { suppressLifelineAutoCreate: true });
    cleanup.push(() => adapter.stop());
    h.runtime.options.onRecoveredMessage = entry => adapter.logRecoveredOriginMessage(entry);
    const text = 'The *read* action needs **approval**. Keep `<b>literal code</b>` unchanged.';
    const formatted = formatForTelegram(text, 'markdown');
    const capacity = vi.spyOn(h.runtime.service.options.capacity!, 'reserveExplained')
      .mockResolvedValue({ grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } });
    await expect(h.runtime.service.runWithSessionToken(h.sessionToken, async () =>
      h.runtime.service.runWithSendPolicyInput(text, undefined, () => telegramFetch(
        `https://api.telegram.org/bot${h.token}/sendMessage`, { method: 'POST',
          body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42,
            text: formatted.text, parse_mode: formatted.parseMode }) }))))
      .rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(h.network).not.toHaveBeenCalled();
    expect(adapter.getTopicHistory(42, 10)).toEqual([]);
    capacity.mockRestore();
    const row = (await h.runtime.store.listOrigins()).records[0];
    const nextAt = row.attempts.find(attempt => attempt.reason === 'credential-capacity-unavailable')?.nextAttemptAt;
    expect(Number.isSafeInteger(nextAt)).toBe(true);
    const waitMs = Math.max(0, nextAt! - Date.now() + 10);
    expect(waitMs).toBeLessThanOrEqual(31_000);
    if (waitMs) await delay(waitMs);
    expect(await recoverUntilSent(h)).toBe(1);
    expect(h.network).toHaveBeenCalledOnce();
    const wire = JSON.parse(h.network.mock.calls[0][1].body as string);
    expect(wire.parse_mode).toBe('HTML');
    expect(wire.text).toContain('<i>read</i>');
    expect(wire.text).toContain('<b>approval</b>');
    expect(adapter.getTopicHistory(42, 10)).toEqual([expect.objectContaining({ text, fromUser: false })]);
    expect(await h.runtime.recoverHeld()).toMatchObject({ recovered: 0 });
    expect(h.network).toHaveBeenCalledOnce();
    expect(adapter.getTopicHistory(42, 10)).toHaveLength(1);
  }, 60_000);
});
