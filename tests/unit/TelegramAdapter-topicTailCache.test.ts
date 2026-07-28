/**
 * Tier-1 tests for the TelegramAdapter per-topic tail cache + content version —
 * the 2026-06-05 event-loop-stall fix. Pre-fix, getTopicHistory synchronously
 * re-read the full (up to 75k-line) JSONL message log on EVERY call, and the
 * live-tail streamer called it for every known topic every 5 seconds: measured
 * 5–40s event-loop blocks on the live Laptop. Post-fix:
 *
 *   - getTopicContentVersion is a cheap monotonic change signal (bumped per
 *     logged message) the streamer polls instead of serializing content.
 *   - getTopicHistory serves from an in-memory cache after a ONE-TIME batch
 *     seed (single file pass for all live topics), maintained on every append —
 *     no per-call file reads.
 *
 * Correctness bar: cache-served history must be byte-equivalent to what a
 * fresh file scan would return (the handoff hash depends on it).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeAdapter(tmpDir: string): TelegramAdapter {
  return new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, tmpDir);
}

function logMsg(adapter: TelegramAdapter, topicId: number, text: string, id: number): void {
  adapter.logInboundMessage({
    messageId: id,
    topicId,
    text,
    timestamp: new Date(1700000000000 + id * 1000).toISOString(),
  });
}

describe('TelegramAdapter topic tail cache + content version', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-tail-'));
    adapter = makeAdapter(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/TelegramAdapter-topicTailCache.test.ts' });
  });

  describe('getTopicContentVersion (the cheap change signal)', () => {
    it('starts at 0 and bumps once per logged message, per topic', () => {
      expect(adapter.getTopicContentVersion(42)).toBe(0);
      logMsg(adapter, 42, 'one', 1);
      expect(adapter.getTopicContentVersion(42)).toBe(1);
      logMsg(adapter, 42, 'two', 2);
      logMsg(adapter, 99, 'other topic', 3);
      expect(adapter.getTopicContentVersion(42)).toBe(2);
      expect(adapter.getTopicContentVersion(99)).toBe(1);
    });
  });

  describe('getTopicHistory cache behavior', () => {
    it('returns logged messages in order without re-reading the log file per call', () => {
      logMsg(adapter, 42, 'first', 1);
      logMsg(adapter, 42, 'second', 2);

      const spy = vi.spyOn(fs, 'readFileSync');
      const h1 = adapter.getTopicHistory(42, 10);
      expect(h1.map((e) => e.text)).toEqual(['first', 'second']);
      const readsAfterFirst = spy.mock.calls.length;

      // Repeated reads + an interleaved append must NOT hit the file again.
      adapter.getTopicHistory(42, 10);
      logMsg(adapter, 42, 'third', 3);
      const h2 = adapter.getTopicHistory(42, 10);
      expect(h2.map((e) => e.text)).toEqual(['first', 'second', 'third']);
      expect(spy.mock.calls.length).toBe(readsAfterFirst);
    });

    it('respects the limit (returns the most recent N)', () => {
      for (let i = 1; i <= 5; i++) logMsg(adapter, 7, `m${i}`, i);
      expect(adapter.getTopicHistory(7, 2).map((e) => e.text)).toEqual(['m4', 'm5']);
    });

    it('seeds from a pre-existing JSONL written by a prior process', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const lines = [
        { messageId: 1, topicId: 5, text: 'old-a', fromUser: true, timestamp: '2026-01-01T00:00:00Z' },
        { messageId: 2, topicId: 6, text: 'other-topic', fromUser: true, timestamp: '2026-01-01T00:00:01Z' },
        { messageId: 3, topicId: 5, text: 'old-b', fromUser: false, timestamp: '2026-01-01T00:00:02Z' },
      ];
      fs.appendFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

      const fresh = makeAdapter(tmpDir);
      expect(fresh.getTopicHistory(5, 10).map((e) => e.text)).toEqual(['old-a', 'old-b']);
      // Appends continue the seeded tail seamlessly.
      logMsg(fresh, 5, 'new-c', 4);
      expect(fresh.getTopicHistory(5, 10).map((e) => e.text)).toEqual(['old-a', 'old-b', 'new-c']);
    });

    it('batch-seeds ALL live topics in a single file pass (one read, not one per topic)', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      const lines = [
        { messageId: 1, topicId: 10, text: 'a', fromUser: true, timestamp: '2026-01-01T00:00:00Z' },
        { messageId: 2, topicId: 11, text: 'b', fromUser: true, timestamp: '2026-01-01T00:00:01Z' },
        { messageId: 3, topicId: 12, text: 'c', fromUser: true, timestamp: '2026-01-01T00:00:02Z' },
      ];
      fs.appendFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

      const fresh = makeAdapter(tmpDir);
      // Live topics = registered sessions (what the live-tail streamer enumerates).
      fresh.registerTopicSession(10, 's10');
      fresh.registerTopicSession(11, 's11');
      fresh.registerTopicSession(12, 's12');

      const spy = vi.spyOn(fs, 'readFileSync');
      fresh.getTopicHistory(10, 500);
      const logReads = () => spy.mock.calls.filter((c) => String(c[0]).endsWith('telegram-messages.jsonl')).length;
      expect(logReads()).toBe(1);
      // The other live topics were seeded by that same pass — zero further reads.
      expect(fresh.getTopicHistory(11, 500).map((e) => e.text)).toEqual(['b']);
      expect(fresh.getTopicHistory(12, 500).map((e) => e.text)).toEqual(['c']);
      expect(logReads()).toBe(1);
    });

    it('accepts shared-MessageLogger lines (channelId instead of topicId) when seeding', () => {
      const logPath = path.join(tmpDir, 'telegram-messages.jsonl');
      fs.appendFileSync(
        logPath,
        JSON.stringify({ messageId: 1, channelId: 21, text: 'shared-writer', fromUser: true, timestamp: '2026-01-01T00:00:00Z' }) + '\n',
      );
      const fresh = makeAdapter(tmpDir);
      expect(fresh.getTopicHistory(21, 10).map((e) => e.text)).toEqual(['shared-writer']);
    });

    it('caps the cached tail at 500 entries (the production caller ceiling)', () => {
      for (let i = 1; i <= 510; i++) logMsg(adapter, 3, `m${i}`, i);
      const h = adapter.getTopicHistory(3, 500);
      expect(h).toHaveLength(500);
      expect(h[0].text).toBe('m11'); // oldest 10 evicted
      expect(h[499].text).toBe('m510');
    });

    it('CORRECTNESS: cache-served history equals a fresh file scan (handoff-hash parity)', () => {
      for (let i = 1; i <= 5; i++) logMsg(adapter, 8, `msg-${i}`, i);
      const cacheServed = adapter.getTopicHistory(8, 500);
      // A brand-new adapter over the same state dir has no cache — its first
      // read is the file path. Both must agree byte-for-byte.
      // NOTE: this full-object equality is STRICTER than the handoff hash
      // actually requires (hashTopicHistory reads only timestamp + text). It
      // holds on the legacy-logger path exercised here; if the shared
      // MessageLogger flag is ever enabled, file lines take the channelId
      // shape and this assertion would need to relax to the hashed fields —
      // that would NOT be a real hash regression.
      const fileServed = makeAdapter(tmpDir).getTopicHistory(8, 500);
      expect(JSON.stringify(cacheServed)).toBe(JSON.stringify(fileServed));
    });
  });
});
