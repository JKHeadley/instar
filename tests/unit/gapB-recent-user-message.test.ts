/**
 * Part D (spec: autonomous-registration-guarantee.md) — recentUserMessage promotion.
 *
 * The reaper's `recentUserMessage` dep was a v1 STUB (`() => false`), which made
 * ReapGuard's open-commitment KEEP-veto INERT and (had GAP-B reused it) would have
 * made the GAP-B D8 check always-false. Part D promotes it to a REAL inbound-user-
 * message recency query over TelegramAdapter.getTopicHistory (the SYNC in-memory
 * LogEntry tail cache — NOT the Threadline A2A MessageStore). These tests pin:
 *  - the inbound-USER filter (LogEntry.fromUser === true; agent/system echoes skipped)
 *  - the window boundary (both sides)
 *  - integration with a REAL TelegramAdapter.getTopicHistory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { recentUserMessageFromHistory } from '../../src/core/gapBCommitmentEvidence.js';

const NOW = 1_700_000_000_000;
const WINDOW = 8 * 60 * 60_000; // 8h

describe('Part D — recentUserMessageFromHistory (pure inbound-user recency)', () => {
  it('a recent INBOUND USER message within the window ⇒ true', () => {
    const history = [{ fromUser: true, timestamp: new Date(NOW - 60 * 60_000).toISOString() }];
    expect(recentUserMessageFromHistory(history, WINDOW, NOW)).toBe(true);
  });

  it('a user message OUTSIDE the window ⇒ false (boundary, older side)', () => {
    const history = [{ fromUser: true, timestamp: new Date(NOW - 9 * 60 * 60_000).toISOString() }];
    expect(recentUserMessageFromHistory(history, WINDOW, NOW)).toBe(false);
  });

  it('only AGENT (fromUser:false) entries in-window ⇒ false (the inbound-user filter)', () => {
    const history = [
      { fromUser: false, timestamp: new Date(NOW - 1 * 60_000).toISOString() }, // agent echo, very recent
      { fromUser: false, timestamp: new Date(NOW - 2 * 60_000).toISOString() },
    ];
    expect(recentUserMessageFromHistory(history, WINDOW, NOW)).toBe(false);
  });

  it('uses the NEWEST user entry as the verdict (a recent agent echo after an old user msg does not count)', () => {
    const history = [
      { fromUser: true, timestamp: new Date(NOW - 9 * 60 * 60_000).toISOString() }, // old user msg
      { fromUser: false, timestamp: new Date(NOW - 1 * 60_000).toISOString() }, // recent agent echo
    ];
    expect(recentUserMessageFromHistory(history, WINDOW, NOW)).toBe(false);
  });

  it('a fresh user msg after older agent chatter ⇒ true', () => {
    const history = [
      { fromUser: false, timestamp: new Date(NOW - 10 * 60 * 60_000).toISOString() },
      { fromUser: true, timestamp: new Date(NOW - 30 * 60_000).toISOString() }, // fresh user msg
    ];
    expect(recentUserMessageFromHistory(history, WINDOW, NOW)).toBe(true);
  });

  it('empty history ⇒ false', () => {
    expect(recentUserMessageFromHistory([], WINDOW, NOW)).toBe(false);
  });

  it('a non-parseable timestamp is skipped, not a false positive', () => {
    const history = [{ fromUser: true, timestamp: 'not-a-date' }];
    expect(recentUserMessageFromHistory(history, WINDOW, NOW)).toBe(false);
  });
});

describe('Part D — integration with a REAL TelegramAdapter.getTopicHistory', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;
  const TOPIC = 555;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gapb-rum-'));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, tmpDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/gapB-recent-user-message.test.ts' });
  });

  it('reports a recent logged inbound user message as recent', () => {
    adapter.logInboundMessage({ messageId: 1, topicId: TOPIC, text: 'hello', timestamp: new Date(Date.now() - 5 * 60_000).toISOString() });
    const history = adapter.getTopicHistory(TOPIC, 50);
    expect(history.some((e) => e.fromUser)).toBe(true);
    expect(recentUserMessageFromHistory(history, WINDOW)).toBe(true);
  });

  it('an old logged inbound user message is NOT recent within the window', () => {
    adapter.logInboundMessage({ messageId: 1, topicId: TOPIC, text: 'old', timestamp: new Date(Date.now() - 9 * 60 * 60_000).toISOString() });
    const history = adapter.getTopicHistory(TOPIC, 50);
    expect(recentUserMessageFromHistory(history, WINDOW)).toBe(false);
  });

  it('a topic with no messages ⇒ not recent', () => {
    const history = adapter.getTopicHistory(TOPIC, 50);
    expect(recentUserMessageFromHistory(history, WINDOW)).toBe(false);
  });
});
