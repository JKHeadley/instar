// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the topic-intent layer's brakes, ticks, projection and freshness
 * (context-budget-layered-summaries §6 H1/H2, §6.3, §6.4, §3.2 item 7).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicLayerBudget, tickDue, tickInterval, buildTickDigest, readTranscriptTail, TICK_MAX_CHARS, DEFAULT_TICK_BASE_MS } from '../../src/monitoring/contextLayers/layerCadence.js';
import { projectAwareness, phasePresent, layerFreshness } from '../../src/monitoring/contextLayers/layerProjection.js';
import { LayerTicker } from '../../src/monitoring/contextLayers/layerTicker.js';
import { LayerStore } from '../../src/monitoring/contextLayers/LayerStore.js';
import { renderTopicIntentBriefing } from '../../src/core/TopicIntentBriefing.js';
import type { TopicAwarenessState } from '../../src/core/TopicAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-layer-cadence.test.ts';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clc-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

const layer = (goal: string) => ({ goal, trend: 't', themes: ['a'], updatedAt: '2026-11-10T10:00:00.000Z', sourceMessageId: '7', sourceSpeaker: 'user' as const, sourceTurn: 3 });
function awareness(turnAtUpdate: number, arcStartedTurn: number, boundaryKind: 'initial' | 'explicit' | 'implicit' = 'explicit', currentWorkSource = '7'): TopicAwarenessState {
  return {
    version: 1,
    anchor: { goal: 'ship', capturedAt: '2026-11-10T09:00:00.000Z', sourceMessageId: '1', sourceTurn: 1 },
    topic: layer('whole topic'),
    arcs: [{ arcId: 'arc-1', sequence: 1, status: 'active', startedAt: '2026-11-10T09:00:00.000Z', startedTurn: arcStartedTurn, boundaryKind, boundaryMessageId: '1', layer: layer('phase goal') }],
    currentArcId: 'arc-1',
    currentWork: { ...layer('current work goal'), sourceMessageId: currentWorkSource },
    recentArcEvents: [], archivedArcCount: 0,
    updatedAt: '2026-11-10T10:00:00.000Z', turnAtUpdate,
  } as TopicAwarenessState;
}

describe('TopicLayerBudget', () => {
  it('admits within the per-topic ceiling, then defers and counts', () => {
    const b = new TopicLayerBudget({ limits: () => ({ perTopicDailyInputTokens: 100, componentDailyInputTokens: 1000 }), now: () => 0 });
    expect(b.admit('t', 60)).toEqual({ ok: true });
    expect(b.admit('t', 60)).toEqual({ ok: false, reason: 'topic-ceiling' });
    expect(b.admit('u', 60)).toEqual({ ok: true });
    expect(b.status().deferred.topic).toBe(1);
    expect(b.status().topics.find((x) => x.topicKey === 't')).toMatchObject({ inputTokens24h: 60, deferred: 1 });
  });

  it('the component ceiling holds across topics, and the window rolls after 24 h', () => {
    let t = 0;
    const b = new TopicLayerBudget({ limits: () => ({ perTopicDailyInputTokens: 1000, componentDailyInputTokens: 100 }), now: () => t });
    expect(b.admit('a', 60).ok).toBe(true);
    expect(b.admit('b', 60)).toEqual({ ok: false, reason: 'component-ceiling' });
    t = 86_400_001;
    expect(b.admit('b', 60).ok).toBe(true);
  });
});

