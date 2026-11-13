/**
 * Slack history in TopicMemory: importable, and no longer destroyable by a rebuild.
 *
 * Two defects, one gap. `importFromJsonl` admits an entry only when it carries
 * `entry.topicId`; Slack's logger writes `channelId` and never `topicId`, so
 * every line of slack-messages.jsonl is counted as "missing fields" and
 * skipped. From that one gap:
 *
 *   1. Slack history is UNREPLAYABLE — measured 2026-11-12: 671 importable
 *      Slack messages present in two agents' logs and absent from their stores.
 *   2. Slack history is DESTROYABLE — `rebuild()` deletes every row and then
 *      imports from telegram-messages.jsonl alone, so it destroys every Slack
 *      row and restores none; on an agent with no Telegram log it empties the
 *      store and returns success.
 *
 * PR #3044 fixed the LIVE write (writeSlackLogRow, the §14 key rule). It did
 * not touch the import, which is what this covers.
 *
 * The fixtures use the EXACT key set a real slack-messages.jsonl carries
 * (verified against a live log: channelId, fromUser, messageId, platform,
 * platformUserId, senderName, sessionName, text, timestamp) — no topicId, and a
 * `ts` string for messageId.
 *
 * Several assertions carry their own control: a test that only shows the fixed
 * path working cannot tell a fix from a fixture that was never broken.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory, topicMemoryKeyForLogEntry } from '../../src/memory/TopicMemory.js';
import { TopicRowWriter, writeSlackLogRow, deriveRowKey, SLACK_FALLBACK_BASE } from '../../src/memory/topicRowWriter.js';
import { slackSyntheticTopicId } from '../../src/memory/topicRowCarrier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CHANNEL_A = 'C0BUT8WEJ3A';
const CHANNEL_B = 'C0C6RARLAR2';

/** One row exactly as the Slack message logger writes it. */
function slackRow(channelId: string, messageId: string, text: string, opts: { fromUser?: boolean; threadTs?: string } = {}) {
  const seconds = Number(messageId.split('.')[0]);
  const row: Record<string, unknown> = {
    messageId,
    channelId,
    text,
    fromUser: opts.fromUser ?? true,
    timestamp: new Date((Number.isFinite(seconds) ? seconds : 1762300000) * 1000).toISOString(),
    sessionName: null,
    senderName: 'A Person',
    platformUserId: 'U07SOMEONE',
    platform: 'slack',
  };
  if (opts.threadTs) row.threadTs = opts.threadTs;
  return row;
}

/**
 * The admission test as it stands on main, reproduced so the fixture is proved
 * to be one the current importer cannot read. Without this control a passing
 * suite could mean the fixture was always importable.
 */
function admittedByUnfixedImporter(entry: any): boolean {
  return entry.topicId != null && !!entry.text;
}

const CHANNEL_A_ROWS = [
  slackRow(CHANNEL_A, '1762300000.000100', 'first in A'),
  slackRow(CHANNEL_A, '1762300000.000200', 'same second as the first'),
  slackRow(CHANNEL_A, '1762300060.100000', 'a minute later', { fromUser: false }),
  slackRow(CHANNEL_A, '1762300120.250000', 'in a thread', { threadTs: '1762300000.000100' }),
];
const CHANNEL_B_ROWS = [
  slackRow(CHANNEL_B, '1762300001.000000', 'first in B'),
  slackRow(CHANNEL_B, '1762300002.000000', 'second in B'),
  slackRow(CHANNEL_B, '1762300003.000000', 'third in B'),
];
const ALL_SLACK_ROWS = [...CHANNEL_A_ROWS, ...CHANNEL_B_ROWS];

/** A standalone file share: Slack gave it no message `ts`, so it takes the fallback key range. */
const FILE_SHARE_ROW = slackRow(CHANNEL_A, 'file-F09ABCDEF-1762300200000', 'a file with no ts');

const TELEGRAM_ROWS = [
  { messageId: 11, topicId: 4242, text: 'telegram one', fromUser: true, timestamp: '2026-11-05T01:00:00Z', sessionName: null },
  { messageId: 12, topicId: 4242, text: 'telegram two', fromUser: false, timestamp: '2026-11-05T01:01:00Z', sessionName: 's' },
];

