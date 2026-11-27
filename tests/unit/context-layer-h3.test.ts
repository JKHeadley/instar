// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — H3, the long-term view and the topic summary table's single writer
 * (context-budget-layered-summaries §6 row H3, §6.5 "H3 bounded", §12, §14;
 * Phase 1 S9). Real LayerStore, real TopicMemory (SQLite), a fake model.
 *
 * Both sides of every boundary: the floor kept over budget vs ranges cut to
 * C2 / omitted; layers on (H3 writes the table, legacy writers refused) vs off
 * (legacy writes, H3 refused); budget admitted vs deferred; valid vs refused
 * output; inside vs outside the debounce window; and the single-caller
 * ratchet on `saveTopicSummary(`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LayerStore, type LayerMeta, type ReplicateLayer } from '../../src/monitoring/contextLayers/LayerStore.js';
import { TopicLayerBudget } from '../../src/monitoring/contextLayers/layerCadence.js';
import { H3Builder, selectH3Inputs, validateH3Json, renderH3, phaseBoundaryFrom, rangeBlock, H3_KEY, H3_LEGACY_KEY, type H3Event } from '../../src/monitoring/contextLayers/h3Builder.js';
import { TopicSummaryTable, H3_OWNS_REASON } from '../../src/memory/TopicSummaryTable.js';
import { TopicSummarizer } from '../../src/memory/TopicSummarizer.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-layer-h3.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = '4242';
const GOOD = JSON.stringify({ purpose: 'Building the H3 long-term view for the context budget.', summary: 'The agent built chunk summaries, then a range, then H3.' });

const dirs: string[] = [];
const mems: TopicMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) m.close();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});

function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-unit-')); dirs.push(d); return d; }
const meta = (status: string, lastMessageId: number | null = null): LayerMeta => ({ author: { sessionId: null, machine: 'm', model: null, kind: 'derived' }, asOf: { at: 1_700_000_000_000, lastMessageId }, status });

function store(replicate?: ReplicateLayer): LayerStore {
  return new LayerStore({ stateDir: tmp(), liveSecrets: () => [], replicate });
}

/** A closed span chunk with roughly `words` words of summary. */
function chunk(s: LayerStore, seq: number, o: { rangeId?: string; ids?: number[]; words?: number; status?: string } = {}): void {
  const summary = Array.from({ length: o.words ?? 20 }, (_, i) => `w${seq}_${i}`).join(' ');
  s.writeDerived(T, 'chunk', `s${seq}`, {
    kind: 'span', seq, attempted: `attempt ${seq}`, outcome: `outcome ${seq}`, summary, artifacts: [`file${seq}.ts`], openThreads: [],
    messageIds: o.ids ?? [seq * 10], ...(o.rangeId ? { rangeId: o.rangeId } : {}),
    ...(o.status === 'pending' ? { gap: `unsummarized gap: entries e${seq}..e${seq}, chunk pending` } : {}),
  }, meta(o.status ?? 'closed'));
}
function range(s: LayerStore, from: number, to: number, words = 20): void {
  const rangeId = `r-${from}-${to}`;
  s.writeDerived(T, 'c2', rangeId, {
    kind: 'range', rangeId, seqRange: [from, to], chunkKeys: Array.from({ length: to - from + 1 }, (_, i) => `s${from + i}`),
    summary: Array.from({ length: words }, (_, i) => `range${from}_${i}`).join(' '), artifacts: [], messageIds: [to * 10],
  }, meta('closed'));
}

async function topicMemory(): Promise<TopicMemory> {
  const tm = new TopicMemory(tmp()); await tm.open(); mems.push(tm);
  for (let i = 1; i <= 60; i++) tm.insertMessage({ messageId: i * 10, topicId: Number(T), text: `message ${i}`, fromUser: i % 2 === 1, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(), sessionName: null });
  return tm;
}

