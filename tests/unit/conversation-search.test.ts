// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Keyword search over conversations (docs/specs/conversation-search.md): the query words, the
 * FTS expression, the word matcher, the FTS highlight reader, snippets and marks (UTF-16 indices,
 * non-ASCII text), the index query, how each channel's hit maps to the ref and history id the
 * phone scrolls to, peer hits, and the order.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSnippet, ftsMatchExpression, HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN, hitScore, marksFromHighlight, searchTerms, termMarks,
} from '../../src/core/conversationKeywordSearch.js';
import { compareHits, dedupeHits, isConversationSearchEnabled, sanitizePeerHit, searchLocal, type ConversationSearchHit, type ConversationSearchRouteDeps } from '../../src/server/mobileConversationSearchRoutes.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const memories: TopicMemory[] = [];
afterAll(() => {
  for (const m of memories) m.close();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/conversation-search.test.ts' });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-search-')); dirs.push(d); return d; };
/** The marked substrings, for readable assertions. */
const marked = (s: string, marks: Array<{ start: number; length: number }>) => marks.map((m) => s.slice(m.start, m.start + m.length));

describe('query words', () => {
  it('keeps letters, digits and marks, lowercased, unique, in order', () => {
    expect(searchTerms('  Deploy the ROCKET, deploy!  ')).toEqual(['deploy', 'the', 'rocket']);
    expect(searchTerms('café 東京 v2.1')).toEqual(['café', '東京', 'v2', '1']);
    expect(searchTerms('?!* "" ()')).toEqual([]);
    expect(searchTerms('a b c d e f g h i j')).toHaveLength(8);
  });
  it('builds a prefix query requiring every word, with no FTS syntax passed through', () => {
    expect(ftsMatchExpression(['deploy', 'rocket'])).toBe('"deploy"* "rocket"*');
    expect(ftsMatchExpression(searchTerms('NOT a OR b NEAR(c)'))).toBe('"not"* "a"* "or"* "b"* "near"* "c"*');
  });
});

describe('the word matcher', () => {
  it('matches a word start, case-insensitively, and marks the whole word', () => {
    const t = 'Deploying now; redeploy later. DEPLOY!';
    const r = termMarks(t, ['deploy']);
    expect(r.all).toBe(true);
    expect(marked(t, r.marks)).toEqual(['Deploying', 'DEPLOY']);
  });
  it('requires every word', () => {
    expect(termMarks('deploy the thing', ['deploy', 'rocket']).all).toBe(false);
    expect(termMarks('', ['x']).all).toBe(false);
  });
  it('indexes non-ASCII text in UTF-16 code units', () => {
    const t = '🚀 Café au lait — CAFÉ again';
    const r = termMarks(t, ['café']);
    expect(r.marks[0]).toEqual({ start: 3, length: 4 }); // the rocket is two code units, then a space
    expect(marked(t, r.marks)).toEqual(['Café', 'CAFÉ']);
  });
});

describe('the FTS highlight reader', () => {
  it('returns the plain text and the spans', () => {
    const h = `we ${HIGHLIGHT_OPEN}deployed${HIGHLIGHT_CLOSE} the ${HIGHLIGHT_OPEN}rocket${HIGHLIGHT_CLOSE}`;
    const r = marksFromHighlight(h)!;
    expect(r.text).toBe('we deployed the rocket');
    expect(marked(r.text, r.marks)).toEqual(['deployed', 'rocket']);
  });
  it('refuses unbalanced markers', () => {
    expect(marksFromHighlight(`a ${HIGHLIGHT_OPEN}b`)).toBeNull();
    expect(marksFromHighlight(`a ${HIGHLIGHT_CLOSE}b`)).toBeNull();
  });
});

describe('snippets', () => {
  it('a short text is the whole text with its marks unchanged', () => {
    const t = 'deploy the rocket';
    const s = buildSnippet(t, termMarks(t, ['rocket']).marks);
    expect(s.snippet).toBe(t);
    expect(marked(s.snippet, s.marks)).toEqual(['rocket']);
  });
  it('cuts around the first match, shows the cut, and re-bases the marks', () => {
    const t = `${'word '.repeat(80)}the rocket launch went well ${'tail '.repeat(80)}`;
    const s = buildSnippet(t, termMarks(t, ['rocket']).marks);
    expect(s.snippet.startsWith('…')).toBe(true);
    expect(s.snippet.endsWith('…')).toBe(true);
    expect(s.snippet.length).toBeLessThanOrEqual(162);
    expect(marked(s.snippet, s.marks)).toEqual(['rocket']);
  });
  it('shows line breaks as spaces and never splits an emoji', () => {
    const t = `${'🚀'.repeat(60)}\nlaunch`;
    const s = buildSnippet(t, termMarks(t, ['launch']).marks);
    expect(marked(s.snippet, s.marks)).toEqual(['launch']);
    expect(s.snippet).not.toContain('\n');
    // No lone surrogate anywhere.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s.snippet)).toBe(false);
  });
  it('a hit with no marks starts at the text', () => {
    expect(buildSnippet('x'.repeat(400), []).snippet).toBe(`${'x'.repeat(160)}…`);
  });
});

