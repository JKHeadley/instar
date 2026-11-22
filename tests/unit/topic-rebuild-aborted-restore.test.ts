/**
 * Regression — a rebuild that cannot finish its restore must not leave the
 * store empty (PROP-1646).
 *
 * `rebuild()` already refuses to delete when its pre-flight scan
 * (`countRestorable`) finds nothing a source could restore. The pre-flight
 * streams every line through `parseLogLine`, the SAME predicate the importer
 * uses, so the count is the number the import would land. That is the property
 * the guard rests on, and it had a hole:
 *
 *   `parseLogLine` modelled the PARSER, not the TABLE. It admitted a line on
 *   `entry.text` and a usable key alone, and never looked at `timestamp` —
 *   which `messages.timestamp` and `topic_meta.last_activity` both declare
 *   NOT NULL. So a line of that shape was counted as restorable, the delete
 *   ran on the strength of the count, and the import then threw out of
 *   `insertMessage`'s `topic_meta` upsert AFTER every row was gone.
 *
 * Two independent properties are pinned here, because closing only the first
 * would leave the destructive step trusting that nothing else can ever throw:
 *
 *   1. ADMISSION AGREES WITH THE SCHEMA — a line missing a column the table
 *      requires is `missing-fields` to both the pre-flight and the import, so
 *      the count stays a promise the import can keep. One predicate, as the
 *      code already treats as load-bearing.
 *   2. THE DELETE IS REVERSIBLE — whatever makes the restore throw, the rows
 *      that were in the store are in it again afterwards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory, topicMemoryKeyForLogEntry } from '../../src/memory/TopicMemory.js';
import { slackSyntheticTopicId } from '../../src/memory/topicRowCarrier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CHANNEL = 'C0BUT8WEJ3A';
const OP = 'tests/unit/topic-rebuild-aborted-restore.test.ts';

/** One row exactly as the Slack message logger writes it. */
function slackRow(messageId: string, text: string): Record<string, unknown> {
  const seconds = Number(messageId.split('.')[0]);
  return {
    messageId,
    channelId: CHANNEL,
    text,
    fromUser: true,
    timestamp: new Date(seconds * 1000).toISOString(),
    sessionName: null,
    senderName: 'A Person',
    platformUserId: 'U07SOMEONE',
    platform: 'slack',
  };
}

/**
 * The same row with no `timestamp` key at all — the measured shape. Nothing
 * between the live logger and this store rejects it: it carries `text` and a
 * key the §14 rule accepts, which is everything the old admission test asked.
 */
function slackRowWithoutTimestamp(messageId: string, text: string): Record<string, unknown> {
  const row = slackRow(messageId, text);
  delete row.timestamp;
  return row;
}

const TELEGRAM_ROWS = [
  { messageId: 11, topicId: 4242, text: 'telegram one', fromUser: true, timestamp: '2026-11-05T01:00:00Z', sessionName: null },
  { messageId: 12, topicId: 4242, text: 'telegram two', fromUser: false, timestamp: '2026-11-05T01:01:00Z', sessionName: 's' },
];

