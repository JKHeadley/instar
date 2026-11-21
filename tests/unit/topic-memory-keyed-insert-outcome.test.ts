// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * PROP-1289 — which layer owns a row write the store did not keep.
 *
 * `insertKeyedMessage` returned `{ outcome: 'inserted' }` without ever reading
 * whether a row landed. `insertMessage` writes with `INSERT OR IGNORE`, which
 * absorbs every constraint the keyed pre-checks cannot see (NOT NULL, CHECK):
 * zero rows written, no error raised. Measured on upstream `644224d89`, before
 * this fix, with the real schema and the real better-sqlite3:
 *
 *     insertKeyedMessage({ …, text: null })
 *       -> { outcome: 'inserted' }
 *       -> rows in `messages`: 0
 *       -> topic_meta.message_count: 1
 *
 * Both counting consumers believe that receipt — `TopicRowWriter.writeRow`
 * returns `written: true` and bumps `inserted`, and `importFromJsonl` bumps
 * `imported` — so a row that is not in the database is reported as stored, and
 * nothing anywhere records that it is missing.
 *
 * THE FIX IS THE RETURN VALUE, NOT A TRY/CATCH, and that distinction is the
 * whole history of this item. A containment patch that caught the failure
 * inside `insertMessage` was carried for a month and retired unshipped,
 * because on this architecture it converts a LOUD operational failure
 * (`SQLITE_READONLY` on an unwritable store) into a counted false success on
 * both consumers. The last test in this file is the ratchet that keeps the two
 * apart: neither method may catch anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicRowWriter } from '../../src/memory/topicRowWriter.js';

const OP = 'tests/unit/topic-memory-keyed-insert-outcome.test.ts';
const SLACK_TOPIC = -12345;

/** A healthy keyed row. `text: null` is the constraint class the pre-checks cannot see. */
const row = (over: Record<string, unknown> = {}) => ({
  messageId: 1_762_800_000_000_100,
  topicId: SLACK_TOPIC,
  text: 'hello',
  fromUser: true,
  timestamp: '2026-11-16T00:00:00.000Z',
  sessionName: null,
  channelMessageId: '1762800000.000100',
  ...over,
} as Parameters<TopicMemory['insertKeyedMessage']>[0]);

describe('TopicMemory.insertKeyedMessage — the outcome is read from the write', () => {
  let dir: string;
  let tm: TopicMemory;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-insert-outcome-'));
    tm = new TopicMemory(dir);
    await tm.open();
  });
  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('a write the store absorbed is not-landed, and a write that lands is inserted', () => {
    // POSITIVE CONTROL, in the same test: without it, a fixture that can never
    // insert anything would report `not-landed` for every row and pass.
    const good = tm.insertKeyedMessage(row({ text: 'kept', channelMessageId: '1762800000.000100' }));
    expect(good).toEqual({ outcome: 'inserted' });
    expect(tm.getMessageCount(SLACK_TOPIC)).toBe(1);

    const absorbed = tm.insertKeyedMessage(row({
      messageId: 1_762_800_000_000_200, channelMessageId: '1762800000.000200', text: null,
    }));
    // Before the fix this was `{ outcome: 'inserted' }` with zero rows written.
    expect(absorbed).toEqual({ outcome: 'not-landed' });
    expect(tm.getMessageCount(SLACK_TOPIC)).toBe(1);
    expect(tm.getRecentMessages(SLACK_TOPIC, 10).map((r) => r.text)).toEqual(['kept']);
  });

  it('the pre-checked outcomes are unchanged: a replay is duplicate, a clash is a collision', () => {
    expect(tm.insertKeyedMessage(row()).outcome).toBe('inserted');
    expect(tm.insertKeyedMessage(row()).outcome).toBe('duplicate');
    expect(tm.insertKeyedMessage(row({ channelMessageId: 'other-id' })).outcome).toBe('collision');
    expect(tm.insertKeyedMessage(row({ messageId: 1_762_800_000_000_999 })).outcome).toBe('key-mismatch');
  });

  it('insertMessage answers whether a NEW row landed', () => {
    const msg = { messageId: 4242, topicId: 141133, text: 'legacy', fromUser: true, timestamp: '2026-11-16T00:00:00.000Z', sessionName: null };
    expect(tm.insertMessage(msg)).toBe(true);           // landed
    expect(tm.insertMessage(msg)).toBe(false);          // the same key again: absorbed
    expect(tm.insertMessage({ ...msg, messageId: 4243, text: null as unknown as string })).toBe(false); // a constraint: absorbed
    expect(tm.getMessageCount(141133)).toBe(1);
  });

  it('RECORDED, DELIBERATELY NOT CHANGED: topic_meta still counts a row that did not land', () => {
    // Measured on upstream 644224d89 and unchanged by this fix. `insertMessage`
    // runs the topic_meta upsert whether or not the row landed, so getTopicMeta
    // and getMessageCount disagree. It is left alone on purpose: the upsert is
    // also where a null timestamp THROWS today, and removing that throw would be
    // the containment this item retired. rebuildTopicMeta() recomputes the count
    // from the messages table on every import and rebuild, so the divergence is
    // corrected there. Changing it is its own decision with its own evidence —
    // this test exists so the next person finds a record, not a surprise.
    tm.insertKeyedMessage(row({ text: null }));
    expect(tm.getMessageCount(SLACK_TOPIC)).toBe(0);
    expect(tm.getTopicMeta(SLACK_TOPIC)?.messageCount).toBe(1);
  });

  it('a row that did not land is really absent from the database, not just from a counter', () => {
    tm.insertKeyedMessage(row({ text: null }));
    tm.close();
    const db = new Database(path.join(dir, 'topic-memory.db'), { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    db.close();
    expect(n.c).toBe(0);
  });
});