describe('tick policy', () => {
  it('skips mid-turn, without growth, and inside the interval; the interval grows with recent updates', () => {
    const s = { lastTickAt: 0, lastSize: 100, recentUpdates: [] as number[] };
    const base = DEFAULT_TICK_BASE_MS;
    expect(tickDue(s, { now: base + 1, size: 200, midTurn: true })).toEqual({ due: false, reason: 'mid-turn' });
    expect(tickDue(s, { now: base + 1, size: 100, midTurn: false })).toEqual({ due: false, reason: 'not-grown' });
    expect(tickDue(s, { now: base - 1, size: 200, midTurn: false })).toEqual({ due: false, reason: 'interval' });
    expect(tickDue(s, { now: base + 1, size: 200, midTurn: false })).toEqual({ due: true });
    const busy = { ...s, recentUpdates: [base, base, base] };
    expect(tickDue(busy, { now: base + 1, size: 200, midTurn: false })).toEqual({ due: false, reason: 'interval' });
    expect(tickInterval(base, 0)).toBe(base);
    expect(tickInterval(base, 2)).toBe(Math.round(base * 2.25));
    expect(tickInterval(base, 50)).toBe(base * 6);
  });
});

describe('buildTickDigest', () => {
  const call = (name: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } });
  const result = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });

  it('keeps the last K tool names, edges of each result, scrubbed, and discloses the sample', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) { lines.push(call(`Tool${i}`)); lines.push(result(`start-${i} ${'x'.repeat(3000)} end-${i}`)); }
    lines.push(result(`leaked ghp_${'a'.repeat(36)} here`));
    const d = buildTickDigest(lines)!;
    expect(d.toolNames).toHaveLength(12);
    expect(d.toolNames[11]).toBe('Tool19');
    expect(d.text).toMatch(/^\[transcript-growth tick: \d+ of 21 recent tool results sampled, newest first; last tools: /);
    expect(d.text).not.toContain('a'.repeat(36));
    expect(d.text.length).toBeLessThanOrEqual(TICK_MAX_CHARS);
    expect(d.text).toContain('end-19');
    expect(d.text).not.toContain('x'.repeat(1200));
    expect(d.sampled).toBeGreaterThan(0);
    // The disclosure counts exactly the results carried.
    expect((d.text.match(/--- result \d+ \(newest first\) ---/g) ?? []).length).toBe(d.sampled);
    expect(d.text).toMatch(new RegExp(`^\\[transcript-growth tick: ${d.sampled} of`));
  });

  it('scrubs the WHOLE result before cutting it, so a secret straddling a cut leaves no fragment; live values too', () => {
    const tokenAt480 = 'p'.repeat(479) + ` ghp_${'c'.repeat(36)} ` + 'q'.repeat(2000);
    const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'K'.repeat(1500) + '\n-----END RSA PRIVATE KEY-----';
    const lines = [result(tokenAt480), result(pem), result('the token LIVEVALUE-0123456789abc leaked')];
    const d = buildTickDigest(lines, { liveSecrets: ['LIVEVALUE-0123456789abc'] })!;
    expect(d.text).not.toMatch(/ghp_c{4,}/);
    expect(d.text).not.toContain('KKKKKKKKKK');
    expect(d.text).not.toContain('LIVEVALUE-0123456789abc');
  });

  it('returns null when the tail has no tool activity, and skips torn lines', () => {
    expect(buildTickDigest(['{"type":"user","message":{"content":"hi"}}', '{torn'])).toBeNull();
  });

  it('reads whole lines from a transcript tail', () => {
    const f = path.join(tmp(), 't.jsonl');
    fs.writeFileSync(f, ['a'.repeat(50), 'b', 'c'].join('\n') + '\n');
    expect(readTranscriptTail(f, 10)!.lines).toEqual(['b', 'c']);
    expect(readTranscriptTail(path.join(tmp(), 'missing'), 10)).toBeNull();
  });
});