function writeJsonl(file: string, rows: unknown[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('TopicMemory.rebuild() — a restore that cannot finish keeps the rows', () => {
  let tmpDir: string;
  let tm: TopicMemory;
  let slackLog: string;
  let telegramLog: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-rebuild-abort-'));
    slackLog = path.join(tmpDir, 'slack-messages.jsonl');
    telegramLog = path.join(tmpDir, 'telegram-messages.jsonl');
    tm = new TopicMemory(tmpDir);
    await tm.open();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tm.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: OP });
  });

  // ── the fixture is admissible to the parser and inadmissible to the table ──

  it('CONTROL: the timestamp-less row reaches a usable key, and no store ever holds it', async () => {
    const row = slackRowWithoutTimestamp('1762300000.000100', 'no timestamp on this one');
    expect(row.timestamp).toBeUndefined();
    // Admissible: it has text, and the shipped key rule gives it a key.
    expect(row.text).toBeTruthy();
    expect(topicMemoryKeyForLogEntry(row as any).kind).toBe('slack');

    // Inadmissible to the table: whatever the import does with it — throw, or
    // count it and move on — the row is never stored. That is what makes
    // counting it as "restorable" a promise no import could keep.
    writeJsonl(slackLog, [row]);
    await tm.importAllLogs(telegramLog).catch(() => undefined);
    expect(tm.stats().totalMessages).toBe(0);
  });

  // ── property 1: admission agrees with the schema ───────────────────────────

  it('refuses to delete when every line the sources hold lacks a required column', async () => {
    // The store holds real rows, written by the live path's own key rule.
    writeJsonl(slackLog, [slackRow('1762300000.000100', 'a kept message')]);
    await tm.importAllLogs(telegramLog);
    const before = tm.stats().totalMessages;
    expect(before).toBe(1);

    // The log is then replaced by lines of the measured shape only.
    writeJsonl(slackLog, [
      slackRowWithoutTimestamp('1762300100.000100', 'no timestamp'),
      slackRowWithoutTimestamp('1762300200.000100', 'also none'),
    ]);

    expect(await tm.rebuild(telegramLog)).toBe(0);
    expect(tm.stats().totalMessages).toBe(before);
    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(true);
    expect(report.reason).toBe('sources-hold-no-restorable-message');
    expect(report.restorable).toBe(0);
    expect(report.deleted).toBe(0);
  });

  it('counts a timestamp-less line as missing-fields instead of importing it', async () => {
    writeJsonl(slackLog, [slackRowWithoutTimestamp('1762300000.000100', 'no timestamp')]);
    expect(await tm.importFromJsonl(slackLog)).toBe(0);
    const stats = tm.getLastImportStats()!;
    expect(stats.missingFields).toBe(1);
    expect(stats.imported).toBe(0);
  });

  it('the pre-flight count is the number the import actually lands', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, [
      slackRow('1762300000.000100', 'first'),
      slackRowWithoutTimestamp('1762300100.000100', 'no timestamp'),
      slackRow('1762300200.000100', 'third'),
    ]);
    await tm.importAllLogs(telegramLog);
    const landed = tm.stats().totalMessages;

    const restored = await tm.rebuild(telegramLog);
    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(false);
    // The count the delete was authorised on, and the rows that came back.
    expect(report.restorable).toBe(landed);
    expect(restored).toBe(landed);
    expect(tm.stats().totalMessages).toBe(landed);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL))).toBe(2);
  });

  it('deletes and restores normally when every line is admissible', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, [slackRow('1762300000.000100', 'kept')]);
    await tm.importAllLogs(telegramLog);
    const before = tm.stats().totalMessages;

    expect(await tm.rebuild(telegramLog)).toBe(before);
    expect(tm.stats().totalMessages).toBe(before);
    expect(tm.getLastRebuildReport()!.refused).toBe(false);
  });

  // ── property 2: the delete is reversible, whatever threw ───────────────────

  it('restores every pre-existing row when the import throws part-way through', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, [
      slackRow('1762300000.000100', 'slack one'),
      slackRow('1762300100.000100', 'slack two'),
    ]);
    await tm.importAllLogs(telegramLog);

    const before = tm.stats().totalMessages;
    const beforeIds = tm.getRecentMessages(4242, 50).map((m) => m.messageId).sort();
    expect(before).toBe(4);

    // A failure with no connection to the admission rule: the restore gets
    // part of the way, then throws. Nothing about property 1 covers this.
    vi.spyOn(tm, 'importAllLogs').mockImplementation(async () => {
      await TopicMemory.prototype.importFromJsonl.call(tm, slackLog);
      throw new Error('simulated mid-restore failure');
    });

    await expect(tm.rebuild(telegramLog)).rejects.toThrow('simulated mid-restore failure');

    // Exactly the rows that were there: not none, and not a partial import.
    expect(tm.stats().totalMessages).toBe(before);
    expect(tm.getRecentMessages(4242, 50).map((m) => m.messageId).sort()).toEqual(beforeIds);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL))).toBe(2);

    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(true);
    expect(report.reason).toBe('restore-failed-rolled-back');
    expect(report.deleted).toBe(0);
    expect(report.restored).toBe(0);
  });

  it('a restored store is searchable again — the FTS index comes back with the rows', async () => {
    writeJsonl(telegramLog, [
      { ...TELEGRAM_ROWS[0], text: 'a distinctive phrase worth finding' },
    ]);
    await tm.importAllLogs(telegramLog);
    expect(tm.search('distinctive').length).toBe(1);

    vi.spyOn(tm, 'importAllLogs').mockRejectedValue(new Error('simulated mid-restore failure'));
    await expect(tm.rebuild(telegramLog)).rejects.toThrow('simulated mid-restore failure');

    expect(tm.stats().totalMessages).toBe(1);
    expect(tm.search('distinctive').length).toBe(1);
  });

  it('keeps summaries across a rolled-back rebuild', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    await tm.importAllLogs(telegramLog);
    tm.saveTopicSummary(4242, 'what this topic is about', 2, 0);

    vi.spyOn(tm, 'importAllLogs').mockRejectedValue(new Error('simulated mid-restore failure'));
    await expect(tm.rebuild(telegramLog)).rejects.toThrow('simulated mid-restore failure');

    expect(tm.getTopicSummary(4242)!.summary).toBe('what this topic is about');
    expect(tm.stats().totalMessages).toBe(TELEGRAM_ROWS.length);
  });
});