describe('ranking', () => {
  it('more matched words per length ranks higher', () => {
    expect(hitScore(20, 2)).toBeGreaterThan(hitScore(20, 1));
    expect(hitScore(20, 1)).toBeGreaterThan(hitScore(2000, 1));
  });
  it('orders by rank, then newest first', () => {
    const h = (rank: number, at: string, id: string): ConversationSearchHit => ({ ref: 'telegram:1', platform: 'telegram', title: null, messageId: id, at, fromUser: true, snippet: '', marks: [], rank });
    const sorted = [h(1, '2026-01-01T00:00:00.000Z', 'a'), h(2, '2026-01-01T00:00:00.000Z', 'b'), h(1, '2026-02-01T00:00:00.000Z', 'c')].sort(compareHits);
    expect(sorted.map((x) => x.messageId)).toEqual(['b', 'c', 'a']);
  });
});

describe('the index query', () => {
  it('finds prefix and stemmed words only in the named topics, best first, with highlight spans', async () => {
    const tm = new TopicMemory(tmp()); memories.push(tm);
    await tm.open();
    const at = (n: number) => `2026-11-1${n}T10:00:00.000Z`;
    tm.insertMessages([
      { messageId: 1, topicId: 7, text: 'we are deploying the rocket today', fromUser: true, timestamp: at(1), sessionName: null },
      { messageId: 2, topicId: 7, text: 'nothing here', fromUser: false, timestamp: at(2), sessionName: null },
      { messageId: 3, topicId: 8, text: 'rocket deploy in topic eight', fromUser: false, timestamp: at(3), sessionName: null },
    ]);
    const rows = tm.searchKeyword(ftsMatchExpression(['deploy', 'rocket']), [7], 10, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE)!;
    expect(rows.map((r) => r.messageId)).toEqual([1]);
    const parsed = marksFromHighlight(rows[0].marked)!;
    expect(parsed.text).toBe('we are deploying the rocket today');
    expect(marked(parsed.text, parsed.marks)).toEqual(['deploying', 'rocket']);
    expect(tm.searchKeyword(ftsMatchExpression(['rocket']), [7, 8], 10, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE)!.map((r) => r.messageId).sort()).toEqual([1, 3]);
    expect(tm.searchKeyword(ftsMatchExpression(['rocket']), [], 10, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE)).toEqual([]);
    expect(new TopicMemory(tmp()).searchKeyword('"x"*', [7], 10, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE)).toBeNull();
  });
});