describe('TopicRowWriter — a row the store did not keep is a counted refusal', () => {
  let dir: string;
  let tm: TopicMemory;
  let refusals: Array<{ channel: string; refused: string; detail: string }>;
  let writer: TopicRowWriter;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-insert-writer-'));
    tm = new TopicMemory(dir);
    await tm.open();
    refusals = [];
    writer = new TopicRowWriter({ topicMemory: () => tm, reportRefusal: (e) => refusals.push(e) });
  });
  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  const body = (over: Record<string, unknown> = {}) => ({
    topicId: SLACK_TOPIC, text: 'hello', fromUser: true, timestamp: '2026-11-16T00:00:00.000Z', sessionName: null, ...over,
  }) as Parameters<TopicRowWriter['writeRow']>[1];

  it('refuses it, counts it, and reports it — where it used to answer written:true', () => {
    // POSITIVE CONTROL, same test: a healthy row through the same writer.
    const kept = writer.writeRow({ channel: 'slack', ts: '1762800000.000100' }, body({ text: 'kept' }));
    expect(kept).toMatchObject({ written: true, outcome: 'inserted' });
    expect(refusals).toHaveLength(0);

    const absorbed = writer.writeRow({ channel: 'slack', ts: '1762800000.000200' }, body({ text: null }));
    expect(absorbed).toMatchObject({ written: false, refused: 'not-landed' });
    expect(writer.stats().slack.refused['not-landed']).toBe(1);
    expect(writer.stats().slack.inserted).toBe(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ channel: 'slack', refused: 'not-landed', topicId: SLACK_TOPIC });
    // The detail names the message that is missing, so the report identifies a row.
    expect(refusals[0].detail).toContain('1762800000.000200');
    expect(tm.getMessageCount(SLACK_TOPIC)).toBe(1);
  });
});