describe('projection into the layer store', () => {
  const ctx = { machine: 'm1', model: null, sessionId: null, lastMessageId: 42, origin: 'message' as const };

  it('writes H1 always and H2 only once a phase exists (§6.3); the record carries author and as-of', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [] });
    expect(phasePresent(awareness(3, 2))).toBe(false);
    expect(phasePresent(awareness(9, 1, 'initial'))).toBe(false); // the topic's initial arc is never a phase
    expect(projectAwareness(store, '141133', awareness(3, 2), ctx)).toEqual({ h1: 'written', h2: 'absent' });
    expect(store.read('141133', 'h2', 'current')?.status).toBe('absent');
    const h1 = store.read('141133', 'h1', 'current')!;
    expect(h1.data.goal).toBe('current work goal');
    expect(h1.author).toEqual({ sessionId: null, machine: 'm1', model: null, kind: 'derived' });
    expect(h1.asOf).toEqual({ at: Date.parse('2026-11-10T10:00:00.000Z'), lastMessageId: 42 });
    expect(projectAwareness(store, '141133', awareness(6, 2), ctx)).toEqual({ h1: 'written', h2: 'written' });
    expect(store.read('141133', 'h2', 'current')!.data.goal).toBe('phase goal');
    // The phase ends (a fresh arc) → H2 is removed, so the packet can say there is none.
    const h2Written = store.read('141133', 'h2', 'current')!.writtenAt;
    // Unchanged phase: not rewritten (§6 "every arc change").
    projectAwareness(store, '141133', awareness(7, 2), ctx);
    expect(store.read('141133', 'h2', 'current')!.writtenAt).toBe(h2Written);
    expect(projectAwareness(store, '141133', awareness(7, 7), ctx).h2).toBe('absent');
    expect(store.read('141133', 'h2', 'current')).toMatchObject({ status: 'absent', data: { present: false } });
  });

  it('a tick-derived H1 is tagged origin tool and discloses the sample', () => {
    const store = new LayerStore({ stateDir: tmp(), liveSecrets: () => [] });
    projectAwareness(store, 't', awareness(3, 2), { ...ctx, lastMessageId: null, origin: 'tool', sampled: 4 });
    const h1 = store.read('t', 'h1', 'current')!;
    expect(h1.data).toMatchObject({ origin: 'tool', disclosure: '4 results sampled' });
    expect(h1.status).toBe('tool');
  });

  it('freshness: n messages behind against TopicMemory; unknown never reads as fresh', () => {
    const rec = { asOf: { at: Date.parse('2026-11-10T10:00:00.000Z'), lastMessageId: 42 } };
    expect(layerFreshness(rec, () => ({ total: 5, fromUser: 2 }))).toMatchObject({ messagesBehind: 5, userTurnsBehind: 2, stale: false, line: 'as of 2026-11-10T10:00:00.000Z, 5 messages behind' });
    expect(layerFreshness(rec, () => ({ total: 9, fromUser: 3 })).stale).toBe(true);
    expect(layerFreshness(rec, () => null)).toMatchObject({ stale: 'unknown', line: 'as of 2026-11-10T10:00:00.000Z, stale: unknown' });
    expect(layerFreshness({ asOf: { at: 0, lastMessageId: null } }, () => ({ total: 0, fromUser: 0 })).stale).toBe('unknown');
    expect(layerFreshness(rec, () => { throw new Error('db'); }).stale).toBe('unknown');
  });
});

