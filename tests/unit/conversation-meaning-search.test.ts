// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Meaning search over conversations (docs/specs/conversation-search.md §4), the parts in isolation:
 * the embedding index (upsert, re-embed on a text change, short messages, the model stamp, both
 * distance functions, visibility applied before ranking, pruning), the background feeder (per-tick
 * bounds, the sweep cursor, skips for load / off / no model, coverage), and the local search
 * (visibility, ref restriction, a held app message, a gone message forgotten, the similarity floor).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationEmbeddingFeeder, ConversationEmbeddingIndex, MIN_WORDS, textHash, wordCount,
  type IndexSource, type SourceItem,
} from '../../src/memory/ConversationEmbeddingIndex.js';
import { EmbeddingProvider } from '../../src/memory/EmbeddingProvider.js';
import { searchMeaningLocal, conversationIndexSources, MIN_SIMILARITY } from '../../src/server/conversationMeaningSearch.js';
import type { ConversationSearchRouteDeps } from '../../src/server/mobileConversationSearchRoutes.js';
import { FakeEmbedder, fakeVector } from '../helpers/fakeEmbedder.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const indexes: ConversationEmbeddingIndex[] = [];
afterAll(() => {
  for (const i of indexes) i.close();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/conversation-meaning-search.test.ts' });
});

function freshIndex(vec?: { loadVecExtension: (db: never) => boolean } | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-meaning-'));
  dirs.push(dir);
  const index = new ConversationEmbeddingIndex({ dbPath: path.join(dir, 'state', 'conversation-embeddings.db') });
  index.open(vec as never);
  indexes.push(index);
  return { index, dir };
}

/** An in-memory source, newest first; the cursor is an offset. */
function memSource(platform: 'app' | 'telegram' | 'slack', items: SourceItem[], opts: { immutable?: boolean; lazy?: Map<string, string> } = {}): IndexSource & { items: SourceItem[] } {
  const src = {
    platform, items, immutable: opts.immutable,
    page(cursor: string | null, limit: number) {
      const from = cursor === null ? 0 : Number(cursor);
      const page = src.items.slice(from, from + limit);
      return { items: page, next: from + limit < src.items.length ? String(from + limit) : null };
    },
    readText: opts.lazy ? (it: SourceItem) => { const t = opts.lazy!.get(it.key); return t === undefined ? null : { text: t, fromUser: true }; } : undefined,
    total: () => src.items.length,
  };
  return src;
}
const item = (ref: string, key: string, text: string | null, at = '2026-11-10T10:00:00.000Z'): SourceItem => ({ ref, key, at, fromUser: false, text });

