/**
 * Pinned messages and Telegram (docs/specs/conversation-pinned-messages.md): a pin made in Telegram
 * by an authorized person is handed to the server, a stranger's (or an anonymous admin's) is ignored
 * quietly, the lifeline forwards a pin service message on agents where it owns polling, the outward
 * pin and unpin calls carry ids only (quietly, in the topic's chat), and the egress door allows
 * unpinChatMessage as an id-only method.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS } from '../../src/messaging/invisible-payload.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Proc = { processUpdate(u: unknown): Promise<void>; apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> };

describe('the adapter and pins', () => {
  let dir: string; let adapter: TelegramAdapter;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgpin-')); adapter = new TelegramAdapter({ token: '', chatId: '-1001', authorizedUserIds: [4242] } as never, dir, { suppressLifelineAutoCreate: true }); });
  afterEach(async () => { await adapter.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/telegram-pins.test.ts' }); });

  it('hands an authorized pin to the server and never treats it as a message', async () => {
    const seen = vi.fn();
    adapter.onTopicMessagePinned = seen;
    const messages = vi.fn();
    adapter.onMessage(messages);
    await (adapter as unknown as Proc).processUpdate({ update_id: 1, message: { message_id: 501, from: { id: 4242, first_name: 'Justin' }, chat: { id: -1001 }, date: 1, message_thread_id: 77, pinned_message: { message_id: 400 } } });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ topicId: 77, messageId: 400, serviceMessageId: 501, byName: 'Justin' }));
    expect(messages).not.toHaveBeenCalled();
  });

  it('ignores a pin by someone not authorized here, quietly', async () => {
    const seen = vi.fn();
    adapter.onTopicMessagePinned = seen;
    const calls: string[] = [];
    (adapter as unknown as Proc).apiCall = async (m) => { calls.push(m); return {}; };
    await (adapter as unknown as Proc).processUpdate({ update_id: 2, message: { message_id: 502, from: { id: 1087968824, first_name: 'Group' }, chat: { id: -1001 }, date: 1, message_thread_id: 77, pinned_message: { message_id: 400 } } });
    expect(seen).not.toHaveBeenCalled();
    expect(calls).toEqual([]); // no reply of any kind
  });

  it('a forwarded pin from the lifeline is handed over only for an authorized person', () => {
    const seen = vi.fn();
    adapter.onTopicMessagePinned = seen;
    expect(adapter.handleForwardedPin({ topicId: 77, messageId: 400, serviceMessageId: 501, fromUserId: 9, byName: 'x' })).toBe(false);
    expect(adapter.handleForwardedPin({ topicId: 77, messageId: 400, serviceMessageId: 501, fromUserId: 4242, byName: 'Justin' })).toBe(true);
    expect(adapter.handleForwardedPin({ topicId: 77, messageId: -1, serviceMessageId: 501, fromUserId: 4242, byName: 'Justin' })).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('pins quietly and unpins with ids only, in the topic chat', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    (adapter as unknown as Proc).apiCall = async (m, p) => { calls.push([m, p]); return {}; };
    await adapter.pinTopicMessage(77, 400, true);
    await adapter.pinTopicMessage(77, 400, false);
    expect(calls).toEqual([
      ['pinChatMessage', { chat_id: '-1001', message_id: 400, disable_notification: true }],
      ['unpinChatMessage', { chat_id: '-1001', message_id: 400 }],
    ]);
  });

  it('the egress door knows unpinChatMessage carries ids, not prose', () => {
    expect(NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS.has('unpinChatMessage')).toBe(true);
    expect(NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS.has('pinChatMessage')).toBe(true);
  });
});

describe('the lifeline passes pins on', () => {
  let dir: string; let savedHome: string | undefined; let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-pin-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({
      agentName: 'test', port: 4999, authToken: 'tok', stateDir: path.join(dir, '.instar', 'state'),
      messaging: [{ type: 'telegram', enabled: true, config: { token: 'test-token', chatId: '-100123' } }],
    }));
    const cliDir = path.join(dir, 'home', '.claude', 'local');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    savedHome = process.env['HOME']; process.env['HOME'] = path.join(dir, 'home');
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/telegram-pins.test.ts lifeline' });
  });

  it('a pin service message (no text) is forwarded as a pin-only update with who pinned', async () => {
    const { _resetFrameworkBinaryCache } = await import('../../src/core/Config.js');
    _resetFrameworkBinaryCache();
    const { TelegramLifeline } = await import('../../src/lifeline/TelegramLifeline.js');
    const ll = new TelegramLifeline(dir) as unknown as { processUpdate(u: unknown): Promise<void>; supervisor: { healthy: boolean } };
    Object.defineProperty(ll.supervisor, 'healthy', { get: () => true, configurable: true });
    await ll.processUpdate({ update_id: 1, message: { message_id: 601, from: { id: 4242, first_name: 'Justin' }, chat: { id: -100123 }, date: 1, message_thread_id: 77, pinned_message: { message_id: 400 } } });
    const forwards = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/internal/telegram-forward')).map((c) => JSON.parse((c[1] as { body: string }).body));
    expect(forwards).toEqual([expect.objectContaining({ topicId: 77, text: '', pinOnly: true, pinnedMessageId: 400, pinServiceMessageId: 601, fromUserId: 4242, fromFirstName: 'Justin' })]);
  });
});
