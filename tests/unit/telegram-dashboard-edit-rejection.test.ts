import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { recordTelegramEditRejection, takeTelegramEditRejection } from '../../src/messaging/TelegramEditRejection.js';

const missing = { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' };
const unchanged = { ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' };

describe('dashboard refresh preserves rejected edits', () => {
  let dir: string;
  let statePath: string;
  let adapter: TelegramAdapter;
  let originalState: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-edit-rejection-'));
    statePath = path.join(dir, 'state', 'dashboard-message.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    originalState = JSON.stringify({ messageId: 88, savedAt: '2026-09-10T00:00:00.000Z' });
    fs.writeFileSync(statePath, originalState);
    adapter = new TelegramAdapter({ token: '123456:fixture-token', chatId: '-100123456',
      dashboardTopicId: 5, dashboardPin: '123456' }, dir);
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true,
      operation: 'tests/unit/telegram-dashboard-edit-rejection.test.ts:cleanup' });
  });

  it.each([
    new TelegramOriginHoldError('credential-capacity-unavailable', 'original-operation'),
    new TelegramOriginHoldError('transport-acceptance-unknown', 'original-operation', 'outcome-unknown'),
    new Error('network unavailable'),
    new Error('message is not modified'),
    new Error('Bad Request: message to edit not found'),
  ])('does not turn an unproven edit rejection into a fresh send: %s', async error => {
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetch);
    const send = vi.spyOn(adapter, 'sendToTopic').mockResolvedValue({ messageId: 99, topicId: 5 });
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).rejects.toBe(error);
    expect(send).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });

  it.each([null, undefined])('preserves original custody on a tokenless adapter (%s)', async token => {
    await adapter.stop();
    adapter = new TelegramAdapter({ token: token as never, chatId: '-100123456', dashboardTopicId: 5, dashboardPin: '123456' }, dir);
    const held = new TelegramOriginHoldError('unregistered-credential-owner', 'original-operation');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(held));
    const send = vi.spyOn(adapter, 'sendToTopic');
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).rejects.toBe(held);
    expect(send).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });

  it.each([
    [400, { ok: false, error_code: 400, description: "Bad Request: message can't be edited" }],
    [403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked' }],
    [500, { ok: false, error_code: 500, description: 'Bad Request: message to edit not found' }],
    [400, { ok: false, error_code: 403, description: 'Bad Request: message to edit not found' }],
    [400, { ...missing, ok: true }],
    [400, { ...missing, description: `${missing.description}: try sending again` }],
    [401, missing],
    [400, null],
  ])('refuses replacement for HTTP%s without exact message-gone evidence', async (status, body) => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetch);
    const send = vi.spyOn(adapter, 'sendToTopic').mockResolvedValue({ messageId: 99, topicId: 5 });
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });

  it('treats the exact authoritative unchanged response as a no-op', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(unchanged), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const send = vi.spyOn(adapter, 'sendToTopic');
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).resolves.toMatchObject({ edited: true, messageId: 88 });
    expect(fetch).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });

  it('replaces only the missing message, then edits the saved replacement on the next refresh', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = new URL(url).pathname.split('/').pop()!;
      const body = JSON.parse(init.body as string); requests.push({ method, body });
      if (method === 'editMessageText' && body.message_id === 88) return new Response(JSON.stringify(missing), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: -100123456 } } }));
    }));
    const send = vi.spyOn(adapter, 'sendToTopic');
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).resolves.toMatchObject({ edited: false, messageId: 99 });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).messageId).toBe(99);
    await expect(adapter.broadcastDashboardUrl('https://next.example.test', 'quick')).resolves.toMatchObject({ edited: true, messageId: 99 });
    expect(send).toHaveBeenCalledOnce();
    expect(requests.map(r => r.method)).toEqual(['editMessageText', 'sendMessage', 'unpinAllForumTopicMessages', 'pinChatMessage', 'editMessageText']);
    expect(requests[4].body.message_id).toBe(99);
  });

  it('preserves the original hold when the authorized replacement itself is held', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(missing), { status: 400 })));
    const held = new TelegramOriginHoldError('credential-capacity-unavailable', 'replacement-operation');
    const send = vi.spyOn(adapter, 'sendToTopic').mockRejectedValue(held);
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).rejects.toBe(held);
    expect(send).toHaveBeenCalledOnce();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });

  it('preserves the saved ID on malformed response JSON', async () => {
    const fetch = vi.fn(async () => new Response('message to edit not found', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const send = vi.spyOn(adapter, 'sendToTopic');
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).rejects.toThrow('Telegram API error');
    expect(fetch).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });

  it('never replaces a rate-limited edit after the existing retry budget is exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 0 } }), { status: 429 })));
    const send = vi.spyOn(adapter, 'sendToTopic');
    await expect(adapter.broadcastDashboardUrl('https://new.example.test', 'quick')).rejects.toThrow('after 3 retries');
    expect(send).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
  });
});

describe('Telegram edit rejection evidence boundaries', () => {
  const target = { method: 'editMessageText', accountId: '123', params: { chat_id: '-100123', message_id: 88 } };
  it('preserves error identity and binds evidence to account, chat, message and method, consumed once', () => {
    const held = new TelegramOriginHoldError('telegram-400', 'original-operation', 'known-failed');
    expect(recordTelegramEditRejection(held, 400, missing, target)).toBe(held);
    for (const foreign of [{ ...target, accountId: '456' }, { ...target, method: 'sendMessage' },
      { ...target, params: { ...target.params, chat_id: '-100456' } }, { ...target, params: { ...target.params, message_id: 89 } }]) {
      expect(takeTelegramEditRejection(held, foreign)).toBeNull();
    }
    expect(takeTelegramEditRejection(held, target)).toBe('message-missing');
    expect(takeTelegramEditRejection(held, target)).toBeNull();
  });
  it('does not transfer authority through copied error fields or serialization', () => {
    const error = recordTelegramEditRejection(new Error('platform rejection'), 400, missing, target);
    expect(takeTelegramEditRejection(Object.assign(new Error(error.message), error), target)).toBeNull();
    expect(takeTelegramEditRejection(JSON.parse(JSON.stringify(error)), target)).toBeNull();
  });
});