describe('the index', () => {
  it('stores a vector per (ref, key), replaces it, and keeps short messages as looked-at rows', () => {
    const { index } = freshIndex();
    index.upsert({ ref: 'telegram:1', key: '5', platform: 'telegram', at: '2026-11-10T10:00:00.000Z', fromUser: true, hash: 'h1', embedding: fakeVector('rocket launch today') });
    index.upsert({ ref: 'telegram:1', key: '6', platform: 'telegram', at: '2026-11-10T10:00:00.000Z', fromUser: true, hash: 'h2', embedding: null });
    expect(index.hashOf('telegram:1', '5')).toBe('h1');
    index.upsert({ ref: 'telegram:1', key: '5', platform: 'telegram', at: '2026-11-10T10:00:00.000Z', fromUser: true, hash: 'h3', embedding: fakeVector('pizza for dinner') });
    expect(index.hashOf('telegram:1', '5')).toBe('h3');
    expect(index.counts()).toEqual({ rows: 2, embedded: 1 });
    expect(() => index.upsert({ ref: 'x', key: 'y', platform: 'app', at: 'z', fromUser: false, hash: 'h', embedding: new Float32Array(3) })).toThrow(/dimensions/);
  });

  it('applies the visibility filter before ranking (a hidden nearer row never takes a place)', () => {
    const { index } = freshIndex();
    const put = (ref: string, key: string, text: string) => index.upsert({ ref, key, platform: 'telegram', at: '2026-11-10T10:00:00.000Z', fromUser: false, hash: key, embedding: fakeVector(text) });
    put('telegram:1', 'a', 'rocket launch rocket');
    put('telegram:2', 'b', 'spaceship liftoff');
    put('telegram:2', 'c', 'pizza dinner');
    const rows = index.search(fakeVector('rocket launch'), ['telegram:2'], 1);
    expect(rows.map((r) => r.key)).toEqual(['b']);
    expect(rows[0].similarity).toBeGreaterThan(0.8);
    expect(index.search(fakeVector('rocket'), [], 5)).toEqual([]);
  });

  it('answers the same with sqlite-vec loaded as with the JS cosine', async () => {
    const provider = new EmbeddingProvider();
    const vecLoaded = await provider.loadVecModule();
    const js = freshIndex().index;
    const vec = freshIndex(provider as never).index;
    expect(js.distance).toBe('cse_cosine_distance');
    if (vecLoaded) expect(vec.distance).toBe('vec_distance_cosine');
    for (const ix of [js, vec]) {
      ix.upsert({ ref: 'app:x', key: '1', platform: 'app', at: '2026-11-10T10:00:00.000Z', fromUser: false, hash: '1', embedding: fakeVector('the budget and the cost') });
      ix.upsert({ ref: 'app:x', key: '2', platform: 'app', at: '2026-11-10T10:00:00.000Z', fromUser: false, hash: '2', embedding: fakeVector('storm in the forecast') });
    }
    const a = js.search(fakeVector('money spending'), ['app:x'], 2);
    const b = vec.search(fakeVector('money spending'), ['app:x'], 2);
    expect(a.map((r) => r.key)).toEqual(['1', '2']);
    expect(b.map((r) => r.key)).toEqual(a.map((r) => r.key));
    expect(b[0].similarity).toBeCloseTo(a[0].similarity, 4);
  });

  it('starts over when the stored vectors came from a different model', () => {
    const { index, dir } = freshIndex();
    index.upsert({ ref: 'app:x', key: '1', platform: 'app', at: 'a', fromUser: false, hash: '1', embedding: fakeVector('rocket launch now') });
    index.close();
    const other = new ConversationEmbeddingIndex({ dbPath: path.join(dir, 'state', 'conversation-embeddings.db'), dimensions: 512 });
    other.open();
    indexes.push(other);
    expect(other.counts().rows).toBe(0);
  });

  it('prunes to the newest rows', () => {
    const { index } = freshIndex();
    for (let i = 0; i < 5; i++) index.upsert({ ref: 'app:x', key: String(i), platform: 'app', at: `2026-11-0${i + 1}T00:00:00.000Z`, fromUser: false, hash: String(i), embedding: null });
    expect(index.pruneTo(3)).toBe(2);
    expect(index.hashOf('app:x', '0')).toBeNull();
    expect(index.hashOf('app:x', '4')).toBe('4');
  });

  it('counts words with the search word rule', () => {
    expect(wordCount('ok thanks')).toBe(2);
    expect(wordCount('the rocket — launched!')).toBe(MIN_WORDS);
    expect(textHash('a')).toHaveLength(24);
  });
});

