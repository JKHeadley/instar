/**
 * Unified usage ledger — Slice 5 (docs/specs/unified-usage-ledger.md): the token usage
 * section of "What thinking costs". Model rules, then the shipped console booted in a DOM.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildHeadline, buildSeries, buildDrill, drillQuery, buildTop, buildCacheRate, buildMachines, buildCoverage,
  buildUsageSection, ledgerOff, grainFor, MAX_SERIES, SERIES_COLORS,
} from '../../dashboard/console/usage-model.js';

const ok = (data: unknown) => ({ ok: true, data });
const fig = (tokens: number, usd: number, extra: Record<string, unknown> = {}) => ({
  calls: 3, tokens: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: tokens }, equivUsd: usd, unpricedTokens: 0, partialCalls: 0, ...extra,
});
const summary = (over: Record<string, unknown> = {}) => ok({
  since: '', until: '', scope: 'pool', notReached: [], warming: [], grain: 'day', unpricedShare: 0,
  total: fig(2_400_000, 9.6), machines: [{ machineId: 'm1', self: true, ...fig(2_000_000, 8), pull: null }, { machineId: 'm2', self: false, ...fig(400_000, 1.6), pull: { state: 'ok' } }],
  ...over,
});
const series = (keys: string[], buckets = 3) => ok({
  grain: 'day', split: 'model', keys,
  points: Array.from({ length: buckets }, (_, b) => ({
    bucket: new Date(Date.UTC(2026, 10, 1 + b)).toISOString(),
    series: Object.fromEntries(keys.map((k, i) => [k, { tokens: (i + 1) * 1000, equivUsd: (i + 1) / 100, unpricedTokens: 0, input: 100, cacheRead: 300, cacheWrite: 100 }])),
  })),
});

describe('usage model', () => {
  it('headline: tokens and list-price cost, with every caveat stated beside it', () => {
    const h = buildHeadline(summary({ unpricedShare: 0.05, notReached: ['m3'], warming: ['m4'], scope: 'this-machine-only', total: fig(2_400_000, 9.6, { unpricedTokens: 120_000, partialCalls: 4 }) }), 'this week');
    expect(h.line).toBe('2.4M tokens this week, about $9.60 at API list prices');
    expect(h.caveats.join(' | ')).toMatch(/120k tokens \(5%\) have no published price/);
    expect(h.caveats.join(' | ')).toMatch(/one machine was not reached/);
    expect(h.caveats.join(' | ')).toMatch(/one machine is still catching up/);
    expect(h.caveats.join(' | ')).toMatch(/this machine only/);
    expect(h.caveats.join(' | ')).toMatch(/4 requests did not report every count/);
    expect(h.basis).toMatch(/not what you were billed/);
  });

  it('series: stacked by key, at most six named series, the rest folded into Other with colour following the key', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const s = buildSeries(series(keys), 'model');
    expect(s.legend).toHaveLength(MAX_SERIES);
    expect(s.legend[MAX_SERIES - 1].key).toBe('Other');
    // Largest first: h (8k/bucket) is slot 0 in every bucket.
    expect(s.legend[0].key).toBe('h');
    expect(s.bars[0].parts[0].key).toBe('h');
    const other = s.bars[0].parts.find((p) => p.key === 'Other')!;
    expect(other.tokens).toBe(1000 + 2000 + 3000);
    expect(s.max).toBe(36_000);
    expect(SERIES_COLORS.dark).toHaveLength(MAX_SERIES);
  });

  it('drill query walks agent → machine → engine → model → conversation → session', () => {
    expect(drillQuery([], 1000)).toBe('/usage/tree?since=1000&by=machine');
    expect(drillQuery([{ dim: 'machine', key: 'm1' }, { dim: 'framework', key: 'claude-code' }], 1000))
      .toBe('/usage/tree?since=1000&by=model&parent=machine%3Am1%2Fframework%3Aclaude-code');
    expect(drillQuery([{ dim: 'machine', key: 'm' }, { dim: 'framework', key: 'f' }, { dim: 'model', key: 'x' }, { dim: 'topic', key: '1' }], 1)).toContain('by=session');
  });

  it('drill model: breadcrumb, bars, "other" not openable, unattributed named', () => {
    const d = buildDrill(ok({ root: { dim: 'agent', key: null, figure: fig(10, 1), children: [
      { dim: 'topic', key: null, figure: fig(6, 0.6) }, { dim: 'topic', key: '141063', figure: fig(3, 0.3) }, { dim: 'other', key: null, label: '4 more', figure: fig(1, 0.1) },
    ] } }), [{ dim: 'machine', key: 'm1' }]);
    expect(d.crumbs.map((c) => c.label)).toEqual(['Agent', 'Machine: m1']);
    expect(d.children.map((c) => c.label)).toEqual(['Not attributed', '141063', '4 more']);
    expect(d.children.map((c) => c.canOpen)).toEqual([false, true, false]);
    expect(d.max).toBe(6);
  });

  it('top lists use topic names, and say unpriced tokens', () => {
    const t = buildTop(ok({ items: [{ key: '141063', tokens: { total: 5000 }, equivUsd: 0.5, unpricedTokens: 10 }] }), 'topic', (k) => (k === '141063' ? 'Token usage' : k));
    expect(t.title).toBe('Conversations that cost most');
    expect(t.items[0].label).toBe('Token usage');
    expect(t.items[0].line).toBe('5,000 tokens · $0.50 · 10 unpriced');
  });

  it('cache hit rate is cache read over all input, and a bucket with no input has no rate', () => {
    const c = buildCacheRate(ok({ grain: 'day', points: [
      { bucket: '2026-11-01T00:00:00.000Z', series: { a: { input: 100, cacheRead: 300, cacheWrite: 100 } } },
      { bucket: '2026-11-02T00:00:00.000Z', series: {} },
    ] }));
    expect(c.points[0].rate).toBeCloseTo(0.6);
    expect(c.points[1].rate).toBeNull();
    expect(c.line).toBe('60% of input came from cache in the latest day');
  });

  it('machines: a not-reached machine says so instead of a zero', () => {
    const m = buildMachines(summary({ machines: [{ machineId: 'm1', self: true, ...fig(10, 1), pull: null }, { machineId: 'm2', self: false, ...fig(0, 0), pull: { state: 'not-reached' } }] }), (id) => (id === 'm1' ? 'Studio' : 'Laptop'));
    expect(m.rows.map((r) => [r.label, r.stateWord])).toEqual([['Studio (this one)', ''], ['Laptop', 'not reached']]);
  });

  it('coverage: attributed, priced and complete shares, and every unknown in words', () => {
    const c = buildCoverage(ok({ shares: { unattributed: 0.25, unpriced: 0.1, nullTokenCalls: 0.02 }, notRead: [{ source: 'pi session files', reason: 'no reader yet' }],
      pairs: { disputedTokens: 2000 }, counters: { invocations_dropped: 3 }, unpricedModels: { 'mystery-1': 50 } }));
    expect(c.items.map((i) => i.value)).toEqual(['75%', '90%', '98%']);
    expect(c.unknowns.join(' ')).toMatch(/Not measured: pi session files/);
    expect(c.unknowns.join(' ')).toMatch(/2,000 tokens are uncertain/);
    expect(c.unknowns.join(' ')).toMatch(/3 internal calls were not recorded/);
    expect(c.unknowns.join(' ')).toMatch(/No published price yet for/);
  });

  it('the whole section is hidden when the ledger is off or the server predates it', () => {
    expect(ledgerOff({ ok: false, reason: 'switched off on this agent' })).toBe(true);
    expect(ledgerOff({ ok: false, reason: 'the server answered 404' })).toBe(true);
    expect(ledgerOff({ ok: false, reason: 'the server could not be reached' })).toBe(false);
    expect(buildUsageSection({ summary: { ok: false, reason: 'switched off on this agent' } } as never).off).toBe(true);
    expect(grainFor('today')).toBe('hour');
    expect(grainFor('week')).toBe('day');
  });
});

describe('usage section in the shipped console', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  async function boot(table: Record<string, unknown>) {
    const got: string[] = [];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/capacity/costs' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string) => {
      got.push(url);
      const hit = Object.entries(table).find(([k]) => url.startsWith(k));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      const v = hit[1] as { status?: number; body?: unknown };
      if (v && typeof v === 'object' && 'status' in v) return { ok: false, status: v.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(typeof hit[1] === 'function' ? (hit[1] as (u: string) => unknown)(url) : hit[1])) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    return { doc: dom.window.document, got };
  }

  const usageTable = () => ({
    '/health': { project: { name: 'echo' } },
    '/sessions': { sessions: [] },
    '/usage/summary': summary().data,
    '/usage/series': series(['claude-opus-5-5', 'claude-haiku-5-5']).data,
    '/usage/tree': (url: string) => (url.includes('by=machine')
      ? { root: { dim: 'agent', key: null, figure: fig(10, 1), children: [{ dim: 'machine', key: 'm1', figure: fig(8, 0.8) }, { dim: 'machine', key: 'm2', figure: fig(2, 0.2) }] } }
      : { root: { dim: 'agent', key: null, figure: fig(8, 0.8), children: [{ dim: 'framework', key: 'claude-code', figure: fig(8, 0.8) }] } }),
    '/usage/top?dim=topic': { items: [{ key: '141063', tokens: { total: 9000 }, equivUsd: 0.9, unpricedTokens: 0 }] },
    '/usage/top?dim=job': { items: [] },
    '/usage/top?dim=feature': { items: [{ key: 'MessagingToneGate', tokens: { total: 700 }, equivUsd: 0.07, unpricedTokens: 0 }] },
    '/usage/coverage': { shares: { unattributed: 0.1, unpriced: 0, nullTokenCalls: 0 }, notRead: [], pairs: {}, counters: {}, unpricedModels: {} },
    '/telegram/topics': { topics: [{ topicId: 141063, topicName: 'Token usage tracking' }] },
    '/usage/events': { rows: [{ ts: Date.now(), model: 'claude-opus-5-5', tok_input: 5, tok_cache_read: 1, tok_cache_write: 0, tok_output: 2 }] },
  });

  it('draws headline, stacked chart with legend and table, drill-down, top lists by name, cache rate, machines and coverage — in that order', async () => {
    const { doc, got } = await boot(usageTable());
    const sec = doc.querySelector('.usage-section')!;
    expect(sec).not.toBeNull();
    expect(sec.querySelector('.usage-line')!.textContent).toBe('2.4M tokens this week, about $9.60 at API list prices');
    const order = [...sec.querySelectorAll('h3.eyebrow')].map((h) => h.textContent);
    expect(order).toEqual(['Usage over time', 'Where the tokens went', 'Conversations that cost most', 'Jobs that cost most', 'Checks that cost most', 'Cache hit rate', 'By machine', 'What is measured']);
    expect(sec.querySelectorAll('.usage-chart').length).toBe(2);
    expect([...sec.querySelectorAll('.usage-legend li')].map((l) => l.textContent)).toEqual(['Claude Haiku 5.5', 'Claude Opus 5.5']);
    expect(sec.querySelector('.usage-table summary')!.textContent).toBe('Show as a table');
    expect(sec.querySelector('.usage-top-name')!.textContent).toBe('Token usage tracking');
    expect(got.some((u) => /^\/usage\/series\?since=\d+&grain=day&split=model$/.test(u))).toBe(true);
    // Nothing from the spend routes was replaced: the older sections still render.
    expect(doc.querySelector('.page-sections')).not.toBeNull();
  });

  it('drilling into a machine asks for the next level with the machine as parent', async () => {
    const { doc, got } = await boot(usageTable());
    const row = [...doc.querySelectorAll('.usage-drill .usage-row')].find((b) => b.textContent!.startsWith('m1')) as HTMLButtonElement;
    row.click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got).toContain(got.find((u) => u.startsWith('/usage/tree') && u.includes('parent=machine%3Am1') && u.includes('by=framework')));
    expect([...doc.querySelectorAll('.usage-crumbs > *')].map((c) => c.textContent)).toEqual(['Agent', 'Machine: m1']);
    expect(doc.querySelector('.usage-drill .usage-row-label')!.textContent).toBe('Claude Code');
  });

  it('is absent when the ledger is switched off on this agent', async () => {
    const t = usageTable();
    const { doc } = await boot({ ...t, '/usage/summary': { status: 503 } });
    expect(doc.querySelector('.usage-section')).toBeNull();
  });
});
