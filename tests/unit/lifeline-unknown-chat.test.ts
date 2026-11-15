/**
 * Lifeline must not file a message from an unconfigured Telegram chat as a
 * main-group message (feedback 2026-10-22): with issuesChatId added to the config
 * after the lifeline started, a message in issues-group thread 3 was forwarded as
 * main-group topic 3 and answered there. The lifeline accepts only the configured
 * chats, and re-reads the config when an unknown chat shows up, so a newly set
 * issuesChatId takes effect without a lifeline restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('lifeline ingress accepts only configured chats', () => {
  let dir: string; let savedHome: string | undefined; let fetchSpy: ReturnType<typeof vi.fn>;
  const writeConfig = (tg: Record<string, unknown>) => fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({
    agentName: 'test', port: 4999, authToken: 'tok', stateDir: path.join(dir, '.instar', 'state'),
    messaging: [{ type: 'telegram', enabled: true, config: { token: 'test-token', chatId: '-100123', ...tg } }],
  }));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-uc-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    writeConfig({});
    const cliDir = path.join(dir, 'home', '.claude', 'local');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    savedHome = process.env['HOME']; process.env['HOME'] = path.join(dir, 'home');
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lifeline unknown-chat test cleanup' });
  });
  async function lifeline() {
    const { _resetFrameworkBinaryCache } = await import('../../src/core/Config.js');
    _resetFrameworkBinaryCache();
    const { TelegramLifeline } = await import('../../src/lifeline/TelegramLifeline.js');
    const ll = new TelegramLifeline(dir) as unknown as { processUpdate(u: unknown): Promise<void>; supervisor: { healthy: boolean } };
    Object.defineProperty(ll.supervisor, 'healthy', { get: () => true, configurable: true });
    return ll;
  }
  const forwards = () => fetchSpy.mock.calls
    .filter((c) => String(c[0]).includes('/internal/telegram-forward'))
    .map((c) => JSON.parse((c[1] as { body: string }).body));
  const telegramSends = () => fetchSpy.mock.calls
    .filter((c) => String(c[0]).includes('api.telegram.org') && /\/send/.test(String(c[0])));
  const msg = (chatId: number, thread: number, text: string) => ({
    update_id: 1,
    message: { message_id: 50, from: { id: 1, first_name: 'J' }, chat: { id: chatId, type: 'supergroup' }, date: Math.floor(Date.now() / 1000), message_thread_id: thread, text },
  });

  it('drops a message from an unconfigured chat and picks up a newly set issuesChatId without a restart', async () => {
    const ll = await lifeline();
    // A chat that is neither chatId nor issuesChatId: never forwarded, never answered.
    await ll.processUpdate(msg(-100777, 3, 'hello from a stranger group'));
    expect(forwards()).toEqual([]);
    expect(telegramSends()).toEqual([]);

    // issuesChatId set after the lifeline started (the server was restarted, the lifeline was not).
    writeConfig({ issuesChatId: '-100555' });
    await ll.processUpdate(msg(-100555, 3, 'bug report'));
    const f = forwards();
    expect(f).toHaveLength(1);
    expect(f[0].topicId).toBe(10_000_000_003);
    expect(f[0].topicId).not.toBe(3);

    // The main group still works.
    await ll.processUpdate(msg(-100123, 3, 'main group text'));
    expect(forwards()[1]).toMatchObject({ topicId: 3 });
  });
});
