import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { reportSessionDelivery, recordRecoveredSessionDelivery } from '../../src/messaging/telegram-origin/SessionDeliveryReporter.js';

const roots: string[] = [];
const adapters: TelegramAdapter[] = [];
const gates: NotificationSelectivityGate[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.stop()));
  await Promise.all(gates.splice(0).map(gate => gate.close()));
  roots.splice(0).forEach(root => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'delivery reporter test cleanup' }));
  vi.restoreAllMocks();
});
function fixture(root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-delivery-reporter-')),
  settings?: { enabled: boolean; dryRun: boolean }) {
  if (!roots.includes(root)) roots.push(root);
  const telegram = new TelegramAdapter({ token: 'fixture-token', chatId: '-100123',
    getAttentionHubTopicId: () => 7848 }, root);
  adapters.push(telegram);
  let gate: NotificationSelectivityGate | undefined;
  if (settings) {
    gate = new NotificationSelectivityGate(root, 'fixture-machine', () => settings);
    gates.push(gate); telegram.selectivity = gate;
  }
  const send = vi.spyOn(telegram, 'sendToTopic').mockRejectedValue(new Error('Unexpected Telegram post'));
  const sendNotice = vi.fn(async () => new Response('{}', { status: 200 }));
  return { root, telegram, send, sendNotice, gate };
}
const held = (n: number) => ({ source: 'scan' as const, operationId: `original-${n}`, reason: 'delivery-held',
  chatId: '-100123', threadId: n % 48 + 1, state: 'held', preparedAt: Date.now() - 86400000 });