function builder(s: LayerStore, o: { tm?: TopicMemory | null; owner?: boolean; reply?: string | (() => Promise<string>); calls?: string[]; events?: H3Event[]; budget?: TopicLayerBudget; inputTokens?: number; hardCeiling?: number; requestRangeClose?: (k: string) => Promise<boolean>; intelligence?: null; now?: () => number; timers?: Array<{ fn: () => void; ms: number }> } = {}) {
  const calls = o.calls ?? [];
  const tm = o.tm ?? null;
  return new H3Builder({
    store: s, budget: o.budget ?? new TopicLayerBudget(),
    intelligence: o.intelligence === null ? null : { evaluate: async (p: string) => { calls.push(p); return typeof o.reply === 'function' ? o.reply() : (o.reply ?? GOOD); } },
    table: tm ? new TopicSummaryTable(tm, () => o.owner ?? true) : null,
    readSummary: (id) => tm?.getTopicSummary(id) ?? null,
    countMessagesAfter: (id, m) => tm?.countMessagesAfter(id, m) ?? null,
    messageCount: (id) => tm?.getMessageCount(id) ?? 0,
    requestRangeClose: o.requestRangeClose,
    machine: 'm_unit', inputTokens: o.inputTokens, hardCeiling: o.hardCeiling, now: o.now,
    setTimer: o.timers ? (fn, ms) => { o.timers!.push({ fn, ms }); return o.timers!.length; } : undefined,
    clearTimer: o.timers ? () => undefined : undefined,
    onEvent: (e) => o.events?.push(e),
  });
}