describe('LayerTicker', () => {
  function transcript(dir: string, n: number): string {
    const f = path.join(dir, 's.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `out ${i}` }] } }));
    }
    fs.writeFileSync(f, lines.join('\n') + '\n');
    return f;
  }

  it('baselines on first sight, ticks on growth past the interval, never mid-turn, and defers over budget without losing the growth', async () => {
    const d = tmp();
    const f = transcript(d, 3);
    let now = 0;
    let midTurn = false;
    const fed: string[] = [];
    const budget = new TopicLayerBudget({ limits: () => ({ perTopicDailyInputTokens: 1_000_000, componentDailyInputTokens: 1_000_000 }), now: () => now });
    const ticker = new LayerTicker({
      sessions: () => [{ topicId: 141133, sessionKey: 's1', transcriptPath: f, tmuxSession: 'tm' }],
      midTurn: () => midTurn, budget, now: () => now, baseMs: 1000,
      ingest: async (_s, dg) => { fed.push(dg.text); return 'updated' as const; },
    });
    await ticker.pass();
    expect(ticker.status().skipped.notGrown).toBe(1);
    fs.appendFileSync(f, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'new output' }] } }) + '\n');
    now = 2000; midTurn = true;
    await ticker.pass();
    expect(ticker.status().skipped.midTurn).toBe(1);
    midTurn = false;
    await ticker.pass();
    expect(ticker.status().ticks).toBe(1);
    expect(fed[0]).toContain('new output');
    // Over budget: deferred, and the same growth is retried later.
    const tight = new TopicLayerBudget({ limits: () => ({ perTopicDailyInputTokens: 1, componentDailyInputTokens: 1 }), now: () => now });
    const t2 = new LayerTicker({ sessions: () => [{ topicId: 1, sessionKey: 's2', transcriptPath: f, tmuxSession: 'tm' }], midTurn: () => false, budget: tight, now: () => now, baseMs: 1, ingest: async () => 'updated' as const });
    await t2.pass();
    fs.appendFileSync(f, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'more' }] } }) + '\n');
    now += 10;
    await t2.pass();
    expect(t2.status().skipped.budget).toBe(1);
    await t2.pass();
    expect(t2.status().skipped.budget).toBe(2); // still due: the size was not advanced
  });

  it('a shed or failed tick does not consume the growth: the next due pass retries it', async () => {
    const d = tmp();
    const f = transcript(d, 1);
    let now = 0;
    const outcomes: Array<'shed' | 'failed' | 'updated'> = ['shed', 'failed', 'updated'];
    const ticker = new LayerTicker({ sessions: () => [{ topicId: 1, sessionKey: 'k', transcriptPath: f, tmuxSession: 'tm' }], midTurn: async () => false, budget: new TopicLayerBudget(), now: () => now, baseMs: 1, ingest: async () => outcomes.shift()! });
    await ticker.pass();
    fs.appendFileSync(f, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'g' }] } }) + '\n');
    for (const t of [10, 20, 30]) { now = t; await ticker.pass(); }
    expect(ticker.status()).toMatchObject({ ticks: 1, updated: 1, failed: 1, skipped: expect.objectContaining({ shed: 1 }) });
  });

  it('an ingest failure is counted, and a vanished session is forgotten', async () => {
    const d = tmp();
    const f = transcript(d, 1);
    let now = 0;
    let list = [{ topicId: 1, sessionKey: 'gone', transcriptPath: f, tmuxSession: 'tm' }];
    const ticker = new LayerTicker({ sessions: () => list, midTurn: () => false, budget: new TopicLayerBudget(), now: () => now, baseMs: 1, ingest: async () => { throw new Error('x'); } });
    await ticker.pass();
    fs.appendFileSync(f, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'z' }] } }) + '\n');
    now = 10;
    await ticker.pass();
    expect(ticker.status().failed).toBe(1);
    list = [];
    await ticker.pass();
    expect(ticker.status().passes).toBe(3);
  });
});

describe('briefing freshness stamp', () => {
  it('renders the stamp on the CURRENT WORK block, flagging stale and unknown', () => {
    const file = { awareness: awareness(5, 1), turn: 5, pending: { outstanding: false } };
    const store = { read: () => file, getRefsAtOrAbove: () => [] } as never;
    expect(renderTopicIntentBriefing(store, 1, { freshness: { line: 'as of X, 1 messages behind', stale: false } }).text).toContain('    as of X, 1 messages behind\n');
    expect(renderTopicIntentBriefing(store, 1, { freshness: { line: 'as of X, 9 messages behind', stale: true } }).text).toContain('STALE: behind its freshness target');
    expect(renderTopicIntentBriefing(store, 1, { freshness: { line: 'as of X, stale: unknown', stale: 'unknown' } }).text).toContain('freshness unknown');
    expect(renderTopicIntentBriefing(store, 1).text).not.toContain('as of');
  });
});