describe('each channel maps to the ref and the history id', () => {
  const KEY = '11111111-1111-4111-8111-111111111111';
  async function deps(over: Partial<ConversationSearchRouteDeps> = {}) {
    const dir = tmp();
    const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    store.append({ eventId: 'c1', kind: 'created', conversationKey: KEY, at: '2026-11-09T09:00:00.000Z', machineId: 'm1', title: 'Plans' });
    store.append({ eventId: 'ev-op', kind: 'message', conversationKey: KEY, at: '2026-11-09T09:01:00.000Z', machineId: 'm1', messageId: 'msg-1', role: 'operator', text: 'Launch the rocket at noon' });
    store.append({ eventId: 'ev-ag', kind: 'message', conversationKey: KEY, at: '2026-11-09T09:02:00.000Z', machineId: 'm1', messageId: 'msg-2', role: 'agent', text: 'Rocket launch confirmed' });
    store.append({ eventId: 'ev-x', kind: 'message', conversationKey: KEY, at: '2026-11-09T09:03:00.000Z', machineId: 'm1', messageId: 'msg-3', role: 'agent', text: 'unrelated' });
    const tm = new TopicMemory(dir); memories.push(tm);
    await tm.open();
    tm.insertMessages([
      { messageId: 501, topicId: 42, text: 'rocket from the operator', fromUser: true, timestamp: '2026-11-09T10:00:00.000Z', sessionName: null },
      { messageId: 502, topicId: 42, text: 'rocket from the agent', fromUser: false, timestamp: '2026-11-09T10:01:00.000Z', sessionName: null },
      { messageId: 503, topicId: 42, text: 'rocket sent from the app', fromUser: true, timestamp: '2026-11-09T10:02:00.000Z', sessionName: null },
    ]);
    const service = { store, liveConversation: (k: string) => (k === KEY ? store.getConversation(k) : null) } as never;
    const d: ConversationSearchRouteDeps = {
      config: {} as never, pairing: {} as never, service, machineId: () => 'm1',
      topicMemory: () => tm,
      telegramTopics: () => [{ topicId: 42, topicName: 'Launches' }],
      telegramHistoryId: (_t, n) => (n === 503 ? 'app-event-503' : null),
      slack: () => ({
        conversations: () => [{ id: -9, title: '#general' }],
        history: () => [
          { ts: '1700000000.000100', text: 'rocket in slack', fromUser: true, at: '2026-11-09T11:00:00.000Z' },
          { ts: '1700000000.000200', text: 'rocket from the app into slack', fromUser: true, at: '2026-11-09T11:01:00.000Z', eventId: 'app-ev-slack' },
        ],
      }),
      ...over,
    };
    return d;
  }
  const all = { may: () => true, mayReadApp: () => true };

  it('app: app:<uuid> and the event id; Telegram: in:/out:<n> or the logged event id; Slack: slack:<ts> or its event id', async () => {
    const r = searchLocal(await deps(), { terms: ['rocket'], limit: 50, only: null }, all);
    const by = (ref: string) => r.results.filter((h) => h.ref === ref).map((h) => [h.messageId, h.fromUser, h.title]).sort();
    expect(by(`app:${KEY}`)).toEqual([['ev-ag', false, 'Plans'], ['ev-op', true, 'Plans']]);
    expect(by('telegram:42')).toEqual([['app-event-503', true, 'Launches'], ['in:501', true, 'Launches'], ['out:502', false, 'Launches']]);
    expect(by('slack:m1:-9')).toEqual([['app-ev-slack', true, '#general'], ['slack:1700000000.000100', true, '#general']]);
    expect(r.results.find((h) => h.platform === 'slack')!.machine).toBe('m1');
    for (const h of r.results) expect(marked(h.snippet, h.marks).every((w) => /^rocket$/i.test(w))).toBe(true);
    expect(r.capped).toBe(false);
    expect(r.unsearched).toEqual([]);
  });

  it('ref restricts to one conversation, and the limit holds', async () => {
    const d = await deps();
    expect(new Set(searchLocal(d, { terms: ['rocket'], limit: 50, only: 'telegram:42' }, all).results.map((h) => h.ref))).toEqual(new Set(['telegram:42']));
    expect(new Set(searchLocal(d, { terms: ['rocket'], limit: 50, only: `app:${KEY}` }, all).results.map((h) => h.ref))).toEqual(new Set([`app:${KEY}`]));
    expect(searchLocal(d, { terms: ['rocket'], limit: 50, only: 'slack:other:-9' }, all).results).toEqual([]);
    expect(searchLocal(d, { terms: ['rocket'], limit: 2, only: null }, all).results).toHaveLength(2);
  });

  it('never returns a conversation or message the caller may not read', async () => {
    const d = await deps();
    const r = searchLocal(d, { terms: ['rocket'], limit: 50, only: null }, {
      may: (k) => k === 'telegram:42' || k === KEY, mayReadApp: (_k, m) => m.eventId !== 'ev-ag',
    });
    expect(r.results.some((h) => h.platform === 'slack')).toBe(false);
    expect(r.results.filter((h) => h.platform === 'app').map((h) => h.messageId)).toEqual(['ev-op']);
  });

  it('an unopened index is reported as not searched, never as no hits', async () => {
    const r = searchLocal(await deps({ topicMemory: () => new TopicMemory(tmp()) }), { terms: ['rocket'], limit: 50, only: null }, all);
    expect(r.unsearched).toEqual(['telegram']);
  });
});

describe('peer hits', () => {
  const good = { ref: 'telegram:42', platform: 'telegram', title: 'T', messageId: 'in:5', at: '2026-11-09T10:00:00.000Z', fromUser: true, snippet: 'a rocket', marks: [{ start: 2, length: 6 }], rank: 1.5 };
  it('accepts a well-formed hit and re-checks every field', () => {
    expect(sanitizePeerHit(good, 'm2')).toMatchObject({ ref: 'telegram:42', messageId: 'in:5' });
    expect(sanitizePeerHit({ ...good, platform: 'app' }, 'm2')).toBeNull();
    expect(sanitizePeerHit({ ...good, ref: 'telegram:x' }, 'm2')).toBeNull();
    expect(sanitizePeerHit({ ...good, marks: [{ start: 5, length: 9 }] }, 'm2')).toBeNull();
    expect(sanitizePeerHit({ ...good, messageId: 'bad id' }, 'm2')).toBeNull();
    expect(sanitizePeerHit({ ...good, at: 'yesterday' }, 'm2')).toBeNull();
  });
  it('a peer may only answer for its own Slack conversations', () => {
    const slack = { ...good, ref: 'slack:m2:-4', platform: 'slack', messageId: 'slack:1.2' };
    expect(sanitizePeerHit(slack, 'm2')).toMatchObject({ machine: 'm2' });
    expect(sanitizePeerHit(slack, 'm3')).toBeNull();
  });
  it('the same message from two machines is listed once', () => {
    const a = sanitizePeerHit(good, 'm2')!;
    expect(dedupeHits([a, { ...a }])).toHaveLength(1);
  });
});

describe('the off switch', () => {
  const on = { mobilePairing: { enabled: true, native: { enabled: true } } };
  it('is on wherever native conversations are on, unless turned off', () => {
    expect(isConversationSearchEnabled(on as never)).toBe(true);
    expect(isConversationSearchEnabled({ mobilePairing: { enabled: true, native: { enabled: true, search: { enabled: false } } } } as never)).toBe(false);
    expect(isConversationSearchEnabled({ mobilePairing: { enabled: true, native: { enabled: false } } } as never)).toBe(false);
  });
});