describe('selectH3Inputs — the bounded selection (§6.5)', () => {
  it('reads every range directly when the budget allows, in story order, with the highest message id', () => {
    const s = store();
    for (let i = 1; i <= 4; i++) chunk(s, i, { rangeId: 'r-1-4' });
    range(s, 1, 4);
    chunk(s, 5); chunk(s, 6);
    const sel = selectH3Inputs(s, T, { budgetTokens: 24_000 });
    expect(sel.rangesDirect).toEqual(['r-1-4']);
    expect(sel.rangesThroughC2).toEqual([]);
    expect(sel.blocks.map((b) => b.key)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(sel.floor.map((b) => b.key)).toEqual(['s5', 's6']);
    expect(sel.lastMessageId).toBe(60);
    expect(sel.substantive).toBe(7);
  });

  it('under a tight budget, older ranges are read through C2 and the oldest are left out — never the open chunks, and it says so in-band', () => {
    const s = store();
    for (let i = 1; i <= 9; i++) chunk(s, i, { rangeId: `r-${Math.floor((i - 1) / 3) * 3 + 1}-${Math.floor((i - 1) / 3) * 3 + 3}`, words: 200 });
    range(s, 1, 3, 150); range(s, 4, 6, 150); range(s, 7, 9, 150);
    chunk(s, 10, { words: 400 }); chunk(s, 11, { words: 400 });
    // §6.5: past the budget older ranges are read through C2 only, never dropped (the ceiling is far away).
    const c2Read = selectH3Inputs(s, T, { budgetTokens: 1 });
    expect(c2Read.rangesThroughC2).toEqual(['r-7-9', 'r-4-6', 'r-1-3']);
    expect(c2Read.rangesOmitted).toEqual([]);
    expect(c2Read.rangesDirect).toEqual([]);
    // Omission happens only past the ceiling.
    const floorOnly = selectH3Inputs(s, T, { budgetTokens: 1, ceilingTokens: 1 });
    expect(floorOnly.floor.map((b) => b.key)).toEqual(['s10', 's11']);
    expect(floorOnly.floorOverBudget).toBe(true);
    expect(floorOnly.rangesOmitted).toEqual(['r-7-9', 'r-4-6', 'r-1-3']);
    expect(floorOnly.blocks.map((b) => b.key)).toEqual(['s10', 's11']);
    const c2Tokens = (id: string) => rangeBlock(s.read(T, 'c2', id)!).tokens;
    // Room for the floor + the two newest C2 summaries (not enough to read a range through its members): the oldest is left out.
    const cap = floorOnly.floorTokens + c2Tokens('r-7-9') + c2Tokens('r-4-6');
    const r = selectH3Inputs(s, T, { budgetTokens: cap, ceilingTokens: cap });
    expect(r.rangesThroughC2).toEqual(['r-7-9', 'r-4-6']);
    expect(r.rangesOmitted).toEqual(['r-1-3']);
    expect(r.rangesDirect).toEqual([]);
    expect(r.blocks.map((b) => b.key)).toEqual(['r-4-6', 'r-7-9', 's10', 's11']);
    expect(r.disclosure).toContain('ranges read through their C2 summary: r-4-6, r-7-9');
    expect(r.disclosure).toContain('left out over the');
    expect(r.disclosure).toContain('input ceiling');
    expect(r.tokens).toBeLessThanOrEqual(r.budgetTokens);
  });

  it('chunks referenced by the current phase are floor even inside a range; with no phase they are not', () => {
    const s = store();
    for (let i = 1; i <= 3; i++) chunk(s, i, { rangeId: 'r-1-3', ids: [i * 10] });
    range(s, 1, 3);
    chunk(s, 4);
    expect(selectH3Inputs(s, T, { budgetTokens: 1, phaseBoundaryMessageId: null }).floor.map((b) => b.key)).toEqual(['s4']);
    expect(selectH3Inputs(s, T, { budgetTokens: 1, phaseBoundaryMessageId: 20 }).floor.map((b) => b.key)).toEqual(['s2', 's3', 's4']);
  });

  it('pending chunks and the pre-layer pointer stay in the floor as visible gaps; c2Only reads every range through C2', () => {
    const s = store();
    s.writeDerived(T, 'chunk', 'pre-layer', { kind: 'pre-layer', seq: 0, summary: 'History before the layers began.' }, meta('closed'));
    for (let i = 1; i <= 2; i++) chunk(s, i, { rangeId: 'r-1-2' });
    range(s, 1, 2);
    chunk(s, 3, { status: 'pending' });
    const sel = selectH3Inputs(s, T, { c2Only: true });
    expect(sel.rangesThroughC2).toEqual(['r-1-2']);
    const text = sel.blocks.map((b) => b.text).join('\n');
    expect(text).toContain('[pre-layer] History before the layers began.');
    expect(text).toContain('unsummarized gap: entries e3..e3, chunk pending');
  });

  it('phaseBoundaryFrom reads the live H2 boundary, else nothing', () => {
    const s = store();
    expect(phaseBoundaryFrom(s, T)).toBeNull();
    s.writeDerived(T, 'h2', 'current', { goal: 'g', boundaryMessageId: '120', sourceMessageId: '300' }, meta('live'));
    expect(phaseBoundaryFrom(s, T)).toBe(120);
    s.writeDerived(T, 'h2', 'current', { present: false }, meta('absent'));
    expect(phaseBoundaryFrom(s, T)).toBeNull();
  });
});

describe('validateH3Json — strict output', () => {
  const src = 'chunk text with the exact phrase "ship the gate as warn-only" inside';
  it('accepts a one-line purpose and a summary', () => {
    expect(validateH3Json(GOOD, src)).toMatchObject({ ok: true });
  });
  it.each([
    ['extra fields', JSON.stringify({ purpose: 'p', summary: 's', extra: 1 })],
    ['multi-line purpose', JSON.stringify({ purpose: 'a\nb', summary: 's' })],
    ['empty summary', JSON.stringify({ purpose: 'p', summary: ' ' })],
    ['not JSON', 'sure, here it is'],
    ['oversize', JSON.stringify({ purpose: 'p', summary: 'x'.repeat(20_001) })],
    ['an invented quotation', JSON.stringify({ purpose: 'p', summary: 'The operator said "make the gate block everything".' })],
  ])('refuses %s', (_n, raw) => { expect(validateH3Json(raw, src).ok).toBe(false); });
  it('accepts a quotation copied exactly from the input', () => {
    expect(validateH3Json(JSON.stringify({ purpose: 'p', summary: 'The plan was "ship the gate as warn-only".' }), src).ok).toBe(true);
  });
});

describe('TopicSummaryTable — the single writer funnel', () => {
  it('layers on: H3 writes, the legacy writers are refused with a plain reason', () => {
    const saved: unknown[] = [];
    const t = new TopicSummaryTable({ saveTopicSummary: (...a: unknown[]) => { saved.push(a); } }, () => true);
    expect(t.write('topic-summarizer', 1, 's', 1, 1)).toEqual({ written: false, writer: 'topic-summarizer', reason: 'summary-written-by-h3' });
    expect(t.write('post-topic-summary', 1, 's', 1, 1)).toMatchObject({ written: false, reason: 'summary-written-by-h3' });
    expect(t.write('h3', 1, 's', 1, 1, 'p')).toEqual({ written: true, writer: 'h3' });
    expect(saved).toEqual([[1, 's', 1, 1, 'p']]);
    expect(H3_OWNS_REASON).toMatch(/only by the H3 layer/);
  });
  it('layers off: the legacy writers write exactly as before and H3 is refused', () => {
    const saved: unknown[] = [];
    const t = new TopicSummaryTable({ saveTopicSummary: (...a: unknown[]) => { saved.push(a); } }, () => false);
    expect(t.write('h3', 1, 's', 1, 1)).toMatchObject({ written: false, reason: 'layers-off' });
    expect(t.write('topic-summarizer', 1, 's', 2, 3, null)).toEqual({ written: true, writer: 'topic-summarizer' });
    expect(t.write('post-topic-summary', 1, 's', 2, 3)).toMatchObject({ written: true });
    expect(saved).toHaveLength(2);
  });
  it('a backend failure propagates as it did before the funnel', () => {
    const t = new TopicSummaryTable({ saveTopicSummary: () => { throw new Error('disk full'); } }, () => false);
    expect(() => t.write('post-topic-summary', 1, 's', 1, 1)).toThrow('disk full');
  });
});

describe('TopicSummarizer — disabled while H3 owns the table', () => {
  it('layers on: no model call and no write', async () => {
    const tm = await topicMemory();
    const calls: string[] = [];
    const sz = new TopicSummarizer({ evaluate: async (p: string) => { calls.push(p); return 'PURPOSE: x\n\nsummary text here'; } }, tm, { messageThreshold: 1 }, new TopicSummaryTable(tm, () => true));
    expect(sz.enabled()).toBe(false);
    expect(await sz.summarize(Number(T), true)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(tm.getTopicSummary(Number(T))).toBeNull();
  });
  it('layers off (no table given): writes exactly as before', async () => {
    const tm = await topicMemory();
    const sz = new TopicSummarizer({ evaluate: async () => 'PURPOSE: Legacy focus\n\nLegacy summary text.' }, tm, { messageThreshold: 1 });
    expect(sz.enabled()).toBe(true);
    const r = await sz.summarize(Number(T));
    expect(r).toMatchObject({ purpose: 'Legacy focus', summary: 'Legacy summary text.' });
    expect(tm.getTopicSummary(Number(T))).toMatchObject({ summary: 'Legacy summary text.', lastMessageId: 600 });
  });
});

describe('H3Builder — build, table, brakes', () => {
  it('writes the H3 record (author, asOf) and the table through the funnel, retiring the legacy summary first', async () => {
    const tm = await topicMemory();
    tm.saveTopicSummary(Number(T), 'The old rolling summary.', 10, 100, 'Old purpose');
    const s = store();
    chunk(s, 1, { ids: [100, 200] }); chunk(s, 2, { ids: [300] });
    const events: H3Event[] = [];
    await builder(s, { tm, events }).build(T);
    const rec = s.read(T, 'h3', H3_KEY)!;
    expect(rec.status).toBe('live');
    expect(rec.author).toMatchObject({ machine: 'm_unit', kind: 'derived' });
    expect(rec.asOf.lastMessageId).toBe(300);
    expect(rec.data).toMatchObject({ purpose: 'Building the H3 long-term view for the context budget.', chunkKeys: ['s1', 's2'] });
    const row = tm.getTopicSummary(Number(T))!;
    expect(row.lastMessageId).toBe(300);
    expect(row.purpose).toBe('Building the H3 long-term view for the context budget.');
    expect(row.summary).toBe(renderH3(rec));
    expect(row.summary).toMatch(/^\[Long-term view \(H3\), as of .*covers topic messages through 300/);
    // 60 messages, 30 after id 300 ⇒ 30 covered.
    expect(row.messageCountAtSummary).toBe(30);
    const legacy = s.read(T, 'h3', H3_LEGACY_KEY)!;
    expect(legacy.status).toBe('retired');
    expect(legacy.data).toMatchObject({ summary: 'The old rolling summary.', purpose: 'Old purpose', lastMessageId: 100 });
    expect(events.map((e) => e.kind)).toEqual(['written', 'legacy-retired']);
  });

  it('layers off: the funnel refuses H3, the table is untouched', async () => {
    const tm = await topicMemory();
    const s = store();
    chunk(s, 1);
    const b = builder(s, { tm, owner: false });
    await b.build(T);
    expect(s.read(T, 'h3', H3_KEY)).not.toBeNull();
    expect(tm.getTopicSummary(Number(T))).toBeNull();
    expect(b.status()).toMatchObject({ tableRefused: 1, tableWrites: 0 });
  });

  it('nothing to build (only a pre-layer pointer): no model call, no write', async () => {
    const s = store();
    s.writeDerived(T, 'chunk', 'pre-layer', { kind: 'pre-layer', seq: 0, summary: 'x' }, meta('closed'));
    const calls: string[] = [];
    const b = builder(s, { calls });
    await b.build(T);
    expect(calls).toHaveLength(0);
    expect(s.read(T, 'h3', H3_KEY)).toBeNull();
    expect(b.status().nothingToBuild).toBe(1);
  });

  it('budget denied: deferred, no call, the previous H3 stands', async () => {
    const s = store();
    chunk(s, 1);
    const calls: string[] = [];
    const budget = new TopicLayerBudget({ limits: () => ({ perTopicDailyInputTokens: 10, componentDailyInputTokens: 10 }) });
    const events: H3Event[] = [];
    await builder(s, { calls, budget, events }).build(T);
    expect(calls).toHaveLength(0);
    expect(s.read(T, 'h3', H3_KEY)).toBeNull();
    expect(events[0]).toMatchObject({ kind: 'deferred', detail: 'budget deferred: topic-ceiling' });
  });

  it('a failed call refunds the reservation; a refused output writes nothing', async () => {
    const s = store();
    chunk(s, 1);
    const budget = new TopicLayerBudget();
    await builder(s, { budget, reply: async () => { throw new Error('provider down'); } }).build(T);
    expect(budget.status().topics.find((t) => t.topicKey === T)?.inputTokens24h ?? 0).toBe(0);
    const events: H3Event[] = [];
    await builder(s, { reply: JSON.stringify({ purpose: 'p', summary: 'They said "this was never in the input at all".' }), events }).build(T);
    expect(s.read(T, 'h3', H3_KEY)).toBeNull();
    expect(events[0].kind).toBe('refused');
  });

  it('no model on the machine: deferred and visible', async () => {
    const s = store();
    chunk(s, 1);
    const b = builder(s, { intelligence: null });
    await b.build(T);
    expect(b.status().deferred).toBe(1);
  });

  it('floor over budget asks once for a range close; over the hard ceiling nothing is sent', async () => {
    const s = store();
    chunk(s, 1, { words: 400 }); chunk(s, 2, { words: 400 });
    let asked = 0;
    const calls: string[] = [];
    await builder(s, { calls, inputTokens: 10, requestRangeClose: async () => { asked++; return false; } }).build(T);
    expect(asked).toBe(1);
    expect(calls).toHaveLength(1);
    const calls2: string[] = [];
    const events: H3Event[] = [];
    await builder(s, { calls: calls2, inputTokens: 10, hardCeiling: 50, events }).build(T);
    expect(calls2).toHaveLength(0);
    expect(events.map((e) => e.kind)).toEqual(['floor-over-budget', 'deferred']);
    expect(events[1].detail).toMatch(/^floor-over-ceiling/);
  });

  it('an H3 over the replicated cap is rebuilt ONCE under a tighter C2 selection, with disclosure', async () => {
    let n = 0;
    const s = store((i) => (i.recordType === 'h3' && ++n === 1 ? 'oversize' : 'emitted'));
    for (let i = 1; i <= 2; i++) chunk(s, i, { rangeId: 'r-1-2' });
    range(s, 1, 2);
    chunk(s, 3);
    const calls: string[] = [];
    const b = builder(s, { calls });
    await b.build(T);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('too large to replicate');
    const rec = s.read(T, 'h3', H3_KEY)!;
    expect(rec.data).toMatchObject({ tight: true, rangesThroughC2: ['r-1-2'] });
    expect(String(rec.data.disclosure)).toContain('tighter range selection');
    expect(b.status().oversizeRebuilt).toBe(1);
  });

  it('the prompt fences the input as data and forbids rewording the operator', async () => {
    const s = store();
    chunk(s, 1);
    const calls: string[] = [];
    await builder(s, { calls }).build(T);
    expect(calls[0]).toMatch(/<layers-[0-9a-f]{8} disclosure="H3 input:/);
    expect(calls[0]).toContain('NEVER restate, reword or summarize what the OPERATOR wrote');
  });
});

describe('H3Builder — debounce (§6.5: at most once per 10 minutes or per fold)', () => {
  it('a second request inside the window schedules one rebuild at its end; a fold bypasses the window', async () => {
    const s = store();
    chunk(s, 1);
    let now = 1_000_000;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const calls: string[] = [];
    const b = builder(s, { calls, timers, now: () => now });
    b.request(T, 'chunk');
    await b.idle();
    expect(calls).toHaveLength(1);
    now += 60_000;
    b.request(T, 'chunk');
    b.request(T, 'c2');
    await b.idle();
    expect(calls).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(9 * 60_000);
    expect(b.status()).toMatchObject({ debounced: 2, scheduled: 1 });
    timers[0].fn();
    await b.idle();
    expect(calls).toHaveLength(2);
    b.request(T, 'fold');
    await b.idle();
    expect(calls).toHaveLength(3);
  });
});

describe('ratchet — saveTopicSummary has exactly one caller in src/', () => {
  it('only TopicSummaryTable calls it (the definition lives in TopicMemory)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs)$/.test(e.name)) {
          const lines = fs.readFileSync(p, 'utf-8').split('\n');
          lines.forEach((l, i) => { if (/saveTopicSummary\s*\(/.test(l) && !/^\s*(\*|\/\/)/.test(l)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`); });
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    const defs = hits.filter((h) => h.startsWith('src/memory/TopicMemory.ts:'));
    const callers = hits.filter((h) => !h.startsWith('src/memory/TopicMemory.ts:') && !h.startsWith('src/memory/TopicSummaryTable.ts:'));
    expect(defs).toHaveLength(1);
    expect(callers).toEqual([]);
    const funnel = fs.readFileSync(path.join(ROOT, 'src/memory/TopicSummaryTable.ts'), 'utf-8');
    expect(funnel.match(/this\.backend\.saveTopicSummary\(/g)).toHaveLength(1);
  });
});

describe('measureH3 — the metrics read (never zero for "not built")', () => {
  it('not built ⇒ not-built-yet; built ⇒ freshness and the C2 read counts', async () => {
    const { measureH3 } = await import('../../src/monitoring/contextBudgetMetrics.js');
    const s = store();
    expect(measureH3(s, T, () => null)).toEqual({ status: 'not-built-yet' });
    for (let i = 1; i <= 2; i++) chunk(s, i, { rangeId: 'r-1-2' });
    range(s, 1, 2);
    chunk(s, 3);
    await builder(s, { inputTokens: 100_000 }).build(T);
    const m = measureH3(s, T, () => ({ total: 4, fromUser: 2 }));
    expect(m).toMatchObject({ status: 'live', messagesBehind: 4, rangesDirect: 1, rangesThroughC2: 0, rangesOmitted: 0, chunksRead: 3 });
    expect((m as { freshness: string }).freshness).toMatch(/, 4 messages behind$/);
  });
});

describe('review fixes — legacy retirement before every write; coverage excludes gaps', () => {
  it('a failed retirement leaves the row; the NEXT build retires before it writes (never overwritten unkept)', async () => {
    const tm = await topicMemory();
    tm.saveTopicSummary(Number(T), 'The old rolling summary.', 10, 100, 'Old purpose');
    const s = store();
    chunk(s, 1);
    let fail = true;
    const b = new H3Builder({
      store: s, budget: new TopicLayerBudget(), machine: 'm', intelligence: { evaluate: async () => GOOD },
      table: new TopicSummaryTable(tm, () => true),
      readSummary: (id) => { if (fail) throw new Error('db busy'); return tm.getTopicSummary(id); },
    });
    await b.build(T);
    expect(tm.getTopicSummary(Number(T))!.summary).toBe('The old rolling summary.');
    expect(s.read(T, 'h3', H3_LEGACY_KEY)).toBeNull();
    fail = false;
    await b.build(T);
    expect(s.read(T, 'h3', H3_LEGACY_KEY)!.data).toMatchObject({ summary: 'The old rolling summary.' });
    expect(tm.getTopicSummary(Number(T))!.summary.startsWith('[Long-term view (H3), as of ')).toBe(true);
  });

  it('an h3 record that arrived before (replication / topic move) still retires the local legacy row first', async () => {
    const tm = await topicMemory();
    tm.saveTopicSummary(Number(T), 'Local legacy summary.', 10, 100, null);
    const s = store();
    s.writeDerived(T, 'h3', H3_KEY, { kind: 'h3', purpose: 'p', summary: 'from another machine' }, meta('live', 50));
    chunk(s, 1);
    await builder(s, { tm }).build(T);
    expect(s.read(T, 'h3', H3_LEGACY_KEY)!.data).toMatchObject({ summary: 'Local legacy summary.' });
  });

  it('H3\'s own row is never retired as legacy', async () => {
    const tm = await topicMemory();
    const s = store();
    chunk(s, 1);
    const b = builder(s, { tm });
    await b.build(T);
    await b.build(T);
    expect(s.read(T, 'h3', H3_LEGACY_KEY)).toBeNull();
    expect(b.status().legacyRetired).toBe(0);
  });

  it('a pending chunk\'s messages are not counted as covered', () => {
    const s = store();
    chunk(s, 1, { ids: [100] });
    chunk(s, 2, { ids: [900], status: 'pending' });
    expect(selectH3Inputs(s, T).lastMessageId).toBe(100);
  });
});