function writeJsonl(file: string, rows: unknown[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** A row writer wired to this store, as server.ts wires the live one. */
function liveWriter(tm: TopicMemory, refusals: string[] = []) {
  return new TopicRowWriter({
    topicMemory: () => tm,
    reportRefusal: (e) => { refusals.push(`${e.refused}: ${e.detail}`); },
  });
}

/** Write an entry exactly as the live Slack path does (PR #3044). */
function writeLive(tm: TopicMemory, entry: Record<string, unknown>, refusals: string[] = []) {
  return writeSlackLogRow(liveWriter(tm, refusals), entry as any, {
    topicIdFor: (channelId) => slackSyntheticTopicId(channelId),
    resolveUserId: () => undefined,
  });
}

describe('Slack JSONL import into TopicMemory', () => {
  let tmpDir: string;
  let tm: TopicMemory;
  let slackLog: string;
  let telegramLog: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-jsonl-import-'));
    slackLog = path.join(tmpDir, 'slack-messages.jsonl');
    telegramLog = path.join(tmpDir, 'telegram-messages.jsonl');
    tm = new TopicMemory(tmpDir);
    await tm.open();
  });

  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/slack-jsonl-import.test.ts' });
  });

  // ── the fixture is one the unfixed importer cannot read ────────────

  it('CONTROL: the importer as it stands on main reads none of these rows', () => {
    expect(ALL_SLACK_ROWS).toHaveLength(7);
    expect(ALL_SLACK_ROWS.filter(admittedByUnfixedImporter)).toHaveLength(0);
    // and it does read a Telegram row, so the control is not vacuous
    expect(TELEGRAM_ROWS.filter(admittedByUnfixedImporter)).toHaveLength(2);
  });

  // ── every message survives ─────────────────────────────────────────

  it('imports every message from a two-channel Slack log', async () => {
    writeJsonl(slackLog, ALL_SLACK_ROWS);

    const imported = await tm.importFromJsonl(slackLog);
    expect(imported).toBe(ALL_SLACK_ROWS.length);

    const topicA = slackSyntheticTopicId(CHANNEL_A);
    const topicB = slackSyntheticTopicId(CHANNEL_B);
    expect(topicA).not.toBe(topicB);
    expect(tm.getMessageCount(topicA)).toBe(CHANNEL_A_ROWS.length);
    expect(tm.getMessageCount(topicB)).toBe(CHANNEL_B_ROWS.length);
    expect(tm.stats().totalMessages).toBe(ALL_SLACK_ROWS.length);

    // Every text is present — not six of seven with one lost to a collision.
    const texts = [...tm.getRecentMessages(topicA, 50), ...tm.getRecentMessages(topicB, 50)].map((m) => m.text);
    for (const row of ALL_SLACK_ROWS) expect(texts).toContain(row.text as string);

    const stats = tm.getLastImportStats()!;
    expect(stats.imported).toBe(ALL_SLACK_ROWS.length);
    expect(stats.missingFields).toBe(0);
    expect(stats.unkeyed).toBe(0);
    expect(stats.collision).toBe(0);
    expect(stats.keyMismatch).toBe(0);
  });

  it('keeps two messages sent in the same second', async () => {
    writeJsonl(slackLog, CHANNEL_A_ROWS.slice(0, 2));
    await tm.importFromJsonl(slackLog);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))).toBe(2);
  });

  it('keeps a 25-message channel at 25 rows', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      slackRow(CHANNEL_B, `17623010${String(10 + i).padStart(2, '0')}.000000`, `message ${i}`));
    writeJsonl(slackLog, rows);
    expect(await tm.importFromJsonl(slackLog)).toBe(25);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_B))).toBe(25);
  });

  // ── parity with the live write path (PR #3044) ─────────────────────

  it('files messages under the same topic_id the live Slack write uses', async () => {
    writeJsonl(slackLog, CHANNEL_B_ROWS);
    await tm.importFromJsonl(slackLog);

    const expected = slackSyntheticTopicId(CHANNEL_B);
    // The live path hashes the channel id. A raw-channelId key would be a
    // string in an INTEGER column, and a thread-aware key a different number;
    // both would file these rows under a SECOND topic per channel.
    expect(expected).toBeLessThan(0);
    expect(Number.isSafeInteger(expected)).toBe(true);
    expect(tm.getMessageCount(expected)).toBe(CHANNEL_B_ROWS.length);
    expect(tm.getMessageCount(CHANNEL_B as unknown as number)).toBe(0);
    expect(tm.listTopics().map((t) => t.topicId)).toEqual([expected]);
  });

  it('keys a threaded message on its channel, not on channel:threadTs', () => {
    const threaded = CHANNEL_A_ROWS[3] as any;
    expect(threaded.threadTs).toBeTruthy();

    const key = topicMemoryKeyForLogEntry(threaded);
    expect(key.kind).toBe('slack');
    expect((key as any).topicId).toBe(slackSyntheticTopicId(CHANNEL_A));
    // The control: the thread-aware key really is a different number, so this
    // pins a choice rather than restating an identity.
    expect(slackSyntheticTopicId(`${CHANNEL_A}:${threaded.threadTs}`))
      .not.toBe(slackSyntheticTopicId(CHANNEL_A));
  });

  it('derives every key through the shipped key rule, not a second copy of it', async () => {
    writeJsonl(slackLog, [...CHANNEL_A_ROWS, FILE_SHARE_ROW]);
    await tm.importFromJsonl(slackLog);

    const topicA = slackSyntheticTopicId(CHANNEL_A);
    const rows = tm.getRecentMessages(topicA, 50);
    expect(rows).toHaveLength(CHANNEL_A_ROWS.length + 1);

    for (const row of [...CHANNEL_A_ROWS, FILE_SHARE_ROW]) {
      const expected = deriveRowKey({ channel: 'slack', ts: String(row.messageId) });
      expect('error' in expected).toBe(false);
      const stored = rows.find((r) => r.text === row.text)!;
      expect(stored.messageId).toBe((expected as any).messageId);
      // channel_message_id keeps the channel's own id verbatim (§14).
      expect(stored.channelMessageId).toBe(String(row.messageId));
    }

    // The ts rows sort in send order; the file share sits in the fallback range.
    const tsIds = CHANNEL_A_ROWS.map((r) => (deriveRowKey({ channel: 'slack', ts: String(r.messageId) }) as any).messageId);
    expect([...tsIds].sort((a, b) => a - b)).toEqual(tsIds);
    const fileId = rows.find((r) => r.text === FILE_SHARE_ROW.text)!.messageId;
    expect(fileId).toBeGreaterThanOrEqual(SLACK_FALLBACK_BASE);
    expect(rows.map((r) => r.messageId)).not.toContain(0);
  });

  // ── Echo's two requested checks ────────────────────────────────────

  it('adds zero rows to a store that already holds live rows written by the #3044 path', async () => {
    // Build the "live" state with the production writer, not by hand.
    const refusals: string[] = [];
    for (const row of ALL_SLACK_ROWS) {
      const r = writeLive(tm, row, refusals);
      expect(r?.written).toBe(true);
    }
    expect(refusals).toEqual([]);
    const before = tm.stats().totalMessages;
    expect(before).toBe(ALL_SLACK_ROWS.length);

    writeJsonl(slackLog, ALL_SLACK_ROWS);
    const imported = await tm.importFromJsonl(slackLog);

    expect(imported).toBe(0);
    expect(tm.stats().totalMessages).toBe(before);
    const stats = tm.getLastImportStats()!;
    expect(stats.duplicate).toBe(ALL_SLACK_ROWS.length);
    expect(stats.collision).toBe(0);
    expect(stats.keyMismatch).toBe(0);
    expect(stats.adopted).toBe(0);
  });

  it('gives a non-ts Slack id the same key on import as on the live write', async () => {
    // Live write first, into its own store.
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-jsonl-live-'));
    const liveTm = new TopicMemory(liveDir);
    await liveTm.open();
    try {
      const r = writeLive(liveTm, FILE_SHARE_ROW);
      expect(r?.written).toBe(true);
      const topicA = slackSyntheticTopicId(CHANNEL_A);
      const liveRow = liveTm.getRecentMessages(topicA, 10)[0];
      expect(liveRow.messageId).toBeGreaterThanOrEqual(SLACK_FALLBACK_BASE);

      // Import the same entry into a different store.
      writeJsonl(slackLog, [FILE_SHARE_ROW]);
      expect(await tm.importFromJsonl(slackLog)).toBe(1);
      const importedRow = tm.getRecentMessages(topicA, 10)[0];

      expect(importedRow.messageId).toBe(liveRow.messageId);
      expect(importedRow.channelMessageId).toBe(liveRow.channelMessageId);
      expect(importedRow.topicId).toBe(liveRow.topicId);

      // And importing it where the live row already is adds nothing.
      expect(await liveTm.importFromJsonl(slackLog)).toBe(0);
      expect(liveTm.getLastImportStats()!.duplicate).toBe(1);
    } finally {
      liveTm.close();
      SafeFsExecutor.safeRmSync(liveDir, { recursive: true, force: true, operation: 'tests/unit/slack-jsonl-import.test.ts' });
    }
  });

  // ── refusals are counted, never silent ─────────────────────────────

  it('refuses and counts a Slack entry the key rule cannot key', async () => {
    const unkeyable = [
      { ...slackRow(CHANNEL_A, '1762300000.000100', 'bad one'), messageId: '' },
      { ...slackRow(CHANNEL_A, '1762300000.000200', 'bad two'), messageId: 'x'.repeat(300) },
    ];
    writeJsonl(slackLog, [...CHANNEL_B_ROWS, ...unkeyable]);

    const imported = await tm.importFromJsonl(slackLog);
    expect(imported).toBe(CHANNEL_B_ROWS.length);
    expect(tm.getLastImportStats()!.unkeyed).toBe(2);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))).toBe(0);
  });

  it('leaves Telegram entries untouched and never reads one as Slack', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    expect(await tm.importFromJsonl(telegramLog)).toBe(2);
    expect(tm.getMessageCount(4242)).toBe(2);
    const stored = tm.getRecentMessages(4242, 10).map((m) => m.messageId).sort((a, b) => a - b);
    expect(stored).toEqual([11, 12]);
    // Unchanged legacy behaviour: the batched Telegram insert sets no channel id.
    expect(tm.getRecentMessages(4242, 10).every((m) => m.channelMessageId == null)).toBe(true);
  });

  // ── idempotence ────────────────────────────────────────────────────

  it('is idempotent — a second import of the same Slack log lands nothing', async () => {
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    expect(await tm.importFromJsonl(slackLog)).toBe(ALL_SLACK_ROWS.length);
    expect(await tm.importFromJsonl(slackLog)).toBe(0);
    expect(tm.getLastImportStats()!.duplicate).toBe(ALL_SLACK_ROWS.length);
    expect(tm.stats().totalMessages).toBe(ALL_SLACK_ROWS.length);
  });

  it('importAllLogs reads both logs in the state dir and is idempotent', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, ALL_SLACK_ROWS);

    const first = await tm.importAllLogs();
    expect(first.total).toBe(TELEGRAM_ROWS.length + ALL_SLACK_ROWS.length);
    expect(first.perSource['telegram-messages.jsonl']).toBe(TELEGRAM_ROWS.length);
    expect(first.perSource['slack-messages.jsonl']).toBe(ALL_SLACK_ROWS.length);

    const second = await tm.importAllLogs();
    expect(second.total).toBe(0);
    expect(tm.stats().totalMessages).toBe(TELEGRAM_ROWS.length + ALL_SLACK_ROWS.length);
  });
});

