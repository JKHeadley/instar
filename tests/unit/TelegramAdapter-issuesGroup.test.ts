/**
 * Issues group ("<agent> Bugs"): topics in a second forum chat get internal ids in a
 * disjoint range and are translated only at the Telegram edge.
 * Spec: docs/specs/telegram-issues-group.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ISSUES_TOPIC_OFFSET } from '../../src/messaging/telegramTopicSpace.js';

const MAIN = '-100123456';
const ISSUES = '-100999888';

function okFetch(result: unknown = { message_id: 1 }) {
  return vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({ ok: true, result: url.includes('getUpdates') ? [] : result }),
  }));
}

function bodies(mock: ReturnType<typeof vi.fn>, method: string): Array<Record<string, unknown>> {
  return mock.mock.calls
    .filter(([url]) => String(url).includes(`/${method}`))
    .map(([, opts]) => JSON.parse((opts as { body: string }).body));
}

describe('TelegramAdapter — issues group', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-issues-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: MAIN, issuesChatId: ISSUES, pollIntervalMs: 100 }, tmpDir);
  });

  afterEach(async () => {
    await adapter.stop();
    vi.unstubAllGlobals();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/TelegramAdapter-issuesGroup.test.ts' });
  });

  it('exposes the same native destination as actual normal and issues dispatch', async () => {
    expect(adapter.getNativeTopicDestination(7)).toEqual({ chatId: MAIN, threadId: 7 });
    expect(adapter.getNativeTopicDestination(ISSUES_TOPIC_OFFSET + 7)).toEqual({ chatId: ISSUES, threadId: 7 });
    expect(adapter.getNativeTopicDestination(ISSUES_TOPIC_OFFSET + 1)).toEqual({ chatId: ISSUES, threadId: 1 });
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await adapter.send({ userId: 'u', content: 'actual issues dispatch', channel: { type: 'telegram', identifier: String(ISSUES_TOPIC_OFFSET + 7) } });
    const wire = bodies(f, 'sendMessage')[0];
    expect(adapter.getNativeTopicDestination(ISSUES_TOPIC_OFFSET + 7)).toEqual({ chatId: wire.chat_id, threadId: wire.message_thread_id });
  });

  it('has no wrong-main-group fallback when an issues destination is not configured', async () => {
    const mainOnly = new TelegramAdapter({ token: 't', chatId: MAIN }, tmpDir, { suppressLifelineAutoCreate: true });
    try {
      expect(mainOnly.getNativeTopicDestination(7)).toEqual({ chatId: MAIN, threadId: 7 });
      expect(mainOnly.getNativeTopicDestination(ISSUES_TOPIC_OFFSET + 7)).toBeNull();
      for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(mainOnly.getNativeTopicDestination(id)).toBeNull();
    } finally { await mainOnly.stop(); }
  });

  it('rejects a non-numeric issuesChatId', () => {
    expect(() => new TelegramAdapter({ token: 't', chatId: MAIN, issuesChatId: 'echo-bugs' }, tmpDir)).toThrow(/issuesChatId/);
  });

  it('creates an issue topic in the issues chat and returns an offset id', async () => {
    const f = okFetch({ message_thread_id: 7, name: 'Bug: X' });
    vi.stubGlobal('fetch', f);
    const t = await adapter.createForumTopic('Bug: X', undefined, { origin: 'user', space: 'issues' });
    expect(t.topicId).toBe(ISSUES_TOPIC_OFFSET + 7);
    expect(bodies(f, 'createForumTopic')[0].chat_id).toBe(ISSUES);
  });

  it('creates a normal topic in the main chat by default', async () => {
    const f = okFetch({ message_thread_id: 7, name: 'Chat' });
    vi.stubGlobal('fetch', f);
    const t = await adapter.createForumTopic('Chat', undefined, { origin: 'user' });
    expect(t.topicId).toBe(7);
    expect(bodies(f, 'createForumTopic')[0].chat_id).toBe(MAIN);
  });

  it('findOrCreate only reuses a name inside the same group', async () => {
    const f = okFetch({ message_thread_id: 7, name: 'Same' });
    vi.stubGlobal('fetch', f);
    await adapter.createForumTopic('Same', undefined, { origin: 'user' }); // main topic 7
    const issue = await adapter.findOrCreateForumTopic('Same', undefined, { origin: 'user', space: 'issues' });
    expect(issue.reused).toBe(false);
    expect(issue.topicId).toBe(ISSUES_TOPIC_OFFSET + 7);
    const again = await adapter.findOrCreateForumTopic('Same', undefined, { origin: 'user', space: 'issues' });
    expect(again.reused).toBe(true);
    expect(again.topicId).toBe(ISSUES_TOPIC_OFFSET + 7);
  });

  it('sends to an issues topic in the issues chat with the real thread id', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await adapter.send({ userId: 'u', content: 'hello bugs', channel: { type: 'telegram', identifier: String(ISSUES_TOPIC_OFFSET + 7) } });
    const b = bodies(f, 'sendMessage')[0];
    expect(b.chat_id).toBe(ISSUES);
    expect(b.message_thread_id).toBe(7);
  });

  it('leaves main-group sends unchanged', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await adapter.send({ userId: 'u', content: 'hi', channel: { type: 'telegram', identifier: '42' } });
    const b = bodies(f, 'sendMessage')[0];
    expect(b.chat_id).toBe(MAIN);
    expect(b.message_thread_id).toBe(42);
  });

  it('gives an inbound issues-group message its internal topic id', async () => {
    const received: Array<{ channel: { identifier: string } }> = [];
    adapter.onMessage(async (m) => { received.push(m as never); });
    let polled = 0;
    const f = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('getUpdates') && ++polled === 1) {
        return { ok: true, json: async () => ({ ok: true, result: [{
          update_id: 1,
          message: { message_id: 5, from: { id: 12345, first_name: 'J' }, chat: { id: Number(ISSUES) },
            message_thread_id: 7, text: 'bug report', date: Math.floor(Date.now() / 1000) },
        }] }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    });
    vi.stubGlobal('fetch', f);
    vi.spyOn(adapter, 'ensureLifelineTopic').mockResolvedValue(null);
    await adapter.start();
    await new Promise(r => setTimeout(r, 300));
    await adapter.stop();
    expect(received).toHaveLength(1);
    expect(received[0].channel.identifier).toBe(String(ISSUES_TOPIC_OFFSET + 7));
  });

  it('without an issues chat, refuses to send an issues-range id to the main group', async () => {
    const plain = new TelegramAdapter({ token: 'test-token-123', chatId: MAIN }, tmpDir);
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await expect(plain.send({ userId: 'u', content: 'x', channel: { type: 'telegram', identifier: String(ISSUES_TOPIC_OFFSET + 7) } }))
      .rejects.toThrow(/issues-chat-not-configured/);
    expect(bodies(f, 'sendMessage')).toHaveLength(0);
    await plain.stop();
  });
});
