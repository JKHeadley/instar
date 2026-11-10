// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * context-budget-layered-summaries §14 / §8 / §6.1 — the channel-neutral
 * TopicMemory row writer (slice S2):
 *  - the per-channel key rule is deterministic and exact;
 *  - two Slack messages in one channel are two rows (the old writer cast to 0);
 *  - the v5 → v6 migration is idempotent on a database built with the old schema;
 *  - a relay-mirrored row carries origin 'relay' (and our own A2A mirror 'a2a');
 *  - an integer collision with a different channel id is refused AND counted;
 *  - an app-conversation store notifies observers of new commits (local and replicated).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import {
  TopicRowWriter, deriveRowKey, appEventHlc, rowChannelForTopicId, writeAppConversationRow,
} from '../../src/memory/topicRowWriter.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { TelegramBridgeConfig } from '../../src/threadline/TelegramBridgeConfig.js';
import { TelegramBridge, type TelegramSink } from '../../src/threadline/TelegramBridge.js';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';

const OP = 'tests/unit/topic-row-writer.test.ts';
const SLACK_TOPIC = -12345;
const APP_TOPIC = -(2 ** 33) - 77;

describe('deriveRowKey (the §14 key rule)', () => {
  it('Telegram: the native id, kept verbatim as the channel id', () => {
    expect(deriveRowKey({ channel: 'telegram', nativeId: 4242 })).toEqual({ messageId: 4242, channelMessageId: '4242' });
    expect(deriveRowKey({ channel: 'telegram', nativeId: 0 })).toHaveProperty('error');
    expect(deriveRowKey({ channel: 'telegram', nativeId: -5 })).toHaveProperty('error');
  });

  it('Slack: ts × 1e6, read exactly (no float rounding), short fractions padded', () => {
    expect(deriveRowKey({ channel: 'slack', ts: '1700000000.123456' })).toEqual({ messageId: 1_700_000_000_123_456, channelMessageId: '1700000000.123456' });
    // A float parse of this ts drifts by one microsecond; the rule must not.
    expect(deriveRowKey({ channel: 'slack', ts: '1762800000.000003' })).toEqual({ messageId: 1_762_800_000_000_003, channelMessageId: '1762800000.000003' });
    expect(deriveRowKey({ channel: 'slack', ts: '1700000000.5' })).toEqual({ messageId: 1_700_000_000_500_000, channelMessageId: '1700000000.5' });
    for (const bad of ['', '1700000000', 'abc.def', '1700000000.1234567', '999999999999.999999']) {
      expect(deriveRowKey({ channel: 'slack', ts: bad }), bad).toHaveProperty('error');
    }
  });

  it('app: physicalMs × 1000 + (logical mod 1000), under 2^53, event id kept', () => {
    const k = deriveRowKey({ channel: 'app', eventId: 'ev-1', hlc: { physicalMs: 1_794_000_000_000, logical: 1234 } });
    expect(k).toEqual({ messageId: 1_794_000_000_000_234, channelMessageId: 'ev-1' });
    expect(Number.isSafeInteger((k as { messageId: number }).messageId)).toBe(true);
    expect(deriveRowKey({ channel: 'app', eventId: '', hlc: { physicalMs: 1, logical: 0 } })).toHaveProperty('error');
    expect(deriveRowKey({ channel: 'app', eventId: 'e', hlc: { physicalMs: Number.NaN, logical: 0 } })).toHaveProperty('error');
  });

  it('is deterministic: the same identity yields the same key every time', () => {
    const ids = [
      { channel: 'telegram' as const, nativeId: 77 },
      { channel: 'slack' as const, ts: '1731000000.654321' },
      { channel: 'app' as const, eventId: 'e-9', hlc: appEventHlc({ eventId: 'e-9', at: '2026-11-10T01:02:03.004Z' })! },
    ];
    for (const id of ids) expect(deriveRowKey(id)).toEqual(deriveRowKey(structuredClone(id)));
    // The app stamp reads only the event's immutable fields.
    expect(appEventHlc({ eventId: 'e-9', at: '2026-11-10T01:02:03.004Z' })).toEqual(appEventHlc({ eventId: 'e-9', at: '2026-11-10T01:02:03.004Z' }));
    expect(appEventHlc({ eventId: 'e-9', at: 'not a time' })).toBeNull();
  });

  it('maps topic ids to the channel that minted them', () => {
    expect(rowChannelForTopicId(141133)).toBe('telegram');
    expect(rowChannelForTopicId(-12345)).toBe('slack');
    expect(rowChannelForTopicId(-(2 ** 31) - 1)).toBe('slack');
    expect(rowChannelForTopicId(APP_TOPIC)).toBe('app');
    expect(rowChannelForTopicId(-(2 ** 32))).toBeNull();
    expect(rowChannelForTopicId(0)).toBeNull();
  });
});

