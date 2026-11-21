/**
 * Guard for the 2026-11-21 Echo Studio freezes (fb-52447f16-7d3,
 * docs/specs/main-loop-freeze-conversation-list.md). The app's conversation list
 * called getTopicHistory(topicId, 1) once per topic; for a topic without a live
 * session each call was a synchronous read of the whole Telegram message log, so
 * a list of a few hundred closed topics blocked the event loop for 20-30 s.
 *
 * The bar: building the Telegram list rows for N topics reads the log ZERO times
 * on the caller's turn — not N times, not once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { Readable } from 'node:stream';
import { buildTelegramListRows } from '../../src/server/telegramListRows.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';

const N = 60;

function makeAdapter(dir: string): TelegramAdapter {
  return new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, dir);
}

function logMsg(adapter: TelegramAdapter, topicId: number, text: string, id: number): void {
  adapter.logInboundMessage({ messageId: id, topicId, text, timestamp: new Date(1700000000000 + id * 1000).toISOString() });
}

/** Reads of the message log through either sync reader the old path used. */
function logReadSpy(logPath: string) {
  const sync = vi.spyOn(fs, 'readFileSync');
  return () => sync.mock.calls.filter((c) => String(c[0]) === logPath).length;
}

describe('conversation list never reads the Telegram log per topic', () => {
  let dir: string;
  let writer: TelegramAdapter;
  let adapter: TelegramAdapter;
  let logPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-list-'));
    // A previous server life wrote history for N topics; this life has no live sessions for them.
    writer = makeAdapter(dir);
    let id = 1;
    for (let t = 1; t <= N; t++) {
      logMsg(writer, 1000 + t, `first in ${t}`, id++);
      logMsg(writer, 1000 + t, `last in ${t}`, id++);
    }
    await writer.stop();
    logPath = path.join(dir, 'telegram-messages.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    adapter = makeAdapter(dir);
    for (let t = 1; t <= N; t++) {
      // A named topic whose session has since closed: listed, but not in the live tail cache.
      adapter.registerTopicSession(1000 + t, `s-${t}`, `Planning notes ${t}`);
      adapter.unregisterTopic(1000 + t);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/telegram-conversation-list-no-log-scan.test.ts' });
  });

  const rows = (indexedLast?: (topicId: number) => { timestamp: string; text: string } | undefined) => buildTelegramListRows({
    mappings: () => adapter.getAllTopicMappings(),
    lastEntries: (ids) => adapter.getTopicLastEntries(ids),
    indexedLast: indexedLast ? () => indexedLast : undefined,
    displayName: (_id, name) => name,
    previewText: (t) => t,
  });

  it('lists N closed topics without one synchronous log read (the old path read it N times)', async () => {
    const reads = logReadSpy(logPath);
    const first = rows();
    expect(first).toHaveLength(N);
    expect(reads()).toBe(0);
    // The old producer, for contrast: one full read per topic.
    for (const m of adapter.getAllTopicMappings().slice(0, 3)) adapter.getTopicHistory(m.topicId, 1);
    expect(reads()).toBeGreaterThanOrEqual(3);
  });

  it('fills every preview once the streamed index is built, then stays read-free', async () => {
    rows();
    await adapter.buildLastEntryIndex();
    const reads = logReadSpy(logPath);
    const built = rows();
    expect(reads()).toBe(0);
    expect(built.find((r) => r.topicId === 1001)?.lastPreview).toBe('last in 1');
    expect(built.find((r) => r.topicId === 1000 + N)?.lastPreview).toBe(`last in ${N}`);
    expect(built.every((r) => typeof r.lastActivity === 'string')).toBe(true);
    expect(adapter.getTopicLastEntries([1001]).complete).toBe(true);
  });

  it('uses the indexed store for gaps while the index is still building, and not after', async () => {
    const indexed = vi.fn((topicId: number) => ({ timestamp: '2026-11-21T00:00:00.000Z', text: `indexed ${topicId}` }));
    const during = rows(indexed);
    expect(indexed).toHaveBeenCalled();
    expect(during.find((r) => r.topicId === 1001)?.lastPreview).toBe('indexed 1001');
    await adapter.buildLastEntryIndex();
    indexed.mockClear();
    const after = rows(indexed);
    expect(indexed).not.toHaveBeenCalled();
    expect(after.find((r) => r.topicId === 1001)?.lastPreview).toBe('last in 1');
  });

  it('a topic with no entry left in the log is still filled from the indexed store after the build', async () => {
    await adapter.buildLastEntryIndex();
    const indexed = vi.fn((topicId: number) => (topicId === 424242 ? { timestamp: '2026-01-01T00:00:00.000Z', text: 'rotated out of the log' } : undefined));
    const r = buildTelegramListRows({
      mappings: () => [{ topicId: 1001, topicName: 'a' }, { topicId: 424242, topicName: 'b' }],
      lastEntries: (ids) => adapter.getTopicLastEntries(ids),
      indexedLast: () => indexed,
      displayName: (_i, n) => n, previewText: (t) => t,
    });
    expect(r.map((x) => x.lastPreview)).toEqual(['last in 1', 'rotated out of the log']);
    expect(indexed).toHaveBeenCalledTimes(1);
  });

  it('a message logged during or after the build is the one shown, and survives unregisterTopic', async () => {
    const building = adapter.buildLastEntryIndex();
    logMsg(adapter, 1001, 'brand new', 9_000);
    await building;
    expect(rows().find((r) => r.topicId === 1001)?.lastPreview).toBe('brand new');
    adapter.registerTopicSession(1001, 's-again', 'Planning notes 1');
    adapter.unregisterTopic(1001);
    const reads = logReadSpy(logPath);
    expect(rows().find((r) => r.topicId === 1001)?.lastPreview).toBe('brand new');
    expect(reads()).toBe(0);
  });

  it('an unreadable log never certifies the index complete, so gap-fill keeps working', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-list-bad-'));
    fs.mkdirSync(path.join(badDir, 'telegram-messages.jsonl')); // a directory: every read fails (EISDIR)
    const bad = makeAdapter(badDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await bad.buildLastEntryIndex();
      expect(bad.getTopicLastEntries([1]).complete).toBe(false);
      // The retry is braked: list polls right after a failure start no new read.
      const opens = vi.spyOn(fs, 'createReadStream');
      for (let i = 0; i < 5; i++) bad.getTopicLastEntries([1]);
      expect(opens).not.toHaveBeenCalled();
      const fill = vi.fn(() => ({ timestamp: '2026-11-21T00:00:00.000Z', text: 'from the store' }));
      const r = buildTelegramListRows({ mappings: () => [{ topicId: 1, topicName: 'x' }], lastEntries: (ids) => bad.getTopicLastEntries(ids), indexedLast: () => fill, displayName: (_i, n) => n, previewText: (t) => t });
      expect(r[0].lastPreview).toBe('from the store');
    } finally {
      await bad.stop();
      SafeFsExecutor.safeRmSync(badDir, { recursive: true, force: true, operation: 'tests/unit/telegram-conversation-list-no-log-scan.test.ts' });
    }
  });

  it('a read that fails part-way is discarded whole, and the retry shows the newest entry', async () => {
    // Topic 1001's OLDER entry is in the first chunk; the stream dies before its newer one.
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const firstOf1001 = lines.find((l) => JSON.parse(l).topicId === 1001)!;
    const real = fs.createReadStream.bind(fs);
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementationOnce((() => Readable.from((async function* () {
      yield firstOf1001 + '\n';
      throw new Error('simulated read failure');
    })(), { objectMode: true })) as unknown as typeof fs.createReadStream);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await adapter.buildLastEntryIndex();
    expect(adapter.getTopicLastEntries([1001])).toEqual({ entries: new Map(), complete: false });
    spy.mockImplementation(real as typeof fs.createReadStream);
    await adapter.buildLastEntryIndex();
    const after = adapter.getTopicLastEntries([1001]);
    expect(after.complete).toBe(true);
    expect(after.entries.get(1001)?.text).toBe('last in 1');
  });

  it('a cold list of 500 topics gap-filled from a real TopicMemory stays well under the one-second goal', async () => {
    const tmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-list-tm-'));
    const tm = new TopicMemory(tmDir);
    try {
      await tm.open();
      if (!tm.isReady()) return; // no native sqlite in this checkout: covered by the other tests
      const ids = Array.from({ length: 500 }, (_, i) => 20_000 + i);
      tm.insertMessages(ids.flatMap((topicId, i) => Array.from({ length: 20 }, (_, k) => ({
        messageId: i * 100 + k, topicId, text: `m${k} of ${topicId}`, fromUser: k % 2 === 0, timestamp: new Date(1_700_000_000_000 + (i * 100 + k) * 1000).toISOString(), sessionName: null,
      }))));
      const started = performance.now();
      const r = buildTelegramListRows({
        mappings: () => ids.map((topicId) => ({ topicId, topicName: `t${topicId}` })),
        lastEntries: () => ({ entries: new Map(), complete: false }),
        indexedLast: () => (topicId) => tm.getRecentMessages(topicId, 1)[0],
        displayName: (_i, n) => n, previewText: (t) => t,
      });
      const elapsed = performance.now() - started;
      expect(r.find((x) => x.topicId === 20_000)?.lastPreview).toBe('m19 of 20000');
      expect(elapsed).toBeLessThan(500);
    } finally {
      tm.close();
      SafeFsExecutor.safeRmSync(tmDir, { recursive: true, force: true, operation: 'tests/unit/telegram-conversation-list-no-log-scan.test.ts' });
    }
  });

  it('the build is single-flight and a missing log is not an error', async () => {
    expect(adapter.buildLastEntryIndex()).toBe(adapter.buildLastEntryIndex());
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-list-empty-'));
    const empty = makeAdapter(emptyDir);
    try {
      await empty.buildLastEntryIndex();
      expect(empty.getTopicLastEntries([1, 2])).toEqual({ entries: new Map(), complete: true });
    } finally {
      await empty.stop();
      SafeFsExecutor.safeRmSync(emptyDir, { recursive: true, force: true, operation: 'tests/unit/telegram-conversation-list-no-log-scan.test.ts' });
    }
  });
});