describe('the feeder', () => {
  const quiet = { busy: () => false };

  it('embeds at most maxEmbeds per tick, keeps its sweep place, and finishes on later ticks', async () => {
    const { index } = freshIndex();
    const items = Array.from({ length: 10 }, (_, i) => item('telegram:1', String(100 - i), `rocket launch number ${i}`));
    const src = memSource('telegram', items);
    const emb = new FakeEmbedder();
    const f = new ConversationEmbeddingFeeder({ index, sources: () => [src], embedder: () => emb, enabled: () => true, ...quiet, limits: { maxEmbeds: 3, headPage: 2, sweepPage: 4 } });
    const t1 = await f.tick();
    expect(t1).toMatchObject({ ran: true, embedded: 3, budget: true });
    expect(index.counts().embedded).toBe(3);
    for (let i = 0; i < 4; i++) await f.tick();
    expect(index.counts().embedded).toBe(10);
    expect(f.status.sweepsCompleted).toBeGreaterThanOrEqual(1);
    expect(f.coverage()).toBe(1);
    // Caught up: a tick embeds nothing.
    const calls = emb.calls.length;
    await f.tick();
    expect(emb.calls.length).toBe(calls);
  });

  it('stops a tick at the time budget', async () => {
    const { index } = freshIndex();
    const src = memSource('telegram', Array.from({ length: 6 }, (_, i) => item('telegram:1', String(i), `storm forecast item ${i}`)));
    let clock = 0;
    const slow = { dimensions: 384, embed: async (t: string) => { clock += 400; return fakeVector(t); } };
    const f = new ConversationEmbeddingFeeder({ index, sources: () => [src], embedder: () => slow, enabled: () => true, ...quiet, now: () => clock, limits: { maxEmbedMs: 600 } });
    expect(await f.tick()).toMatchObject({ ran: true, embedded: 2, budget: true });
  });

  it('re-embeds a message whose text changed, and never re-reads an immutable one', async () => {
    const { index } = freshIndex();
    const tg = memSource('telegram', [item('telegram:1', '1', 'rocket launch went well')]);
    const lazy = new Map([['e1', 'pizza for dinner tonight']]);
    const app = memSource('app', [item('app:k', 'e1', null)], { immutable: true, lazy });
    const emb = new FakeEmbedder();
    const f = new ConversationEmbeddingFeeder({ index, sources: () => [tg, app], embedder: () => emb, enabled: () => true, ...quiet });
    await f.tick();
    expect(emb.calls).toEqual(['rocket launch went well', 'pizza for dinner tonight']);
    tg.items[0] = item('telegram:1', '1', 'the storm forecast changed');
    lazy.set('e1', 'changed text that must not be read');
    await f.tick();
    expect(emb.calls.slice(2)).toEqual(['the storm forecast changed']);
    expect(index.hashOf('telegram:1', '1')).toBe(textHash('the storm forecast changed'));
  });

  it('records short messages without a vector', async () => {
    const { index } = freshIndex();
    const emb = new FakeEmbedder();
    const f = new ConversationEmbeddingFeeder({ index, sources: () => [memSource('telegram', [item('telegram:1', '1', 'ok thanks')])], embedder: () => emb, enabled: () => true, ...quiet });
    await f.tick();
    expect(emb.calls).toEqual([]);
    expect(index.counts()).toEqual({ rows: 1, embedded: 0 });
    expect(f.coverage()).toBe(1);
  });

  it('skips the tick when the machine is busy, the switch is off, or there is no model', async () => {
    const { index } = freshIndex();
    const src = memSource('telegram', [item('telegram:1', '1', 'rocket launch went well')]);
    const emb = new FakeEmbedder();
    let busy = true, on = true, model: FakeEmbedder | null = emb;
    const f = new ConversationEmbeddingFeeder({ index, sources: () => [src], embedder: () => model, enabled: () => on, busy: () => busy });
    expect(await f.tick()).toEqual({ ran: false, reason: 'load' });
    expect(f.status.skippedForLoad).toBe(1);
    busy = false; on = false;
    expect(await f.tick()).toEqual({ ran: false, reason: 'off' });
    on = true; model = null;
    expect(await f.tick()).toEqual({ ran: false, reason: 'no-model' });
    expect(emb.calls).toEqual([]);
    model = emb;
    expect(await f.tick()).toMatchObject({ ran: true, embedded: 1 });
  });

  it('reports coverage as the share of held messages looked at, and null when a source cannot count', async () => {
    const { index } = freshIndex();
    const src = memSource('telegram', Array.from({ length: 4 }, (_, i) => item('telegram:1', String(i), `rocket launch item ${i}`)));
    let clock = 0;
    const f = new ConversationEmbeddingFeeder({ index, sources: () => [src], embedder: () => new FakeEmbedder(), enabled: () => true, ...quiet, now: () => (clock += 31_000), limits: { maxEmbeds: 1, headPage: 1, sweepPage: 1 } });
    await f.tick();
    expect(f.coverage()).toBe(0.25);
    src.total = () => null;
    expect(f.coverage()).toBeNull();
  });
});

