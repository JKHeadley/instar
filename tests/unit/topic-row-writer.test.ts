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
  reconcileAppConversationRows, SLACK_FALLBACK_BASE, type AppConversationSource,
} from '../../src/memory/topicRowWriter.js';
import { REVIEW_CANARY_FIXTURES } from '../../src/monitoring/ReviewCanaryBattery.js';
import { SlackAdapter, fileShareLogId } from '../../src/messaging/slack/SlackAdapter.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { TelegramBridgeConfig } from '../../src/threadline/TelegramBridgeConfig.js';
import { TelegramBridge, type TelegramSink } from '../../src/threadline/TelegramBridge.js';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';

const OP = 'tests/unit/topic-row-writer.test.ts';
const SLACK_TOPIC = -12345;
const APP_TOPIC = -(2 ** 33) - 77;
const APP_KEY = '0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9';
const APP_KEY_2 = '1b2c3d4e-5f60-4172-8384-a5b6c7d8e9f0';

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
    for (const bad of ['', '999999999999.999999']) {
      expect(deriveRowKey({ channel: 'slack', ts: bad }), bad).toHaveProperty('error');
    }
  });

  it('Slack ids that are not a ts get a deterministic fallback key above every ts key, the raw id kept', () => {
    for (const id of ['file-F0123ABC', 'app-7f3e9a', '1700000000', '1700000000.1234567']) {
      const a = deriveRowKey({ channel: 'slack', ts: id }) as { messageId: number; channelMessageId: string };
      expect(a).toEqual(deriveRowKey({ channel: 'slack', ts: id }));
      expect(a.channelMessageId).toBe(id);
      expect(a.messageId).toBeGreaterThanOrEqual(SLACK_FALLBACK_BASE);
      expect(Number.isSafeInteger(a.messageId)).toBe(true);
    }
    const realTsKey = (deriveRowKey({ channel: 'slack', ts: '4102444800.999999' }) as { messageId: number }).messageId; // 2100-01-01
    expect(realTsKey).toBeLessThan(SLACK_FALLBACK_BASE);
    expect((deriveRowKey({ channel: 'slack', ts: 'app-a' }) as { messageId: number }).messageId)
      .not.toBe((deriveRowKey({ channel: 'slack', ts: 'app-b' }) as { messageId: number }).messageId);
  });

  it('a standalone file share logs under the real share ts, then event_ts, then the file id (never the clock)', () => {
    const shares = { shares: { private: { D0OPS: [{ ts: '1762800000.000777' }] } } };
    expect(fileShareLogId(shares, 'D0OPS', { event_ts: '1762800001.000001' }, 'F01')).toBe('1762800000.000777');
    expect(fileShareLogId({ shares: { public: { C0PUB: [{ ts: '1762800000.000888' }] } } }, 'C0PUB', {}, 'F01')).toBe('1762800000.000888');
    expect(fileShareLogId({}, 'D0OPS', { event_ts: '1762800001.000001' }, 'F01')).toBe('1762800001.000001');
    expect(fileShareLogId(shares, 'D0OTHER', {}, 'F01')).toBe('file-F01');
    expect(fileShareLogId(undefined, 'D0OPS', { event_ts: 'garbage' }, 'F01')).toBe('file-F01');
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
    // The review-canary battery's fixture conversations are never a Slack row source.
    for (const f of REVIEW_CANARY_FIXTURES) expect(rowChannelForTopicId(f.topicId), String(f.topicId)).toBeNull();
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

  it('hasRowSource is false while TopicMemory is not open', () => {
    expect(writer.hasRowSource(141133)).toBe(true);
    tm.close();
    expect(writer.hasRowSource(141133)).toBe(false);
    expect(writer.hasRowSource(SLACK_TOPIC)).toBe(false);
    const none = new TopicRowWriter({ topicMemory: () => undefined, reportRefusal: () => {} });
    expect(none.hasRowSource(141133)).toBe(false);
  });

  it('a malformed key is a counted refusal, never a guessed row', () => {
    const r = writer.writeRow({ channel: 'slack', ts: '' }, body());
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
    const base = { kind: 'message', conversationKey: APP_KEY, at: '2026-11-10T00:00:01.000Z' };
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
    const r = writeAppConversationRow(writer, { eventId: 'e1', kind: 'message', conversationKey: APP_KEY, at: '2026-11-10T00:00:01.000Z', role: 'operator', text: 'x' }, { aliasFor: () => null, ownerUserId: () => null });
    expect(r).toMatchObject({ written: false, refused: 'bad-key' });
    expect(writer.stats().app.refused['bad-key']).toBe(1);
  });

  it('a platform conversation in the app store (a Slack key) is not this writer\'s: skipped, not refused', () => {
    const r = writeAppConversationRow(writer, { eventId: 'e1', kind: 'message', conversationKey: 'slack:T1:C1', at: '2026-11-10T00:00:01.000Z', role: 'operator', text: 'x' }, { aliasFor: () => APP_TOPIC, ownerUserId: () => null });
    expect(r).toEqual({ written: false, skipped: 'not-this-channel' });
    expect(refusals).toHaveLength(0);
  });

  describe('reconcile from the app store', () => {
    const msgs = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ({
      eventId: `ev-${String(start + i).padStart(4, '0')}`, role: (i % 2 ? 'agent' : 'operator') as 'operator' | 'agent',
      text: `m${start + i}`, at: new Date(Date.UTC(2026, 10, 10, 0, 0, 0, 0) + (start + i) * 1000).toISOString(),
    }));
    /** A source that pages backwards like AppConversationStore.browseMessages. */
    const source = (byKey: Record<string, ReturnType<typeof msgs>>): AppConversationSource & { pages: number } => {
      const src = {
        pages: 0,
        liveConversationKeys: () => Object.keys(byKey),
        browseMessages(key: string, before: string | null | undefined, limit = 100) {
          src.pages++;
          const all = byKey[key] ?? [];
          const end = before ? all.findIndex((m) => `${m.at},${m.eventId}` === before) : all.length;
          const startAt = Math.max(0, end - limit);
          const page = all.slice(startAt, end);
          return { messages: page, nextBefore: startAt > 0 && page[0] ? `${page[0].at},${page[0].eventId}` : null };
        },
      };
      return src;
    };
    const d = { aliasFor: (k: string) => (k === APP_KEY ? APP_TOPIC : k === APP_KEY_2 ? APP_TOPIC - 1 : null), ownerUserId: () => 'u-owner' };

    it('replays missed rows, is idempotent, and is bounded to the most recent N per conversation', () => {
      const src = source({ [APP_KEY]: msgs(30), 'slack:T1:C1': msgs(3) });
      // Ten rows written live; twenty missed while the switch was off.
      for (const m of msgs(10)) writeAppConversationRow(writer, { ...m, kind: 'message', conversationKey: APP_KEY }, d);
      const first = reconcileAppConversationRows(writer, src, d, { maxPerConversation: 25 });
      // The bound reaches m5..m29: m5..m9 were written live, m10..m29 were missed.
      expect(first).toMatchObject({ conversations: 1, scanned: 25, inserted: 20, duplicate: 5, refused: 0, skipped: null });
      expect(tm.getMessageCount(APP_TOPIC)).toBe(30);
      const again = reconcileAppConversationRows(writer, src, d, { maxPerConversation: 25 });
      expect(again).toMatchObject({ inserted: 0, duplicate: 25 });
      // The default bound is 500.
      const big = source({ [APP_KEY_2]: msgs(620) });
      expect(reconcileAppConversationRows(writer, big, d)).toMatchObject({ scanned: 500, inserted: 500 });
      expect(tm.getRecentMessages(APP_TOPIC - 1, 1)[0].text).toBe('m619');
    });

    it('counts a conversation with no alias once, and does nothing while the switch is off', () => {
      const src = source({ [APP_KEY]: msgs(5), '2c3d4e5f-6071-4283-9495-b6c7d8e9f0a1': msgs(40) });
      const r = reconcileAppConversationRows(writer, src, d);
      expect(r).toMatchObject({ conversations: 2, inserted: 5, refused: 1 });
      expect(refusals.filter((x) => x.refused === 'bad-key')).toHaveLength(1);
      appOn = false;
      expect(reconcileAppConversationRows(writer, src, d)).toMatchObject({ skipped: 'channel-off', scanned: 0 });
    });
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

describe('SlackAdapter.logMessage notifies the row seam', () => {
  it('fires onMessageLogged once for a logged row (the app operator path), and not with notify:false (the reply route)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-logmessage-'));
    try {
      const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U0OP'], workspaceMode: 'dedicated' } as never, dir);
      const seen: Array<{ messageId: unknown; fromUser: boolean; eventId?: string }> = [];
      adapter.onMessageLogged = (e) => { seen.push({ messageId: e.messageId, fromUser: e.fromUser, ...(e.eventId ? { eventId: e.eventId } : {}) }); };
      adapter.logMessage({ messageId: 'app-m1', channelId: 'D0OPS', text: 'from the app', fromUser: true, platformUserId: 'U0OP', eventId: 'ev-1', deviceId: 'd1' });
      adapter.logMessage({ messageId: '1762800000.000100', channelId: 'D0OPS', text: 'agent reply', fromUser: false }, { notify: false });
      expect(seen).toEqual([{ messageId: 'app-m1', fromUser: true, eventId: 'ev-1' }]);
      // A throwing subscriber never fails the log write.
      adapter.onMessageLogged = () => { throw new Error('subscriber broke'); };
      expect(() => adapter.logMessage({ messageId: 'app-m2', channelId: 'D0OPS', text: 'x', fromUser: true })).not.toThrow();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
    }
  });
});