describe('TopicRowWriter × a real TopicMemory', () => {
  let dir: string;
  let tm: TopicMemory;
  let refusals: Array<{ channel: string; refused: string; detail: string }>;
  let appOn: boolean;
  let writer: TopicRowWriter;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-row-writer-'));
    tm = new TopicMemory(dir);
    await tm.open();
    refusals = [];
    appOn = true;
    writer = new TopicRowWriter({
      topicMemory: () => tm,
      channelEnabled: (ch) => ch === 'app' ? appOn : true,
      reportRefusal: (e) => refusals.push(e),
    });
  });
  afterEach(() => {
    tm.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  const body = (over: Record<string, unknown> = {}) => ({
    topicId: SLACK_TOPIC, text: 'hello', fromUser: true, timestamp: '2026-11-10T00:00:00.000Z', sessionName: null, ...over,
  });

  it('two Slack messages in one channel are two rows (not collapsed onto key 0)', () => {
    expect(writer.writeRow({ channel: 'slack', ts: '1762800000.000100' }, body({ text: 'first' })).written).toBe(true);
    expect(writer.writeRow({ channel: 'slack', ts: '1762800001.000200' }, body({ text: 'second' })).written).toBe(true);
    const rows = tm.getRecentMessages(SLACK_TOPIC, 10);
    expect(rows.map((r) => r.text)).toEqual(['first', 'second']);
    expect(rows.map((r) => r.messageId)).toEqual([1_762_800_000_000_100, 1_762_800_001_000_200]);
    expect(rows.map((r) => r.channelMessageId)).toEqual(['1762800000.000100', '1762800001.000200']);
  });

  it('a replay of the same channel message is a duplicate, not a second row', () => {
    writer.writeRow({ channel: 'slack', ts: '1762800000.000100' }, body());
    const again = writer.writeRow({ channel: 'slack', ts: '1762800000.000100' }, body());
    expect(again).toMatchObject({ written: true, outcome: 'duplicate' });
    expect(tm.getMessageCount(SLACK_TOPIC)).toBe(1);
    expect(writer.stats().slack).toMatchObject({ inserted: 1, duplicate: 1 });
  });

  it('an integer collision with a different channel id is refused and counted, the stored row untouched', () => {
    const hlc = { physicalMs: 1_794_000_000_000, logical: 5 };
    const first = writer.writeRow({ channel: 'app', eventId: 'ev-A', hlc }, body({ topicId: APP_TOPIC, text: 'A' }));
    expect(first).toMatchObject({ written: true, outcome: 'inserted' });
    const clash = writer.writeRow({ channel: 'app', eventId: 'ev-B', hlc: { ...hlc, logical: 1005 } }, body({ topicId: APP_TOPIC, text: 'B' }));
    expect(clash).toMatchObject({ written: false, refused: 'collision' });
    expect(writer.stats().app.refused.collision).toBe(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ channel: 'app', refused: 'collision' });
    expect(refusals[0].detail).toContain('ev-A');
    const rows = tm.getRecentMessages(APP_TOPIC, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'A', channelMessageId: 'ev-A' });
  });

  it('a channel id already stored under another key is refused as a key mismatch', () => {
    writer.writeRow({ channel: 'app', eventId: 'ev-A', hlc: { physicalMs: 1_794_000_000_000, logical: 5 } }, body({ topicId: APP_TOPIC }));
    const r = writer.writeRow({ channel: 'app', eventId: 'ev-A', hlc: { physicalMs: 1_794_000_000_001, logical: 5 } }, body({ topicId: APP_TOPIC }));
    expect(r).toMatchObject({ written: false, refused: 'key-mismatch' });
    expect(writer.stats().app.refused['key-mismatch']).toBe(1);
  });

  it('adopts a legacy Telegram row (no channel id) instead of reading it as a collision', () => {
    tm.insertMessage({ messageId: 900, topicId: 141133, text: 'legacy', fromUser: true, timestamp: '2026-11-01T00:00:00.000Z', sessionName: null });
    const r = writer.writeRow({ channel: 'telegram', nativeId: 900 }, body({ topicId: 141133, text: 'legacy' }));
    expect(r).toMatchObject({ written: true, outcome: 'adopted' });
    expect(tm.getRecentMessages(141133, 5)[0].channelMessageId).toBe('900');
    expect(refusals).toHaveLength(0);
  });

  it('app rows are skipped (not refused) while the switch is off, and hasRowSource follows it', () => {
    appOn = false;
    const r = writer.writeRow({ channel: 'app', eventId: 'ev-1', hlc: { physicalMs: 1_794_000_000_000, logical: 1 } }, body({ topicId: APP_TOPIC }));
    expect(r).toEqual({ written: false, skipped: 'channel-off' });
    expect(tm.getMessageCount(APP_TOPIC)).toBe(0);
    expect(writer.hasRowSource(APP_TOPIC)).toBe(false);
    expect(writer.hasRowSource(141133)).toBe(true);
    expect(writer.hasRowSource(SLACK_TOPIC)).toBe(true);
    expect(writer.hasRowSource(-(2 ** 32))).toBe(false);
    appOn = true;
    expect(writer.hasRowSource(APP_TOPIC)).toBe(true);
  });

  it('an unreadable switch reads as off (fails closed)', () => {
    const w = new TopicRowWriter({ topicMemory: () => tm, channelEnabled: () => { throw new Error('config unreadable'); }, reportRefusal: () => {} });
    expect(w.hasRowSource(APP_TOPIC)).toBe(false);
    expect(w.hasRowSource(141133)).toBe(true);
  });

  it('a malformed key is a counted refusal, never a guessed row', () => {
    const r = writer.writeRow({ channel: 'slack', ts: 'not-a-ts' }, body());
    expect(r).toMatchObject({ written: false, refused: 'bad-key' });
    expect(writer.stats().slack.refused['bad-key']).toBe(1);
    expect(tm.getMessageCount(SLACK_TOPIC)).toBe(0);
  });

  it('writes the relay origin and reads it back after a restart', async () => {
    writer.writeRow({ channel: 'telegram', nativeId: 501 }, body({ topicId: 141133, fromUser: false, origin: 'relay' }));
    writer.writeRow({ channel: 'telegram', nativeId: 502 }, body({ topicId: 141133, fromUser: false, origin: 'a2a' }));
    writer.writeRow({ channel: 'telegram', nativeId: 503 }, body({ topicId: 141133 }));
    tm.close();
    tm = new TopicMemory(dir);
    await tm.open();
    expect(tm.getRecentMessages(141133, 5).map((r) => r.origin)).toEqual(['relay', 'a2a', undefined]);
  });

  it('app conversation rows bind the operator (§6.1): owner phone → owner id, team phone → its person, agent → none', () => {
    const base = { kind: 'message', conversationKey: 'c-1', at: '2026-11-10T00:00:01.000Z' };
    const d = { aliasFor: () => APP_TOPIC, ownerUserId: () => 'u-owner' };
    writeAppConversationRow(writer, { ...base, eventId: 'e1', role: 'operator', text: 'from owner' }, d);
    writeAppConversationRow(writer, { ...base, eventId: 'e2', role: 'operator', text: 'from team', senderRole: 'team', senderPerson: { machineId: 'm1', userId: 'u-team' } }, d);
    writeAppConversationRow(writer, { ...base, eventId: 'e3', role: 'agent', text: 'reply' }, d);
    const rows = tm.getRecentMessages(APP_TOPIC, 10);
    expect(rows.map((r) => [r.text, r.fromUser, r.userId ?? null, r.forwarded])).toEqual([
      ['from owner', true, 'u-owner', false],
      ['from team', true, 'u-team', false],
      ['reply', false, null, false],
    ]);
  });

  it('an app event whose conversation has no alias here is a counted refusal', () => {
    const r = writeAppConversationRow(writer, { eventId: 'e1', kind: 'message', conversationKey: 'c-x', at: '2026-11-10T00:00:01.000Z', role: 'operator', text: 'x' }, { aliasFor: () => null, ownerUserId: () => null });
    expect(r).toMatchObject({ written: false, refused: 'bad-key' });
    expect(writer.stats().app.refused['bad-key']).toBe(1);
  });
});