describe('the local search', () => {
  function deps(over: Partial<ConversationSearchRouteDeps> = {}): ConversationSearchRouteDeps {
    const tmRows = new Map<string, { text: string; fromUser: boolean; timestamp: string }>([
      ['1:10', { text: 'the spaceship liftoff happened at dawn', fromUser: true, timestamp: '2026-11-10T10:00:00.000Z' }],
      ['2:20', { text: 'secret rocket launch plans for the shuttle', fromUser: false, timestamp: '2026-11-10T11:00:00.000Z' }],
      ['1:11', { text: 'pizza and pasta for dinner tonight', fromUser: true, timestamp: '2026-11-10T12:00:00.000Z' }],
    ]);
    return {
      config: {} as never, pairing: {} as never, service: null, machineId: () => 'm1',
      topicMemory: () => ({ messageByKey: (t: number, m: number) => tmRows.get(`${t}:${m}`) ?? null } as never),
      telegramTopics: () => [{ topicId: 1, topicName: 'Launches' }, { topicId: 2, topicName: 'Secret' }],
      ...over,
    };
  }
  async function filled() {
    const { index } = freshIndex();
    for (const [k, t] of [['1:10', 'the spaceship liftoff happened at dawn'], ['2:20', 'secret rocket launch plans for the shuttle'], ['1:11', 'pizza and pasta for dinner tonight'], ['1:99', 'rocket launch message that was deleted']]) {
      const [topic, id] = k.split(':');
      index.upsert({ ref: `telegram:${topic}`, key: id, platform: 'telegram', at: '2026-11-10T10:00:00.000Z', fromUser: false, hash: id, embedding: fakeVector(t) });
    }
    return index;
  }
  const allow = { may: () => true, mayReadApp: () => true };

  it('finds a paraphrase, ranks by similarity, drops what is not about the query, and forgets a gone message', async () => {
    const index = await filled();
    const emb = new FakeEmbedder();
    const r = searchMeaningLocal(deps(), { index, embedder: emb, coverage: () => 1 }, { queryVec: fakeVector('rocket launch'), terms: ['rocket', 'launch'], limit: 10, only: null }, allow);
    expect(r.results.map((h) => `${h.ref} ${h.messageId}`)).toEqual(['telegram:2 out:20', 'telegram:1 in:10']);
    expect(r.results[0].rank).toBeGreaterThanOrEqual(r.results[1].rank);
    expect(r.results[1].rank).toBeGreaterThan(MIN_SIMILARITY);
    expect(r.results[1].marks).toEqual([]); // no literal query word in the paraphrase
    const marked = r.results[0];
    expect(marked.snippet.slice(marked.marks[0].start, marked.marks[0].start + marked.marks[0].length)).toBe('rocket');
    expect(r.results.map((h) => h.messageId)).not.toContain('out:11');
    expect(index.hashOf('telegram:1', '99')).toBeNull();
  });

  it('only searches what the caller can list, and ref= restricts to one conversation', async () => {
    const index = await filled();
    const m = { index, embedder: new FakeEmbedder(), coverage: () => 1 };
    const q = { queryVec: fakeVector('rocket launch'), terms: [], limit: 10, only: null as string | null };
    const member = searchMeaningLocal(deps(), m, q, { may: (k) => k === 'telegram:1', mayReadApp: () => true });
    expect(member.results.map((h) => h.ref)).toEqual(['telegram:1']);
    const inside = searchMeaningLocal(deps(), m, { ...q, only: 'telegram:2' }, allow);
    expect(inside.results.map((h) => h.ref)).toEqual(['telegram:2']);
  });

  it('a held app message is never a hit, and is not forgotten', async () => {
    const { index } = freshIndex();
    const key = '1a193485-9b00-44ea-a3a6-50ddce6dd6fb';
    index.upsert({ ref: `app:${key}`, key: 'e1', platform: 'app', at: '2026-11-10T10:00:00.000Z', fromUser: false, hash: 'e1', embedding: fakeVector('the rocket launch budget') });
    const ev = { kind: 'message', eventId: 'e1', role: 'agent', text: 'the rocket launch budget', at: '2026-11-10T10:00:00.000Z' };
    const service = {
      store: { getConversation: () => ({ title: 'Plans' }), listConversations: () => ({ conversations: [{ conversationKey: key, title: 'Plans' }], nextCursor: null }), getEvent: () => ev },
      liveConversation: () => ({}),
    } as never;
    const m = { index, embedder: new FakeEmbedder(), coverage: () => 1 };
    const q = { queryVec: fakeVector('rocket'), terms: [], limit: 10, only: null };
    const owner = searchMeaningLocal(deps({ service }), m, q, allow);
    expect(owner.results.map((h) => h.messageId)).toEqual(['e1']);
    const held = searchMeaningLocal(deps({ service }), m, q, { may: () => true, mayReadApp: () => false });
    expect(held.results).toEqual([]);
    expect(index.hashOf(`app:${key}`, 'e1')).toBe('e1');
  });

  it('builds the sources from the keyword dependencies', () => {
    const tm = {
      indexPage: (before: number | null) => (before === null ? [{ id: 9, messageId: 3, topicId: 1, text: 'hello there friend', fromUser: true, timestamp: '2026-11-10T10:00:00.000Z' }] : []),
      totalMessages: () => 1,
    };
    const srcs = conversationIndexSources(deps({
      topicMemory: () => tm as never,
      slack: () => ({ conversations: () => [{ id: -7, title: '#g' }], history: () => [{ ts: '1.2', text: 'slack words here', fromUser: true, at: '2026-11-10T10:00:00.000Z' }] }),
    }));
    expect(srcs.map((s) => s.platform)).toEqual(['telegram', 'slack']);
    expect(srcs[0].page(null, 100).items[0]).toMatchObject({ ref: 'telegram:1', key: '3', text: 'hello there friend', fromUser: true });
    expect(srcs[1].page(null, 100).items[0]).toMatchObject({ ref: 'slack:m1:-7', key: '1.2' });
    expect(srcs[1].total()).toBe(1);
  });
});

