/**
 * Lifeline ingress accepts only configured chats (feedback 17ab2960, 2026-10-22).
 *
 * issuesChatId was set and only the server restarted. The still-running lifeline
 * had no issuesChatId, so a message from the issues group's thread 3 was taken as
 * MAIN-group topic 3 and a reply landed in an unrelated main topic. The lifeline
 * must never treat a group it does not know as the main group, and a newly set
 * issuesChatId must reach a running lifeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('lifeline ingress from chats it was not configured for', () => {
  let dir: string; let savedHome: string | undefined; let fetchSpy: ReturnType<typeof vi.fn>;
  const configPath = () => path.join(dir, '.instar', 'config.json');
  const writeConfig = (tg: Record<string, unknown>) => fs.writeFileSync(configPath(), JSON.stringify({
    agentName: 'test', port: 4999, authToken: 'tok', stateDir: path.join(dir, '.instar', 'state'),
    messaging: [{ type: 'telegram', enabled: true, config: { token: 'test-token', chatId: '-100123', ...tg } }],
  }));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-unknown-chat-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    writeConfig({});
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
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unknown-chat lifeline test cleanup' });
  });
  async function lifeline() {
    const { _resetFrameworkBinaryCache } = await import('../../../src/core/Config.js');
    _resetFrameworkBinaryCache();
    const { TelegramLifeline } = await import('../../../src/lifeline/TelegramLifeline.js');
    const ll = new TelegramLifeline(dir) as unknown as { processUpdate(u: unknown): Promise<void>; supervisor: { healthy: boolean } };
    Object.defineProperty(ll.supervisor, 'healthy', { get: () => true, configurable: true });
    return ll;
  }
  const forwards = () => fetchSpy.mock.calls
    .filter((c) => String(c[0]).includes('/internal/telegram-forward'))
    .map((c) => JSON.parse((c[1] as { body: string }).body));
  const topicCreated = (chatId: number, thread: number) => ({
    update_id: 1,
    message: { message_id: 50, from: { id: 1, first_name: 'J' }, chat: { id: chatId, type: 'supergroup' }, date: 1, message_thread_id: thread, forum_topic_created: { name: 'Bug: something' } },
  });

  it('drops a message from an unconfigured group instead of filing it as a main-group topic', async () => {
    const ll = await lifeline();
    await ll.processUpdate(topicCreated(-100999, 3));
    expect(forwards()).toEqual([]);
    // the main group itself still works
    await ll.processUpdate(topicCreated(-100123, 3));
    expect(forwards()).toEqual([expect.objectContaining({ topicId: 3 })]);
  });

  it('picks up an issuesChatId set after the lifeline started and routes to the issues topic', async () => {
    const ll = await lifeline();
    writeConfig({ issuesChatId: '-100999' }); // only the server was restarted
    await ll.processUpdate(topicCreated(-100999, 3));
    const sent = forwards();
    expect(sent.map((f) => f.topicId)).not.toContain(3);
    expect(sent).toEqual([expect.objectContaining({ topicId: 10_000_000_003 })]);
  });
});