describe('importFromJsonl — a not-landed keyed row is counted apart from an imported one', () => {
  let dir: string;
  let tm: TopicMemory;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-insert-import-'));
    tm = new TopicMemory(dir);
    await tm.open();
  });
  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('counts notLanded, not imported, and keeps reading the file', async () => {
    // REACHABILITY, stated rather than implied: parseLogLine refuses a line with
    // no text, so no JSONL line produces this outcome on today's admission rules.
    // The store is made to absorb ONE row here so the MAPPING is pinned: if the
    // import ever meets this outcome, it must count it somewhere. Without this
    // test the outcome would fall through the tally and read as nothing at all.
    const real = tm.insertMessage.bind(tm);
    vi.spyOn(tm, 'insertMessage').mockImplementation((m) => (m.text === 'absorb-me' ? false : real(m)));

    const log = path.join(dir, 'slack.jsonl');
    const line = (ts_: string, text: string) => JSON.stringify({ text, timestamp: '2026-11-16T00:00:00.000Z', channelId: 'C0PUBLIC', messageId: ts_, fromUser: true });
    fs.writeFileSync(log, [
      line('1762800000.000400', 'first'),
      line('1762800000.000500', 'absorb-me'),
      line('1762800000.000600', 'third'),
    ].join('\n') + '\n');

    const imported = await tm.importFromJsonl(log);
    const stats = tm.getLastImportStats();
    expect(imported).toBe(2);
    expect(stats).toMatchObject({ imported: 2, notLanded: 1, duplicate: 0, collision: 0, keyMismatch: 0, malformed: 0 });
  });

  it('says so at the end of the import, and says so BECAUSE of it', async () => {
    const real = tm.insertMessage.bind(tm);
    vi.spyOn(tm, 'insertMessage').mockImplementation((m) => (m.text === 'absorb-me' ? false : real(m)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const log = path.join(dir, 'slack.jsonl');
    fs.writeFileSync(log, JSON.stringify({
      text: 'absorb-me', timestamp: '2026-11-16T00:00:00.000Z', channelId: 'C0PUBLIC', messageId: '1762800000.000500', fromUser: true,
    }) + '\n');
    await tm.importFromJsonl(log);

    // The warn line's CONDITION had to be extended too: a counter that cannot
    // trip its own warning is a number nobody is shown. This import has no
    // malformed, missing, unkeyed, collision or key-mismatch rows, so the only
    // thing that can make it speak is notLanded.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('not_landed=1');
    warn.mockRestore();
  });

  it('sums notLanded across every log a rebuild replays, not just the last one', async () => {
    const real = tm.insertMessage.bind(tm);
    vi.spyOn(tm, 'insertMessage').mockImplementation((m) => (String(m.text).startsWith('absorb') ? false : real(m)));

    const primary = path.join(dir, 'telegram-messages.jsonl');
    const slack = path.join(dir, 'slack-messages.jsonl');
    const line = (ts_: string, text: string) => JSON.stringify({ text, timestamp: '2026-11-16T00:00:00.000Z', channelId: 'C0PUBLIC', messageId: ts_, fromUser: true });
    fs.writeFileSync(primary, [line('1762800000.000700', 'absorb-a'), line('1762800000.000800', 'kept')].join('\n') + '\n');
    fs.writeFileSync(slack, line('1762800000.000900', 'absorb-b') + '\n');

    await tm.importAllLogs(primary);
    // Without the aggregation, the run-wide totals would carry only the LAST
    // source's count — the shape the surrounding code already calls out ("a
    // caller that reports parse errors from one file of several reports a
    // smaller number than actually occurred").
    expect(tm.getLastImportStats()).toMatchObject({ imported: 1, notLanded: 2 });
  });
});

describe('the ratchet — this fix reports, it does not contain', () => {
  const SRC = path.resolve(__dirname, '../../src/memory/TopicMemory.ts');

  /** The source text of one method of the TopicMemory class. */
  function methodBody(source: string, name: string): string {
    const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.Latest, true);
    let found: string | null = null;
    const walk = (n: ts.Node): void => {
      if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.body) {
        found = n.body.getText(sf);
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    if (found === null) throw new Error(`method ${name} not found in ${SRC}`);
    return found;
  }

  /** Does this method body catch anything? */
  function catches(body: string): boolean {
    const sf = ts.createSourceFile('probe.ts', `class X { m() ${body} }`, ts.ScriptTarget.Latest, true);
    let caught = false;
    const walk = (n: ts.Node): void => {
      if (ts.isTryStatement(n) && n.catchClause) { caught = true; return; }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return caught;
  }

  it('neither insertMessage nor insertKeyedMessage catches anything', () => {
    const source = fs.readFileSync(SRC, 'utf-8');
    // POSITIVE CONTROL: the detector must be able to say CAUGHT, or this test
    // passes because it cannot see a catch rather than because there is none.
    expect(catches('{ try { f(); } catch { g(); } }')).toBe(true);
    expect(catches('{ try { f(); } finally { g(); } }')).toBe(false); // finally is not containment

    expect(catches(methodBody(source, 'insertMessage'))).toBe(false);
    expect(catches(methodBody(source, 'insertKeyedMessage'))).toBe(false);
  });

  it('an operational failure still escapes insertKeyedMessage instead of becoming a counted outcome', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-insert-loud-'));
    const tm = new TopicMemory(dir);
    await tm.open();
    try {
      const boom = new Error('SQLITE_READONLY: attempt to write a readonly database');
      vi.spyOn(tm, 'insertMessage').mockImplementation(() => { throw boom; });
      expect(() => tm.insertKeyedMessage(row())).toThrow(boom);

      // POSITIVE CONTROL, same test: the SAME seam returning false IS an outcome,
      // so the test distinguishes "thrown" from "contained" rather than asserting
      // that something somewhere went wrong.
      vi.spyOn(tm, 'insertMessage').mockImplementation(() => false);
      expect(tm.insertKeyedMessage(row())).toEqual({ outcome: 'not-landed' });
    } finally {
      tm.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
    }
  });
});