describe('Agent Awareness + Migration Parity: the conversation search line', () => {
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const run = async (projectDir: string) => {
    const { PostUpdateMigrator } = await import('../../src/core/PostUpdateMigrator.js');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(result);
    return result;
  };

  it('an agent with the keyword-only line gets the meaning line in its place, once', async () => {
    const { APP_CONVERSATIONS_SEARCH_LINE, APP_CONVERSATIONS_SEARCH_LINE_KEYWORD_ONLY, APP_CONVERSATIONS_PINS_LINE } = await import('../../src/core/PostUpdateMigrator.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-meaning-md-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const old = APP_CONVERSATIONS_SEARCH_LINE_KEYWORD_ONLY.replace('PORT', '4321');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n\n${APP_CONVERSATIONS_PINS_LINE}\n${old}\n- next line\n`);
    const r = await run(dir);
    expect(r.upgraded).toContain('CLAUDE.md: the conversation search line now mentions meaning search');
    const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    const want = APP_CONVERSATIONS_SEARCH_LINE.replace('PORT', '4321');
    expect(md).toContain(`${APP_CONVERSATIONS_PINS_LINE}\n${want}\n- next line`);
    expect(md).not.toContain(old);
    expect(want).toContain('mode=meaning');
    expect(want).toContain('meaning-unavailable');
    const again = await run(dir);
    expect(again.upgraded.filter((u) => u.includes('search line'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').split(want).length - 1).toBe(1);
  });
});