describe('TopicMemory v5 → v6 migration', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-memory-v6-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  function buildV5(): void {
    const db = new Database(path.join(dir, 'topic-memory.db'));
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, topic_id INTEGER NOT NULL,
        text TEXT NOT NULL, from_user INTEGER NOT NULL DEFAULT 0, timestamp TEXT NOT NULL, session_name TEXT,
        sender_name TEXT, sender_username TEXT, telegram_user_id INTEGER, user_id TEXT,
        privacy_scope TEXT DEFAULT 'private', forwarded INTEGER, UNIQUE(message_id, topic_id));
      CREATE TABLE topic_summaries (topic_id INTEGER PRIMARY KEY, summary TEXT NOT NULL, purpose TEXT,
        message_count_at_summary INTEGER NOT NULL DEFAULT 0, last_message_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE topic_meta (topic_id INTEGER PRIMARY KEY, topic_name TEXT, message_count INTEGER NOT NULL DEFAULT 0, last_activity TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
      INSERT INTO messages (message_id, topic_id, text, from_user, timestamp, forwarded) VALUES (0, -12345, 'old slack row', 1, '2026-11-01T00:00:00.000Z', NULL);
      INSERT INTO messages (message_id, topic_id, text, from_user, timestamp, forwarded) VALUES (7, 141133, 'old telegram row', 1, '2026-11-01T00:00:01.000Z', 0);
    `);
    db.close();
  }
  const columns = () => {
    const db = new Database(path.join(dir, 'topic-memory.db'), { readonly: true });
    try {
      return {
        cols: (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name),
        idx: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_channel_msg'").all() as unknown[]).length,
        version: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      };
    } finally { db.close(); }
  };

  it('adds the nullable columns and the unique index once, keeps every row, and re-runs cleanly', async () => {
    buildV5();
    for (let i = 0; i < 3; i++) {
      const tm = new TopicMemory(dir);
      await tm.open();
      tm.close();
      const c = columns();
      expect(c.cols.filter((n) => n === 'channel_message_id' || n === 'origin')).toEqual(['channel_message_id', 'origin']);
      expect(c.idx).toBe(1);
      expect(c.version).toBe('6');
    }
    const tm = new TopicMemory(dir);
    await tm.open();
    try {
      const rows = [...tm.getRecentMessages(-12345, 5), ...tm.getRecentMessages(141133, 5)];
      expect(rows.map((r) => [r.text, r.channelMessageId, r.origin])).toEqual([
        ['old slack row', undefined, undefined],
        ['old telegram row', undefined, undefined],
      ]);
      // Rows written after the migration coexist with the legacy collapsed Slack row.
      const w = new TopicRowWriter({ topicMemory: () => tm, reportRefusal: () => {} });
      expect(w.writeRow({ channel: 'slack', ts: '1762800000.000100' }, { topicId: -12345, text: 'new', fromUser: true, timestamp: '2026-11-10T00:00:00.000Z', sessionName: null }).written).toBe(true);
      expect(tm.getMessageCount(-12345)).toBe(2);
    } finally { tm.close(); }
  });

  it('a database downgraded to v5 by an older build (version reset, columns kept) migrates again cleanly', async () => {
    buildV5();
    let tm = new TopicMemory(dir);
    await tm.open();
    tm.close();
    const db = new Database(path.join(dir, 'topic-memory.db'));
    db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
    db.close();
    tm = new TopicMemory(dir);
    await tm.open();
    tm.close();
    expect(columns().version).toBe('6');
  });
});

describe('the relay and A2A mirror paths set the row origin (§8)', () => {
  it('a relay-inbound mirror is sent as origin relay; our own outbound mirror as a2a', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-origin-'));
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ projectName: 'test' }));
      const cfg = new TelegramBridgeConfig(new LiveConfig(dir));
      cfg.update({ enabled: true, autoCreateTopics: true, mirrorExisting: true });
      const sends: Array<{ topicId: number; options: unknown }> = [];
      const sink: TelegramSink = {
        async findOrCreateForumTopic(name) { return { topicId: 321, name, reused: false }; },
        async sendToTopic(topicId, _text, options) { sends.push({ topicId, options }); return { ok: true, messageId: 1 }; },
      };
      const bridge = new TelegramBridge({ stateDir: dir, localAgentName: 'echo', config: cfg, telegram: sink, log: { info: () => {}, warn: () => {}, error: () => {} } });
      await bridge.mirrorInbound({ threadId: 't-1', remoteAgent: 'fp-dawn', remoteAgentName: 'dawn', text: 'hi from dawn' });
      await bridge.mirrorOutbound({ threadId: 't-1', remoteAgent: 'fp-dawn', remoteAgentName: 'dawn', text: 'reply to dawn' });
      expect(sends.map((s) => (s.options as { rowOrigin?: string }).rowOrigin)).toEqual(['relay', 'a2a']);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
    }
  });
});

describe('AppConversationStore append observers', () => {
  it('fire once per new commit, local and replicated, never for a de-duplicated replay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-store-listener-'));
    try {
      const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
      const seen: Array<[string, boolean]> = [];
      const off = store.addAppendListener((ev, how) => seen.push([ev.eventId, how.replicated]));
      const KEY = '11111111-2222-3333-4444-555555555555';
      const ev = { eventId: 'op-1', kind: 'message' as const, conversationKey: KEY, messageId: 'msg-1', role: 'operator' as const, text: 'hi', at: '2026-11-10T00:00:00.000Z', machineId: 'm1' };
      store.append(ev);
      store.append(ev); // replay
      store.ingestReplicated({ ...ev, eventId: 'op-2', messageId: 'msg-2', machineId: 'm2' });
      store.ingestReplicated({ ...ev, eventId: 'op-2', messageId: 'msg-2', machineId: 'm2' }); // replay
      // An observer's failure never fails the store.
      store.addAppendListener(() => { throw new Error('observer broke'); });
      expect(() => store.append({ ...ev, eventId: 'op-3', messageId: 'msg-3' })).not.toThrow();
      off();
      store.append({ ...ev, eventId: 'op-4', messageId: 'msg-4' });
      expect(seen).toEqual([['op-1', false], ['op-2', true], ['op-3', false]]);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
    }
  });
});
