/**
 * Topic names reach the server on agents whose lifeline owns polling
 * (2026-11-02): topics the operator created in Telegram showed as
 * "Conversation name unavailable" because the lifeline dropped the
 * text-less topic-created service message and never passed the name on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TelegramAdapter.captureTopicName', () => {
  let dir: string; let adapter: TelegramAdapter;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-')); adapter = new TelegramAdapter({ token: 't', chatId: '-100123' } as never, dir, { suppressLifelineAutoCreate: true }); });
  afterEach(async () => { await adapter.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'topic-names test cleanup' }); });

  it('names an unnamed topic; a creation name never overwrites a known one; a rename does and fires the handler', () => {
    const renamed = vi.fn();
    adapter.setTopicRenamedHandler(renamed);
    adapter.captureTopicName(135187, 'Max credits', false);
    expect(adapter.getTopicName(135187)).toBe('Max credits');
    adapter.captureTopicName(135187, 'Some older name', false);
    expect(adapter.getTopicName(135187)).toBe('Max credits');
    expect(renamed).not.toHaveBeenCalled();
    adapter.captureTopicName(135187, 'Claude credits', true);
    expect(adapter.getTopicName(135187)).toBe('Claude credits');
    expect(renamed).toHaveBeenCalledWith(135187, 'Claude credits');
  });
  it('ignores an empty name and clamps a long one', () => {
    adapter.captureTopicName(5, '   ', false);
    expect(adapter.getTopicName(5)).toBeNull();
    adapter.captureTopicName(6, 'x'.repeat(500), false);
    expect(adapter.getTopicName(6)?.length).toBe(128);
  });
});

describe('the lifeline passes topic names on', () => {
  let dir: string; let savedHome: string | undefined; let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-tn-'));
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
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'topic-names lifeline test cleanup' });
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

  it('a topic-created service message (no text) is forwarded as a name-only update', async () => {
    const ll = await lifeline();
    await ll.processUpdate({ update_id: 1, message: { message_id: 135187, from: { id: 1, first_name: 'J' }, chat: { id: -100123 }, date: 1, message_thread_id: 135187, forum_topic_created: { name: 'Max credits' } } });
    expect(forwards()).toEqual([expect.objectContaining({ topicId: 135187, text: '', topicName: 'Max credits', topicRenamed: false, nameOnly: true })]);
  });
  it('a rename is forwarded as a rename', async () => {
    const ll = await lifeline();
    await ll.processUpdate({ update_id: 2, message: { message_id: 9, from: { id: 1, first_name: 'J' }, chat: { id: -100123 }, date: 1, message_thread_id: 135187, forum_topic_edited: { name: 'Claude credits' } } });
    expect(forwards()[0]).toMatchObject({ topicName: 'Claude credits', topicRenamed: true, nameOnly: true });
  });
});
