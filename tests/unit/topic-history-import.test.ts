/**
 * Unit tests — topic history import (docs/specs/topic-history-import.md).
 *
 * Covers: row admission (every refusal reason, authority narrowing, timestamp
 * normalization), the time-ordered merge (interleaved, out-of-order live rows
 * preserved, equal timestamps, set-determinism across batches vs replay),
 * idempotence, FTS reach, id-ordered readers answering by time, rebuild
 * re-applying batches, a half-written temp batch being ignored, and the user
 * corpus labelling a recovered operator row with no authority.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  validateImportRow,
  mergeSequence,
  runTopicHistoryImport,
  readPublishedBatches,
  batchDir,
  IMPORT_AUDIT_RELPATH,
  IMPORT_MAX_ROWS,
  ImportTooLargeError,
  reapplyImportedHistory,
} from '../../src/memory/topicHistoryImport.js';
import { TopicRowWriter, writeTelegramLogRow } from '../../src/memory/topicRowWriter.js';
import { classifyRow } from '../../src/monitoring/contextLayers/userCorpus.js';

const T = (min: number) => new Date(Date.UTC(2026, 7, 1, 12, min)).toISOString();
const row = (messageId: number, topicId: number, min: number, text = `msg ${messageId}`, extra: Record<string, unknown> = {}) =>
  ({ messageId, topicId, text, fromUser: messageId % 2 === 0, timestamp: T(min), sessionName: null, ...extra });

function ids(tm: TopicMemory, topicId: number): number[] {
  return tm.getRecentMessages(topicId, 1000).map((m) => m.messageId);
}

describe('validateImportRow', () => {
  const now = Date.UTC(2026, 10, 20);
  it('admits a Telegram row and keys it by the §14 rule', () => {
    const v = validateImportRow(row(10, 5, 1), now);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.row.messageId).toBe(10);
      expect(v.row.channelMessageId).toBe('10');
    }
  });
  it('refuses each malformed shape with its own reason', () => {
    expect(validateImportRow(null, now)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(validateImportRow({ ...row(1, 5, 1), topicId: null }, now)).toMatchObject({ ok: false, reason: 'unroutable' });
    expect(validateImportRow({ ...row(1, 5, 1), topicId: -3 }, now)).toMatchObject({ ok: false, reason: 'unroutable' });
    expect(validateImportRow({ ...row(1, 5, 1), messageId: 'g3test-1' }, now)).toMatchObject({ ok: false, reason: 'bad-id' });
    expect(validateImportRow({ ...row(1, 5, 1), messageId: 0 }, now)).toMatchObject({ ok: false, reason: 'bad-id' });
    expect(validateImportRow({ ...row(1, 5, 1), messageId: 'app:msg-abc' }, now)).toMatchObject({ ok: false, reason: 'app-message' });
    expect(validateImportRow({ ...row(1, 5, 1), text: '' }, now)).toMatchObject({ ok: false, reason: 'bad-field' });
    expect(validateImportRow({ ...row(1, 5, 1), fromUser: 'yes' }, now)).toMatchObject({ ok: false, reason: 'bad-field' });
    expect(validateImportRow({ ...row(1, 5, 1), timestamp: 'nope' }, now)).toMatchObject({ ok: false, reason: 'bad-field' });
    expect(validateImportRow({ ...row(1, 5, 1), timestamp: new Date(now + 3_600_000).toISOString() }, now)).toMatchObject({ ok: false, reason: 'bad-field' });
    expect(validateImportRow({ ...row(1, 5, 1), telegramUserId: '7' }, now)).toMatchObject({ ok: false, reason: 'bad-field' });
    expect(validateImportRow({ ...row(1, 5, 1), conversationKey: 'telegram:6' }, now)).toMatchObject({ ok: false, reason: 'bad-field' });
  });
  it('narrows forwarded provenance: only true survives', () => {
    const f = validateImportRow({ ...row(1, 5, 1), forwarded: false }, now);
    const t = validateImportRow({ ...row(1, 5, 1), forwarded: true }, now);
    expect(f.ok && f.row.forwarded).toBeFalsy();
    expect(f.ok && 'forwarded' in f.row).toBe(false);
    expect(t.ok && t.row.forwarded).toBe(true);
  });
  it('normalizes the timestamp to canonical ISO UTC', () => {
    const v = validateImportRow({ ...row(1, 5, 1), timestamp: '2026-08-01T14:00:00+02:00' }, now);
    expect(v.ok && v.row.timestamp).toBe('2026-08-01T12:00:00.000Z');
  });
});

describe('mergeSequence', () => {
  it('keeps live order, places imported rows before the first strictly later live row', () => {
    const live = [{ id: 'a', timestamp: T(10) }, { id: 'b', timestamp: T(5) }, { id: 'c', timestamp: T(20) }];
    const imported = [{ messageId: 2, timestamp: T(7) }, { messageId: 1, timestamp: T(10) }, { messageId: 3, timestamp: T(30) }];
    const out = mergeSequence(live, imported).map((x) => (x.kind === 'live' ? x.row.id : x.row.messageId));
    // live a,b,c keep their order even though b is earlier than a; 2 (t7) goes before a (t10);
    // 1 (t10, equal to a) goes after a; 3 is after everything.
    expect(out).toEqual([2, 'a', 'b', 1, 'c', 3]);
  });
  it('depends only on the set of imported rows (input order irrelevant)', () => {
    const live = [{ timestamp: T(10) }];
    const a = [{ messageId: 20, timestamp: T(5) }, { messageId: 10, timestamp: T(5) }];
    const b = [...a].reverse();
    expect(mergeSequence(live, a)).toEqual(mergeSequence(live, b));
  });
});

describe('topic history import (TopicMemory)', () => {
  let tmpDir: string;
  let tm: TopicMemory;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-import-test-'));
    tm = new TopicMemory(tmpDir);
    await tm.open();
  });
  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/topic-history-import.test.ts' });
  });

  function seedLive(topicId: number, entries: Array<[number, number]>) {
    for (const [mid, min] of entries) tm.insertMessage({ ...row(mid, topicId, min), sessionName: null });
  }

  it('interleaves recovered rows by time; newest live message stays last', async () => {
    seedLive(5, [[100, 10], [102, 30], [104, 50]]);
    const r = await runTopicHistoryImport(tm, tmpDir, { rows: [row(101, 5, 20), row(103, 5, 40), row(99, 5, 1, 'oldest pelican')] });
    expect(r.accepted).toBe(3);
    expect(r.merged).toMatchObject({ topics: 1, inserted: 3, slowestTopicId: 5 });
    expect(ids(tm, 5)).toEqual([99, 100, 101, 102, 103, 104]);
    // id-ordered readers answer by time now
    expect(tm.lastMessageIdByRow(5)).toBe(104);
    expect(tm.messagePrecedes(5, 101, 102)).toBe(true);
    expect(tm.messagePrecedes(5, 104, 99)).toBe(false);
    // the search index reaches the recovered words
    expect(tm.search('pelican', { topicId: 5 }).map((x) => x.messageId)).toEqual([99]);
    // and a live row written afterwards is the newest
    tm.insertMessage({ ...row(106, 5, 60), sessionName: null });
    expect(tm.lastMessageIdByRow(5)).toBe(106);
  });

  it('labels imported rows and never stores forwarded=false', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(2, 7, 1, 'hello', { forwarded: false, telegramUserId: 42 }), row(3, 7, 2, 'fwd', { forwarded: true })] });
    const rows = tm.getRecentMessages(7, 10);
    expect(rows.map((m) => m.origin)).toEqual(['imported', 'imported']);
    expect(rows[0].forwarded).toBeUndefined();
    expect(rows[1].forwarded).toBe(true);
    // The user corpus gives a recovered operator message no authority, even when the sender resolves as the operator.
    expect(classifyRow(rows[0], () => true)).toEqual({ label: 'recovered', authority: 'none' });
  });

  it('is idempotent: a second identical import accepts nothing and publishes no batch', async () => {
    seedLive(5, [[100, 10]]);
    const rows = [row(101, 5, 20), row(102, 6, 1)];
    const first = await runTopicHistoryImport(tm, tmpDir, { rows });
    const second = await runTopicHistoryImport(tm, tmpDir, { rows });
    expect(first.accepted).toBe(2);
    expect(second).toMatchObject({ accepted: 0, duplicate: 2, importId: null });
    expect(fs.readdirSync(batchDir(tmpDir)).length).toBe(1);
  });

  it('dedupes against live rows and within the batch, and counts refusals', async () => {
    seedLive(5, [[100, 10]]);
    const r = await runTopicHistoryImport(tm, tmpDir, {
      rows: [row(100, 5, 10), row(101, 5, 20), row(101, 5, 20), { ...row(1, 5, 1), messageId: 'app:msg-x' }, { topicId: null }],
    });
    expect(r).toMatchObject({ received: 5, accepted: 1, duplicate: 2 });
    expect(r.rejected).toEqual({ 'app-message': 1, unroutable: 1 });
    expect(r.perTopic['5']).toEqual({ accepted: 1, duplicate: 2 });
  });

  it('dry run reports and writes nothing', async () => {
    const r = await runTopicHistoryImport(tm, tmpDir, { rows: [row(1, 5, 1)], dryRun: true });
    expect(r).toMatchObject({ dryRun: true, accepted: 1, importId: null });
    expect(tm.getMessageCount(5)).toBe(0);
    expect(fs.existsSync(batchDir(tmpDir))).toBe(false);
  });

  it('writes accepted and merged audit lines with no message text', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(1, 5, 1, 'secret words')], source: 'test' });
    const lines = fs.readFileSync(path.join(tmpDir, IMPORT_AUDIT_RELPATH), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(['accepted', 'merged']);
    expect(lines[0]).toMatchObject({ source: 'test', accepted: 1, perTopic: { '5': 1 } });
    expect(JSON.stringify(lines)).not.toContain('secret words');
  });

  it('two batches and a full rebuild replay give the same order', async () => {
    const jsonl = path.join(tmpDir, 'telegram-messages.jsonl');
    const live = [row(100, 5, 10), row(102, 5, 10), row(104, 5, 30)];
    fs.writeFileSync(jsonl, live.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await tm.importAllLogs();
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(103, 5, 10)] });
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(101, 5, 10), row(99, 5, 5)] });
    const incremental = ids(tm, 5);
    const restored = await tm.rebuild(jsonl);
    expect(restored).toBe(6);
    expect(ids(tm, 5)).toEqual(incremental);
    expect(incremental).toEqual([99, 100, 102, 101, 103, 104]);
    // rowid order matches too, not just timestamp order
    expect(tm.lastMessageIdByRow(5)).toBe(104);
  });

  it('rebuild with only a batch as source is not refused', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(1, 5, 1)] });
    const n = await tm.rebuild(path.join(tmpDir, 'telegram-messages.jsonl'));
    expect(tm.getLastRebuildReport()?.refused).toBe(false);
    expect(n).toBe(1);
    expect(tm.getMessageCount(5)).toBe(1);
  });

  it('replay ignores a half-written temp batch', async () => {
    fs.mkdirSync(batchDir(tmpDir), { recursive: true });
    fs.writeFileSync(path.join(batchDir(tmpDir), '.imp-x.jsonl.tmp'), '{"topicId":5,"messageId":1,"chan');
    const r = await readPublishedBatches(tmpDir);
    expect(r.files).toBe(0);
    expect(r.byTopic.size).toBe(0);
  });

  it('serializes concurrent imports of the same rows', async () => {
    const rows = [row(1, 5, 1), row(2, 5, 2)];
    const [a, b] = await Promise.all([runTopicHistoryImport(tm, tmpDir, { rows }), runTopicHistoryImport(tm, tmpDir, { rows })]);
    expect(a.accepted + b.accepted).toBe(2);
    expect(a.duplicate + b.duplicate).toBe(2);
    expect(fs.readdirSync(batchDir(tmpDir)).length).toBe(1);
  });

  it('a live copy of an imported message supersedes it (live precedence)', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(10, 5, 1, 'recovered copy', { telegramUserId: 42 })] });
    const writer = new TopicRowWriter({ topicMemory: () => tm, reportRefusal: () => {} });
    const body = { topicId: 5, text: 'live copy', fromUser: true, timestamp: T(1), sessionName: null, telegramUserId: 42, forwarded: false };
    // A plain writeRow (the peer row carrier's path) never relabels a restored row.
    expect(writer.writeRow({ channel: 'telegram', nativeId: 10 }, body)).toMatchObject({ written: true, outcome: 'duplicate' });
    expect(tm.getRecentMessages(5, 5)[0]).toMatchObject({ text: 'recovered copy', origin: 'imported' });
    expect(tm.getRecentMessages(5, 5)[0].forwarded).toBeUndefined();
    // The local live delivery path does supersede it.
    const res = writeTelegramLogRow(writer, tm, 10, body);
    expect(res).toMatchObject({ written: true, outcome: 'duplicate' });
    const [m] = tm.getRecentMessages(5, 5);
    expect(m.text).toBe('live copy');
    expect(m.origin).toBeUndefined();
    expect(m.forwarded).toBe(false);
  });

  it('an identical retry re-merges a topic whose merge failed after its batch was published', async () => {
    const real = tm.mergeTopicHistory.bind(tm);
    let fail = true;
    tm.mergeTopicHistory = ((topicId: number, rows: Parameters<typeof real>[1]) => {
      if (fail && topicId === 6) throw new Error('simulated merge failure');
      return real(topicId, rows);
    }) as typeof tm.mergeTopicHistory;
    const rows = [row(1, 5, 1), row(2, 6, 2)];
    await expect(runTopicHistoryImport(tm, tmpDir, { rows })).rejects.toThrow('simulated merge failure');
    expect(tm.getMessageCount(6)).toBe(0);
    fail = false;
    const retry = await runTopicHistoryImport(tm, tmpDir, { rows });
    expect(retry.accepted).toBe(0);
    expect(retry.merged).toMatchObject({ topics: 1, inserted: 1 });
    expect(tm.getMessageCount(6)).toBe(1);
  });

  it('refuses an import that would push published batches over the cumulative row bound', async () => {
    fs.mkdirSync(batchDir(tmpDir), { recursive: true });
    const big = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => JSON.stringify({ ...row(i + 1, 9, 1), channelMessageId: String(i + 1), sourceId: String(i + 1), importId: 'imp-old' }));
    fs.writeFileSync(path.join(batchDir(tmpDir), `imp-20261101-000000000-deadbeef.r${IMPORT_MAX_ROWS}.jsonl`), big.join('\n') + '\n');
    await expect(runTopicHistoryImport(tm, tmpDir, { rows: [row(1, 5, 1)] })).rejects.toBeInstanceOf(ImportTooLargeError);
  });

  it('keeps the agent\'s own recovered replies out of the user corpus', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(2, 7, 1, 'operator words'), row(3, 7, 2, 'agent reply')] });
    const corpus = tm.getUserCorpusRows(7).rows.map((r) => r.message.messageId);
    expect(corpus).toEqual([2]);
    const agentRow = tm.getRecentMessages(7, 5).find((m) => m.messageId === 3)!;
    expect(classifyRow(agentRow, () => true)).toEqual({ label: 'third-party', authority: 'none' });
  });

  it('a rebuild and an import share one lock (an import waits for the rebuild to finish)', async () => {
    const jsonl = path.join(tmpDir, 'telegram-messages.jsonl');
    fs.writeFileSync(jsonl, [row(100, 5, 10), row(104, 5, 30)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await tm.importAllLogs();
    const rebuilding = tm.rebuild(jsonl);
    const importing = runTopicHistoryImport(tm, tmpDir, { rows: [row(101, 5, 20)] });
    await Promise.all([rebuilding, importing]);
    expect(ids(tm, 5)).toEqual([100, 101, 104]);
    expect(tm.lastMessageIdByRow(5)).toBe(104);
  });

  it('re-apply keeps going past a topic whose merge fails', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(1, 5, 1), row(2, 6, 2)] });
    const fresh = new TopicMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'topic-import-reapply-')));
    await fresh.open();
    const real = fresh.mergeTopicHistory.bind(fresh);
    fresh.mergeTopicHistory = ((topicId: number, rows: Parameters<typeof real>[1]) => {
      if (topicId === 5) throw new Error('boom');
      return real(topicId, rows);
    }) as typeof fresh.mergeTopicHistory;
    const r = await reapplyImportedHistory(fresh, tmpDir);
    expect(r.failedTopics).toEqual([5]);
    expect(fresh.getMessageCount(6)).toBe(1);
    fresh.close();
  });

  it('an unreadable batch archive never reads as empty', async () => {
    fs.mkdirSync(path.dirname(batchDir(tmpDir)), { recursive: true });
    fs.writeFileSync(batchDir(tmpDir), 'not a directory');
    await expect(readPublishedBatches(tmpDir)).rejects.toThrow();
    await expect(tm.rebuild(path.join(tmpDir, 'telegram-messages.jsonl'))).rejects.toThrow();
  });

  it('rebuild still refuses to wipe live rows when the log is gone, even with a batch present', async () => {
    seedLive(5, [[100, 10], [102, 30]]);
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(101, 5, 20)] });
    const n = await tm.rebuild(path.join(tmpDir, 'telegram-messages.jsonl'));
    expect(n).toBe(0);
    expect(tm.getLastRebuildReport()).toMatchObject({ refused: true, reason: 'no-source-log', deleted: 0 });
    expect(ids(tm, 5)).toEqual([100, 101, 102]);
  });

  it('rebuild refuses when a published batch has a damaged line', async () => {
    const jsonl = path.join(tmpDir, 'telegram-messages.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify(row(100, 5, 10)) + '\n');
    await tm.importAllLogs();
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(101, 5, 20)] });
    const [name] = fs.readdirSync(batchDir(tmpDir));
    fs.appendFileSync(path.join(batchDir(tmpDir), name), '{"topicId":5,"messa\n');
    expect(await tm.rebuild(jsonl)).toBe(0);
    expect(tm.getLastRebuildReport()).toMatchObject({ refused: true, reason: 'import-batch-unreadable', deleted: 0 });
    expect(ids(tm, 5)).toEqual([100, 101]);
  });

  it('a batch truncated at a line boundary counts as damage', async () => {
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(1, 5, 1), row(2, 5, 2)] });
    const [name] = fs.readdirSync(batchDir(tmpDir));
    expect(name).toMatch(/\.r2\.jsonl$/);
    const p = path.join(batchDir(tmpDir), name);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8').split('\n')[0] + '\n');
    expect((await readPublishedBatches(tmpDir)).unreadable).toBe(1);
    fs.writeFileSync(p, '');
    expect((await readPublishedBatches(tmpDir)).unreadable).toBe(2);
    // a line substituted by a copy of another (same count, fewer distinct rows) is damage too
    const one = JSON.stringify({ topicId: 5, messageId: 1, channelMessageId: '1', sourceId: '1', text: 'a', fromUser: false, timestamp: T(1), sessionName: null, importId: 'x' });
    fs.writeFileSync(p, one + '\n' + one + '\n');
    expect((await readPublishedBatches(tmpDir)).unreadable).toBe(1);
  });

  it('a .jsonl file without a published name supplies no history', async () => {
    fs.mkdirSync(batchDir(tmpDir), { recursive: true });
    fs.writeFileSync(path.join(batchDir(tmpDir), 'notes.jsonl'), JSON.stringify({ topicId: 5, messageId: 1, channelMessageId: '1', sourceId: '1', text: 'a', fromUser: false, timestamp: T(1), sessionName: null, importId: 'x' }) + '\n');
    const r = await readPublishedBatches(tmpDir);
    expect(r.byTopic.size).toBe(0);
    expect(r.unreadable).toBe(1);
  });

  it('a topic with nothing new keeps its row ids', async () => {
    seedLive(8, [[1, 1], [2, 2]]);
    const before = tm.getUserCorpusRows(8).maxRowId;
    await runTopicHistoryImport(tm, tmpDir, { rows: [row(5, 9, 1)] });
    expect(tm.getUserCorpusRows(8).maxRowId).toBe(before);
  });
});