describe('TopicMemory.rebuild() and Slack history', () => {
  let tmpDir: string;
  let tm: TopicMemory;
  let slackLog: string;
  let telegramLog: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-jsonl-rebuild-'));
    slackLog = path.join(tmpDir, 'slack-messages.jsonl');
    telegramLog = path.join(tmpDir, 'telegram-messages.jsonl');
    tm = new TopicMemory(tmpDir);
    await tm.open();
  });

  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/slack-jsonl-import.test.ts' });
  });

  it('restores Slack history instead of destroying it, and is idempotent', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    const total = TELEGRAM_ROWS.length + ALL_SLACK_ROWS.length;

    await tm.importAllLogs();
    expect(tm.stats().totalMessages).toBe(total);

    // A rebuild is handed the TELEGRAM log, exactly as /topic/rebuild does.
    expect(await tm.rebuild(telegramLog)).toBe(total);
    expect(tm.stats().totalMessages).toBe(total);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))).toBe(CHANNEL_A_ROWS.length);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_B))).toBe(CHANNEL_B_ROWS.length);

    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(false);
    expect(report.sources.map((p) => path.basename(p)).sort())
      .toEqual(['slack-messages.jsonl', 'telegram-messages.jsonl']);
    expect(report.deleted).toBe(total);
    expect(report.restored).toBe(total);

    // Idempotent: a second rebuild lands on the same store.
    expect(await tm.rebuild(telegramLog)).toBe(total);
    expect(tm.stats().totalMessages).toBe(total);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))).toBe(CHANNEL_A_ROWS.length);
  });

  it('CONTROL: the Slack rows a rebuild used to destroy are the ones at stake', async () => {
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    await tm.importAllLogs();

    const slackBefore = tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))
      + tm.getMessageCount(slackSyntheticTopicId(CHANNEL_B));
    expect(slackBefore).toBe(ALL_SLACK_ROWS.length);

    // The pre-fix source set was [telegramLog] alone, and importing from it
    // restores nothing Slack — it was the DELETE that did the damage.
    expect(await tm.importFromJsonl(telegramLog)).toBe(0);

    expect(await tm.rebuild(telegramLog)).toBe(TELEGRAM_ROWS.length + ALL_SLACK_ROWS.length);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))
      + tm.getMessageCount(slackSyntheticTopicId(CHANNEL_B))).toBe(ALL_SLACK_ROWS.length);
  });

  it('refuses to delete when no source log exists at all', async () => {
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    await tm.importAllLogs();
    const before = tm.stats().totalMessages;
    expect(before).toBe(ALL_SLACK_ROWS.length);

    SafeFsExecutor.safeUnlinkSync(slackLog, { operation: 'tests/unit/slack-jsonl-import.test.ts' });
    expect(await tm.rebuild(telegramLog)).toBe(0); // neither log exists now

    expect(tm.stats().totalMessages).toBe(before);
    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(true);
    expect(report.reason).toBe('no-source-log');
    expect(report.deleted).toBe(0);
    expect(report.sources).toEqual([]);
  });

  it('refuses to delete when the logs that exist hold nothing restorable', async () => {
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    await tm.importAllLogs();
    const before = tm.stats().totalMessages;

    fs.writeFileSync(slackLog, '{ not json\n{"messageId":9}\n');
    fs.writeFileSync(telegramLog, '');

    expect(await tm.rebuild(telegramLog)).toBe(0);
    expect(tm.stats().totalMessages).toBe(before);
    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(true);
    expect(report.reason).toBe('sources-hold-no-restorable-message');
    expect(report.restorable).toBe(0);
  });

  it('still deletes on a partial source, and reports the shortfall rather than hiding it', async () => {
    // The destructive contract is unchanged: a rebuild from a log covering only
    // part of the store still drops the rest. What changed is that the loss is
    // now a number the caller can read.
    writeJsonl(telegramLog, TELEGRAM_ROWS);
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    await tm.importAllLogs();

    writeJsonl(slackLog, [CHANNEL_B_ROWS[0]]);
    const restored = await tm.rebuild(telegramLog);

    expect(restored).toBe(TELEGRAM_ROWS.length + 1);
    const report = tm.getLastRebuildReport()!;
    expect(report.refused).toBe(false);
    expect(report.deleted).toBe(TELEGRAM_ROWS.length + ALL_SLACK_ROWS.length);
    expect(report.restored).toBeLessThan(report.deleted);
    expect(tm.getMessageCount(slackSyntheticTopicId(CHANNEL_A))).toBe(0);
  });

  it('preserves summaries across a rebuild that restores Slack rows', async () => {
    writeJsonl(slackLog, ALL_SLACK_ROWS);
    await tm.importAllLogs();
    const topicA = slackSyntheticTopicId(CHANNEL_A);
    tm.saveTopicSummary(topicA, 'what this channel is about', 4, 0);

    await tm.rebuild(telegramLog);

    expect(tm.getTopicSummary(topicA)!.summary).toBe('what this channel is about');
    expect(tm.getMessageCount(topicA)).toBe(CHANNEL_A_ROWS.length);
  });
});
