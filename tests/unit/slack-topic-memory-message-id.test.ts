/**
 * Slack message ids in TopicMemory.
 *
 * The defect: the Slack dual-write derived `messageId` as
 * `typeof entry.messageId === 'number' ? entry.messageId : 0`. A Slack `ts` is
 * a string ("1730000000.123456"), so every Slack message bound 0. TopicMemory
 * enforces UNIQUE(message_id, topic_id) and inserts with INSERT OR IGNORE, so
 * the first message in a channel persisted and every later one was dropped —
 * permanently: Slack's own JSONL is never re-imported (importFromJsonl needs a
 * `topicId`, which Slack entries do not carry) and the outbound path never
 * appends.
 *
 * Measured on two live databases before the fix: every inbound Slack row
 * (from_user = 1) had message_id = 0, and each Slack channel held exactly one
 * such row.
 *
 * Slack rows live under a negative synthetic topic id (slackChannelToSyntheticId
 * negates a hash so Slack can never collide with a Telegram topic). These tests
 * use a fixed negative id directly: the defect is a collision on message_id
 * within one topic, so re-deriving the hash here would add nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  slackEntryMessageId,
  slackTsToMessageId,
  MAX_EXACT_TS_SECONDS,
} from '../../src/messaging/slack/slackMessageId.js';

/** The derivation this fix replaced — kept so the tests can prove they discriminate. */
function legacyMessageId(entry: { messageId: number | string }): number {
  return typeof entry.messageId === 'number' ? entry.messageId : 0;
}

const SLACK_TOPIC_ID = -1024314727; // shape of a real synthetic Slack id

function slackEntry(ts: string, text: string, fromUser = true) {
  return {
    messageId: ts,
    text,
    fromUser,
    timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
    sessionName: null,
    senderName: 'justin',
  };
}

