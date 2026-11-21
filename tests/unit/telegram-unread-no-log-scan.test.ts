/**
 * The conversation list's unread counts must not read the Telegram log synchronously either
 * (docs/specs/main-loop-freeze-conversation-list.md, round-2 review finding). The unread pass used
 * `getTopicHistory`, which for a topic whose tail is not loaded reads the whole log on the request's
 * turn. Now it reads the in-memory tail only: an unloaded topic answers "count unknown" for that
 * request and is loaded by ONE background streamed pass, after which the real count is served.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ConversationReadMarkerStore } from '../../src/core/ConversationReadMarkers.js';
import { ConversationUnreadService, type Reader } from '../../src/core/ConversationUnreadService.js';
import type { ResolvedPerson } from '../../src/core/MobilePeople.js';
import { cachedTelegramHistory } from '../../src/server/telegramListRows.js';

const owner: ResolvedPerson = { ok: true, role: 'owner', userId: null, name: 'Justin', telegramUserId: 42 };
const reader: Reader = { key: 'owner', person: owner, viaDevice: true };
const TOPIC = 3001;
const t = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();

let dir: string;
let adapter: TelegramAdapter;
let logPath: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-unread-'));
  // A previous server life's log: agent, owner, agent, agent in TOPIC (two agent rows after the
  // owner's last message are unread), plus noise in 50 other topics.
  const row = (messageId: number, topicId: number, text: string, fromUser: boolean, ms: number) =>
    JSON.stringify({ messageId, topicId, text, fromUser, timestamp: t(ms), sessionName: null, ...(fromUser ? { telegramUserId: 42 } : {}) });
  const lines = [row(1, TOPIC, 'a1', false, 100), row(2, TOPIC, 'o1', true, 200), row(3, TOPIC, 'a2', false, 300), row(4, TOPIC, 'a3', false, 400)];
  for (let i = 0; i < 50; i++) lines.push(row(100 + i, 9000 + i, 'noise', true, 500 + i));
  logPath = path.join(dir, 'telegram-messages.jsonl');
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await adapter.stop();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/telegram-unread-no-log-scan.test.ts' });
});

function service() {
  const store = new ConversationReadMarkerStore({ stateDir: dir });
  store.markCatchUpSettled();
  const svc = new ConversationUnreadService({
    store, enabled: () => true, machineId: () => 'm1', app: null as never,
    telegram: { history: cachedTelegramHistory(adapter) as never, version: (id) => adapter.getTopicContentVersion(id), exists: () => true },
    ownerIdentity: () => ({ ownerName: 'Justin', telegramOwnerId: 42, slackOwnerUserId: null }),
    personOfReaderKey: (key) => (key === 'owner' ? owner : null),
    mayUse: () => true, authToken: () => 'tok', now: () => Date.parse(t(10_000)),
  });
  store.setBaseline('owner', 0);
  return { svc, store };
}

describe('unread counts on the conversation list never read the Telegram log synchronously', () => {
  it('a cold topic answers "unknown" with zero sync reads, then the real count after one background load', async () => {
    const { svc } = service();
    const reads = vi.spyOn(fs, 'readFileSync');
    const logReads = () => reads.mock.calls.filter((c) => String(c[0]) === logPath).length;
    const warm = vi.spyOn(adapter, 'warmTopicTails');

    const cold = svc.rowFields(reader, { platform: 'telegram', id: TOPIC, lastActivity: t(400) });
    expect(cold).toEqual({ hasUnread: true, readUpTo: { atMs: 0, id: '' } });
    expect(logReads()).toBe(0);
    expect(warm).toHaveBeenCalledWith([TOPIC]);

    await adapter.warmTopicTails([]);
    const loaded = adapter.getCachedTopicHistory(TOPIC, 100);
    expect(loaded?.map((e) => e.messageId)).toEqual([1, 2, 3, 4]);
    const warmed = svc.rowFields(reader, { platform: 'telegram', id: TOPIC, lastActivity: t(400) });
    expect(warmed?.hasUnread).toBe(true);
    expect(warmed?.unreadCount).toBe(2);
    expect(logReads()).toBe(0);
    svc.stop();
  });

  it('a fully-read cold topic does not flash an unread dot while its tail loads', () => {
    const { svc, store } = service();
    store.advance('owner', `telegram:${TOPIC}`, { atMs: Date.parse(t(400)), id: 'out:4' });
    const fields = svc.rowFields(reader, { platform: 'telegram', id: TOPIC, lastActivity: t(400) });
    expect(fields).toEqual({ hasUnread: false, unreadCount: 0, readUpTo: { atMs: Date.parse(t(400)), id: 'out:4' } });
    svc.stop();
  });

  it('a message logged while the topic is loading is kept, and an already-loaded tail is never replaced', async () => {
    const loading = adapter.warmTopicTails([TOPIC]);
    adapter.logInboundMessage({ messageId: 77, topicId: TOPIC, text: 'during the load', timestamp: t(900), telegramUserId: 42 } as never);
    await loading;
    const rows = adapter.getCachedTopicHistory(TOPIC, 500)!;
    expect(rows.filter((r) => r.messageId === 77)).toHaveLength(1);
    expect(rows.at(-1)?.messageId).toBe(77);
    const before = adapter.getCachedTopicHistory(TOPIC, 500)!.length;
    await adapter.warmTopicTails([TOPIC]); // already loaded: no-op
    expect(adapter.getCachedTopicHistory(TOPIC, 500)!.length).toBe(before);
  });

  it('many cold topics share one streamed pass', async () => {
    const opens = vi.spyOn(fs, 'createReadStream');
    const p1 = adapter.warmTopicTails([9000, 9001, 9002]);
    const p2 = adapter.warmTopicTails([9003]);
    await Promise.all([p1, p2]);
    expect(opens.mock.calls.length).toBeLessThanOrEqual(2);
    for (const id of [9000, 9001, 9002, 9003]) expect(adapter.getCachedTopicHistory(id, 5)?.[0]?.text).toBe('noise');
  });

  it('a failed load leaves topics unloaded and brakes the next attempt', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-unread-bad-'));
    fs.mkdirSync(path.join(badDir, 'telegram-messages.jsonl'));
    const bad = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, badDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await bad.warmTopicTails([1]);
      expect(bad.getCachedTopicHistory(1, 10)).toBeNull();
      const opens = vi.spyOn(fs, 'createReadStream');
      await bad.warmTopicTails([1]);
      expect(opens).not.toHaveBeenCalled();
    } finally {
      await bad.stop();
      SafeFsExecutor.safeRmSync(badDir, { recursive: true, force: true, operation: 'tests/unit/telegram-unread-no-log-scan.test.ts' });
    }
  });
});