describe('historical delivery reconciliation stays off Telegram', () => {
  it.each([undefined, { enabled: false, dryRun: false }, { enabled: true, dryRun: true }, { enabled: true, dryRun: false }])(
    'records 151 replies across 48 inactive topics without egress, including restart (%j)', async settings => {
      const h = fixture(undefined, settings);
      for (let n = 0; n < 151; n++) await reportSessionDelivery(held(n), held(n).threadId, h);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.sendNotice).not.toHaveBeenCalled();
      expect(h.telegram.getAttentionItem('telegram-origin-held-reply:original-150')).toMatchObject({ status: 'OPEN', hubHeld: true });
      await h.telegram.stop(); await h.gate?.close();
      const restarted = fixture(h.root, settings);
      for (let n = 0; n < 151; n++) await reportSessionDelivery({ ...held(n), state: 'expired' }, held(n).threadId, restarted);
      expect(restarted.send).not.toHaveBeenCalled();
      expect(restarted.sendNotice).not.toHaveBeenCalled();
      expect(restarted.telegram.getAttentionItem('telegram-origin-held-reply:original-0')?.summary).toContain('did not reach');
    });
  it('keeps legacy callback entries quiet when explicit live eligibility is absent', async () => {
    const h = fixture();
    // An older runtime can remain loaded while a newer reporter is imported.
    const legacy = { ...held(1) } as Partial<Parameters<typeof reportSessionDelivery>[0]>;
    delete legacy.source;
    await reportSessionDelivery(legacy as Parameters<typeof reportSessionDelivery>[0], 2, h);
    expect(h.sendNotice).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    expect(h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')).toMatchObject({ status: 'OPEN', hubHeld: true });
  });
  it('silently closes a late accepted original without claiming a notice was delivered', async () => {
    const h = fixture();
    await reportSessionDelivery(held(1), 2, h);
    await reportSessionDelivery({ ...held(1), state: 'accepted', acceptedAt: Date.now(), outOfOrder: true }, 2, h);
    expect(h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')).toMatchObject({
      status: 'DONE', resolution: 'Telegram accepted the original reply.' });
    expect(h.send).not.toHaveBeenCalled(); expect(h.sendNotice).not.toHaveBeenCalled();
    await reportSessionDelivery({ ...held(1), state: 'accepted', acceptedAt: Date.now() }, 2, h);
    expect(h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')?.status).toBe('DONE');
  });
  it.each([true, false])('accepted legacy records stay local with automatic lifecycle enabled=%s', async enabled => {
    const h = fixture();
    // Exercise the real adapter's legacy reverse routing, which silent status
    // updates would otherwise use to send a line and close a forum topic.
    await reportSessionDelivery(held(1), 2, h);
    const item = h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')!;
    const legacy = h.telegram as unknown as { attentionItemToTopic: Map<string, number>; config: { attentionLifecycle?: { enabled: boolean } }; apiCall: () => Promise<unknown> };
    legacy.attentionItemToTopic.set(item.id, 99);
    legacy.config.attentionLifecycle = { enabled };
    const api = vi.spyOn(legacy, 'apiCall').mockRejectedValue(new Error('Unexpected legacy egress'));
    await reportSessionDelivery({ ...held(1), state: 'accepted' }, 2, h);
    expect(item.status).toBe('DONE');
    expect(item.closedBy).toBe('cause-cleared');
    expect(h.send).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
    expect(h.sendNotice).not.toHaveBeenCalled();
  });
  it.each([120_000, 360_000])('records a recovered receipt after %sms with no legacy status egress', async delay => {
    const h = fixture();
    await reportSessionDelivery(held(1), 2, h);
    const item = h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')!;
    const legacy = h.telegram as unknown as { attentionItemToTopic: Map<string, number>; config: { attentionLifecycle?: { enabled: boolean } }; apiCall: () => Promise<unknown> };
    legacy.attentionItemToTopic.set(item.id, 99);
    legacy.config.attentionLifecycle = { enabled: false };
    const api = vi.spyOn(legacy, 'apiCall').mockRejectedValue(new Error('Unexpected recovered-status egress'));
    const now = Date.now();
    recordRecoveredSessionDelivery({ operationId: 'original-1', chatId: '-100123', threadId: 2,
      messageId: 7, text: 'The recovered original answer', preparedAt: now - delay, acceptedAt: now, producerKind: 'session' }, h.telegram);
    expect(item).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared', resolution: 'Telegram accepted recovered message 7.' });
    expect(h.telegram.getTopicHistory(2, 10)).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'The recovered original answer' })]));
    expect(h.send).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled(); expect(h.sendNotice).not.toHaveBeenCalled();
  });
  it('preserves sticky attention records when reconciling an accepted original', async () => {
    const h = fixture();
    await reportSessionDelivery(held(1), 2, h);
    const item = h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')!;
    item.sticky = true;
    await reportSessionDelivery({ ...held(1), state: 'accepted' }, 2, h);
    expect(item.status).toBe('OPEN'); expect(h.sendNotice).not.toHaveBeenCalled();
  });
  it('retains the existing live failure path and stable notice identity', async () => {
    const h = fixture(); h.send.mockResolvedValue({ messageId: 1, topicId: 7848 });
    await reportSessionDelivery({ ...held(1), source: 'live' }, 2, h);
    expect(h.sendNotice).toHaveBeenCalledWith(2, expect.stringContaining('delayed'), 'reply-delivery-notice:original-1:delayed');
    expect(h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')?.status).toBe('OPEN');
  });
  it('surfaces a live notice failure while retaining the durable record', async () => {
    const h = fixture(); h.send.mockResolvedValue({ messageId: 1, topicId: 7848 });
    h.sendNotice.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(reportSessionDelivery({ ...held(1), source: 'live' }, 2, h)).rejects.toThrow('HTTP 503');
    expect(h.telegram.getAttentionItem('telegram-origin-held-reply:original-1')?.status).toBe('OPEN');
  });

  it('records a retired overtaken reply quietly: no topic notice, even from a live event', async () => {
    const h = fixture();
    await reportSessionDelivery({ source: 'live', operationId: 'retired-1', reason: 'overtaken-reply',
      chatId: '-100123', threadId: 14, state: 'suppressed', preparedAt: Date.now() - 60_000 }, 14, h);
    expect(h.sendNotice).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    const item = h.telegram.getAttentionItem('telegram-origin-held-reply:retired-1');
    expect(item?.priority).toBe('NORMAL');
    expect(item?.summary).toContain('newer reply');
  });
});