describe('slackTsToMessageId', () => {
  it('converts a Slack ts to exact microseconds', () => {
    expect(slackTsToMessageId('1730000000.123456')).toBe(1730000000123456);
  });

  it('is exact where a float multiply would round', () => {
    // parseFloat('1730000000.123456') * 1e6 does not land on the integer below.
    expect(slackTsToMessageId('1730000000.123456')).toBe(1730000000 * 1_000_000 + 123456);
    expect(Number.isSafeInteger(slackTsToMessageId('1730000000.123456')!)).toBe(true);
  });

  it('pads a short fraction and truncates a long one to microseconds', () => {
    expect(slackTsToMessageId('1730000000.5')).toBe(1730000000500000);
    expect(slackTsToMessageId('1730000000.000001')).toBe(1730000000000001);
    expect(slackTsToMessageId('1730000000.1234567')).toBe(1730000000123456);
  });

  it('accepts a ts with no fraction', () => {
    expect(slackTsToMessageId('1730000000')).toBe(1730000000000000);
  });

  it('increases with send order', () => {
    const a = slackTsToMessageId('1730000000.000001')!;
    const b = slackTsToMessageId('1730000000.000002')!;
    const c = slackTsToMessageId('1730000001.000000')!;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('returns null rather than a rounded id for a non-ts or an inexact ts', () => {
    expect(slackTsToMessageId('')).toBeNull();
    expect(slackTsToMessageId('not-a-ts')).toBeNull();
    expect(slackTsToMessageId('17300.00.1')).toBeNull();
    expect(slackTsToMessageId('-1730000000.1')).toBeNull();
    expect(slackTsToMessageId(String(MAX_EXACT_TS_SECONDS + 1))).toBeNull();
  });

  it('stays exact at the documented upper bound, worst-case fraction included', () => {
    // Regression on an off-by-one in the bound itself: an earlier version used
    // floor(MAX_SAFE_INTEGER / 1e6), which admits a ts whose `.999999` form
    // overflows into rounding — a silent id collision.
    const id = slackTsToMessageId(`${MAX_EXACT_TS_SECONDS}.999999`);
    expect(id).not.toBeNull();
    expect(Number.isSafeInteger(id!)).toBe(true);

    // Pins the value, so a change to the formula cannot loosen it unnoticed.
    expect(MAX_EXACT_TS_SECONDS).toBe(9007199253);
    expect(Number.isSafeInteger((MAX_EXACT_TS_SECONDS + 1) * 1_000_000 + 999999)).toBe(false);
  });
});

describe('slackEntryMessageId', () => {
  it('derives a distinct id per message from the ts', () => {
    const a = slackEntryMessageId(slackEntry('1730000000.000100', 'first'));
    const b = slackEntryMessageId(slackEntry('1730000000.000200', 'second'));
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('passes a numeric messageId through unchanged', () => {
    expect(slackEntryMessageId({ messageId: 51552 })).toBe(51552);
  });

  it('falls back to the entry timestamp when the ts is malformed', () => {
    const id = slackEntryMessageId({
      messageId: 'not-a-ts',
      timestamp: '2026-11-04T12:00:00.000Z',
    });
    expect(id).toBe(Date.parse('2026-11-04T12:00:00.000Z') * 1000);
    expect(id).not.toBe(0);
  });

  it('keeps two malformed-ts messages distinct via their timestamps', () => {
    const a = slackEntryMessageId({ messageId: 'bad', timestamp: '2026-11-04T12:00:00.000Z' });
    const b = slackEntryMessageId({ messageId: 'bad', timestamp: '2026-11-04T12:00:01.000Z' });
    expect(a).not.toBe(b);
  });

  it('returns 0 only when neither the ts nor a timestamp can be read', () => {
    expect(slackEntryMessageId({ messageId: 'bad' })).toBe(0);
    expect(slackEntryMessageId({ messageId: 'bad', timestamp: 'also-bad' })).toBe(0);
  });
});

describe('TopicMemory persistence of Slack messages', () => {
  let tmpDir: string;
  let topicMemory: TopicMemory;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-topic-memory-'));
    topicMemory = new TopicMemory(tmpDir);
    await topicMemory.open();
  });

  afterEach(() => {
    topicMemory.close();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true,
      operation: 'tests/unit/slack-topic-memory-message-id.test.ts',
    });
  });

  const first = slackEntry('1730000000.000100', 'can you check the status of the website?');
  const second = slackEntry('1730000042.000200', 'and the staging one too');

  it('keeps BOTH messages sent to one Slack channel', () => {
    for (const entry of [first, second]) {
      topicMemory.insertMessage({ ...entry, messageId: slackEntryMessageId(entry), topicId: SLACK_TOPIC_ID });
    }

    const stored = topicMemory.getRecentMessages(SLACK_TOPIC_ID, 10);
    expect(stored).toHaveLength(2);
    expect(stored.map(m => m.text).sort()).toEqual([first.text, second.text].sort());
    expect(new Set(stored.map(m => m.messageId)).size).toBe(2);
    expect(stored.every(m => m.messageId > 0)).toBe(true);
  });

  it('POSITIVE CONTROL: the derivation this replaced keeps only the first', () => {
    for (const entry of [first, second]) {
      topicMemory.insertMessage({ ...entry, messageId: legacyMessageId(entry), topicId: SLACK_TOPIC_ID });
    }

    // Proves the test above discriminates: same two messages, same store, the
    // old id derivation loses one. Without this, the test could pass against
    // the bug it exists to catch.
    const stored = topicMemory.getRecentMessages(SLACK_TOPIC_ID, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe(first.text);
    expect(stored[0].messageId).toBe(0);
  });

  it('keeps two messages sent inside the SAME second', () => {
    // The realistic rapid case, and the one that a derivation using only whole
    // seconds would silently collapse while still passing the tests above.
    const a = slackEntry('1730000000.000100', 'wait');
    const b = slackEntry('1730000000.000200', 'one more thing');
    expect(Math.floor(parseFloat(a.messageId))).toBe(Math.floor(parseFloat(b.messageId)));

    for (const entry of [a, b]) {
      topicMemory.insertMessage({ ...entry, messageId: slackEntryMessageId(entry), topicId: SLACK_TOPIC_ID });
    }
    expect(topicMemory.getMessageCount(SLACK_TOPIC_ID)).toBe(2);
  });

  it('keeps a whole channel conversation, not one message per channel', () => {
    const conversation = Array.from({ length: 25 }, (_, i) =>
      slackEntry(`17300000${String(i).padStart(2, '0')}.000100`, `message ${i}`, i % 2 === 0));

    for (const entry of conversation) {
      topicMemory.insertMessage({ ...entry, messageId: slackEntryMessageId(entry), topicId: SLACK_TOPIC_ID });
    }

    expect(topicMemory.getMessageCount(SLACK_TOPIC_ID)).toBe(25);
  });

  it('stays idempotent — re-inserting the same message does not duplicate it', () => {
    for (const pass of [1, 2]) {
      void pass;
      for (const entry of [first, second]) {
        topicMemory.insertMessage({ ...entry, messageId: slackEntryMessageId(entry), topicId: SLACK_TOPIC_ID });
      }
    }
    expect(topicMemory.getMessageCount(SLACK_TOPIC_ID)).toBe(2);
  });

  it('orders ids so incremental summarisation sees later messages as new', () => {
    // getMessagesSinceSummary selects WHERE message_id > lastMessageId, so a
    // hashed id would satisfy UNIQUE and still drop messages from this read.
    const firstId = slackEntryMessageId(first);
    const secondId = slackEntryMessageId(second);
    expect(secondId).toBeGreaterThan(firstId);

    for (const entry of [first, second]) {
      topicMemory.insertMessage({ ...entry, messageId: slackEntryMessageId(entry), topicId: SLACK_TOPIC_ID });
    }
    topicMemory.saveTopicSummary(SLACK_TOPIC_ID, 'summary so far', 1, firstId);

    const since = topicMemory.getMessagesSinceSummary(SLACK_TOPIC_ID);
    expect(since.map(m => m.text)).toEqual([second.text]);
  });
});
