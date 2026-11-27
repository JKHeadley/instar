// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — chunks on span close, the deterministic span sampler and C2 ranges
 * (context-budget-layered-summaries §6 rows C/C2, §6.5, §9.5, §12 "Sampler
 * ceilings", §8 authorship).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleSpan, spanEntriesFromArchive, archiveEntriesFromTranscriptLine, DEFAULT_SAMPLER_MAX_CHARS, type SpanEntry } from '../../src/monitoring/contextLayers/spanSampler.js';
import { ChunkBuilder, readTranscriptSpan, validateChunkJson, validateC2Json, MAX_ATTEMPTS } from '../../src/monitoring/contextLayers/chunkBuilder.js';
import { listChunks, readChunk } from '../../src/monitoring/contextLayers/chunkLookup.js';
import { LayerStore } from '../../src/monitoring/contextLayers/LayerStore.js';
import { TranscriptArchive } from '../../src/monitoring/contextLayers/TranscriptArchive.js';
import { TopicLayerBudget } from '../../src/monitoring/contextLayers/layerCadence.js';
import { currentPhaseSpans } from '../../src/monitoring/diskSteward/pruneContextArchive.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/unit/context-layer-chunks.test.ts';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clch-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

const ts = (i: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString();
const user = (id: string, i: number, text: string) => JSON.stringify({ type: 'user', uuid: id, timestamp: ts(i), message: { role: 'user', content: text } });
const agent = (id: string, i: number, text: string) => JSON.stringify({ type: 'assistant', uuid: id, timestamp: ts(i), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (id: string, i: number, name: string) => JSON.stringify({ type: 'assistant', uuid: id, timestamp: ts(i), message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { command: 'ls' } }] } });
const toolResult = (id: string, i: number, text: string, isError = false) => JSON.stringify({ type: 'user', uuid: id, timestamp: ts(i), message: { role: 'user', content: [{ type: 'tool_result', content: text, is_error: isError }] } });
const boundary = () => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: `b-${Math.random()}`, content: 'Conversation compacted' });

function entry(id: string, kind: SpanEntry['kind'], text: string, o: Partial<SpanEntry> = {}): SpanEntry {
  return { entryId: id, kind, text, messageIds: [], isError: false, hasFilePath: false, timestamp: null, toolName: null, ...o };
}

const GOOD = JSON.stringify({ attempted: 'Built the span sampler.', outcome: 'Tests pass.', artifacts: ['src/monitoring/contextLayers/spanSampler.ts'], openThreads: ['wire the route'], summary: 'The agent built and tested the sampler.' });

function fakeLlm(replies: Array<string | Error>): IntelligenceProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async evaluate(prompt: string) {
      calls.push(prompt);
      const r = replies.length > 1 ? replies.shift()! : replies[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function rig(o: { replies?: Array<string | Error>; intelligence?: IntelligenceProvider | null; budget?: TopicLayerBudget; c2?: { chunks: number; tokens: number }; maxSpanEntries?: number } = {}) {
  const sd = tmp();
  const store = new LayerStore({ stateDir: sd, liveSecrets: () => [] });
  const archive = new TranscriptArchive({ stateDir: sd, liveSecrets: () => [] });
  const budget = o.budget ?? new TopicLayerBudget();
  const llm = fakeLlm(o.replies ?? [GOOD]);
  let clock = 1_800_000_000_000;
  const builder = new ChunkBuilder({
    store, archive, budget, intelligence: o.intelligence === undefined ? llm : o.intelligence, machine: 'm_test',
    now: () => clock++, c2: o.c2, maxSpanEntries: o.maxSpanEntries,
  });
  const transcript = path.join(sd, 'session.jsonl');
  return { sd, store, archive, budget, llm, builder, transcript };
}

const req = (transcript: string, upTo: 'last-compact-boundary' | 'end' = 'last-compact-boundary') => ({ topicKey: '141133', transcriptPath: transcript, sessionKey: 'cs-1', trigger: 'post-compact' as const, upTo, sessionId: 'inst-1' });

describe('spanSampler', () => {
  const span: SpanEntry[] = [
    entry('a', 'tool-use', 'x'.repeat(50)),
    entry('b', 'user-message', '[telegram:1] please build it', { messageIds: [11] }),
    entry('c', 'agent-prose', 'I will build it.'),
    entry('d', 'tool-result', 'Error: ENOENT', { isError: true }),
    entry('e', 'tool-result', 'wrote src/a.ts', { hasFilePath: true }),
    entry('f', 'tool-result', 'plain output'),
    entry('g', 'agent-prose', 'Done.'),
  ];

  it('keeps everything under the ceiling, in original order, and says so', () => {
    const r = sampleSpan(span);
    expect(r.entries.map((e) => e.entryId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(r).toMatchObject({ sampledFrom: 7, dropped: 0 });
    expect(r.disclosure).toBe('complete: all 7 entries');
  });

  it('selects in the spec order: floor, message ids, agent prose, errors, tail, then file paths', () => {
    const big = (id: string, kind: SpanEntry['kind'], o: Partial<SpanEntry> = {}) => entry(id, kind, id.repeat(100), o);
    const s = [big('p', 'tool-result', { hasFilePath: true }), big('q', 'tool-use'), big('m', 'user-message', { messageIds: [1] }), big('r', 'agent-prose'), big('s', 'tool-result', { isError: true }), big('t', 'tool-use')];
    // Room for exactly three 100-char entries plus the floor.
    const r = sampleSpan(s, { maxChars: 400, floorIds: ['q'], tail: 1 });
    expect(r.entries.map((e) => [e.entryId, e.reason])).toEqual([['q', 'floor'], ['m', 'message-id'], ['r', 'agent-prose'], ['s', 'error']]);
    expect(r.dropped).toBe(2);
    expect(r.disclosure).toMatch(/^sampled from 6 entries: 4 kept, 2 dropped/);
  });

  it('the floor is never dropped, even when it alone exceeds the ceiling', () => {
    const r = sampleSpan([entry('a', 'tool-use', 'z'.repeat(500)), entry('b', 'agent-prose', 'short')], { maxChars: 100, floorIds: ['a'] });
    expect(r.entries.map((e) => e.entryId)).toEqual(['a']);
    expect(r.floorOverBudget).toBe(true);
  });

  it('honours the 30K-token default ceiling on a large span', () => {
    const s = Array.from({ length: 400 }, (_, i) => entry(`e${i}`, i % 2 ? 'agent-prose' : 'tool-result', 'w'.repeat(3_000)));
    const r = sampleSpan(s);
    expect(DEFAULT_SAMPLER_MAX_CHARS).toBe(120_000);
    expect(r.chars).toBeLessThanOrEqual(120_000);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.disclosure).toContain('sampled from 400 entries');
  });

  it('is deterministic: the same span samples identically', () => {
    const s = Array.from({ length: 80 }, (_, i) => entry(`e${i}`, (['agent-prose', 'tool-result', 'tool-use', 'user-message'] as const)[i % 4], `t${i} `.repeat(200), { isError: i % 7 === 0, hasFilePath: i % 5 === 0 }));
    expect(JSON.stringify(sampleSpan(s, { maxChars: 20_000 }))).toBe(JSON.stringify(sampleSpan(s, { maxChars: 20_000 })));
  });

  it('cuts a huge non-floor entry to its edges and discloses it', () => {
    const r = sampleSpan([entry('a', 'tool-result', `HEAD${'m'.repeat(10_000)}TAIL`)], { maxEntryChars: 200 });
    expect(r.entries[0].clipped).toBe(true);
    expect(r.entries[0].sampledText.startsWith('HEAD')).toBe(true);
    expect(r.entries[0].sampledText.endsWith('TAIL')).toBe(true);
    expect(r.disclosure).toContain('1 cut to their edges');
  });

  it('normalizes a Claude Code line and an archive round-trip identically', () => {
    const parsed = archiveEntriesFromTranscriptLine(toolResult('u1', 1, 'Error: failed to open src/x.ts', true))!;
    expect(parsed.entries[0].meta).toMatchObject({ kind: 'tool-result', isError: true, hasFilePath: true });
    const [e] = spanEntriesFromArchive(parsed.entries);
    expect(e).toMatchObject({ entryId: 'u1', kind: 'tool-result', isError: true, hasFilePath: true });
    expect(archiveEntriesFromTranscriptLine(user('u2', 2, '[telegram:5 "T" from J] hi'))!.entries[0].meta?.kind).toBe('user-message');
    expect(archiveEntriesFromTranscriptLine(boundary())!.compactBoundary).toBe(true);
    expect(archiveEntriesFromTranscriptLine(JSON.stringify({ type: 'user', uuid: 'cs', isCompactSummary: true, message: { content: 'summary' } }))).toBeNull();
    expect(archiveEntriesFromTranscriptLine('{torn')).toBeNull();
  });
});

describe('validators', () => {
  it('accepts the strict shape and refuses bad JSON, extra fields and wrong types', () => {
    expect(validateChunkJson(GOOD, '').ok).toBe(true);
    expect(validateChunkJson('```json\n' + GOOD + '\n```', '').ok).toBe(true);
    expect(validateChunkJson('not json at all', '')).toMatchObject({ ok: false });
    expect(validateChunkJson(JSON.stringify({ ...JSON.parse(GOOD), extra: 1 }), '')).toMatchObject({ ok: false, reason: expect.stringContaining('unexpected fields') });
    expect(validateChunkJson(JSON.stringify({ ...JSON.parse(GOOD), artifacts: 'one' }), '')).toMatchObject({ ok: false });
    expect(validateChunkJson(JSON.stringify({ ...JSON.parse(GOOD), summary: '' }), '')).toMatchObject({ ok: false });
    expect(validateC2Json(JSON.stringify({ summary: 's', artifacts: [] }), '').ok).toBe(true);
    expect(validateC2Json(JSON.stringify({ summary: 's' }), '').ok).toBe(false);
  });

  it('refuses a quotation that is not byte-identical to the span (never a reworded user sentence)', () => {
    const source = '[telegram:1] please make the gate warn, not block';
    const faithful = JSON.stringify({ ...JSON.parse(GOOD), summary: 'Operator asked "please make the gate warn, not block".' });
    const reworded = JSON.stringify({ ...JSON.parse(GOOD), summary: 'Operator asked "make the gate warn rather than block".' });
    expect(validateChunkJson(faithful, source).ok).toBe(true);
    expect(validateChunkJson(reworded, source)).toMatchObject({ ok: false, reason: expect.stringContaining('quotation') });
  });

  it('pairs quotation marks: the prose between two short quotations is not a quotation', () => {
    const out = JSON.stringify({ ...JSON.parse(GOOD), summary: 'It printed "ok" and then went on to run "npm test" twice.' });
    expect(validateChunkJson(out, 'unrelated span text').ok).toBe(true);
  });
});

describe('readTranscriptSpan and the watermark', () => {
  it('reads from the start up to the last compaction boundary', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [user('u1', 1, 'a'), agent('u2', 2, 'b'), boundary(), agent('u3', 3, 'after')].join('\n'));
    const s = (await readTranscriptSpan(r.transcript, { afterLineUuid: null, upTo: 'last-compact-boundary', maxEntries: 100 }))!;
    expect(s.entries.map((e) => e.entryId)).toEqual(['u1', 'u2']);
    expect(s.lastLineUuid).toBe('u2');
  });

  it('never skips an entry: a capped build continues at once, and successive compactions chunk contiguous spans', async () => {
    const r = rig({ maxSpanEntries: 2 });
    const lines = [user('u1', 1, 'one'), agent('u2', 2, 'two'), agent('u3', 3, 'three'), boundary()];
    fs.writeFileSync(r.transcript, lines.join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    // Capped at u2, continued in the same build up to the boundary.
    expect(r.builder.readWatermark('141133', 'cs-1')?.lastLineUuid).toBe('u3');
    expect(r.builder.chunks('141133').find((c) => c.data.seq === 1)?.data.continues).toBe(true);
    // More work, a second compaction.
    fs.appendFileSync(r.transcript, [agent('u4', 4, 'four'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const covered = r.builder.chunks('141133').filter((c) => c.data.kind === 'span').flatMap((c) => (r.archive.readSpan('141133', String(c.entryKey)) ?? []).map((e) => e.entryId));
    expect(covered).toEqual(['u1', 'u2', 'u3', 'u4']);
    // Nothing new: no further chunk.
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.builder.chunks('141133').filter((c) => c.data.kind === 'span')).toHaveLength(3);
  });

  it('no boundary after the watermark (the hook fired before the flush) reads to the end, never one compaction late', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'one'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    fs.appendFileSync(r.transcript, agent('u2', 2, 'two') + '\n');
    const s = (await readTranscriptSpan(r.transcript, { afterLineUuid: 'u1', upTo: 'last-compact-boundary', maxEntries: 100 }))!;
    expect(s.entries.map((e) => e.entryId)).toEqual(['u2']);
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.builder.chunks('141133').filter((c) => c.data.kind === 'span')).toHaveLength(2);
  });

  it('keeps one watermark per transcript: alternating sessions never reset each other', async () => {
    const r = rig();
    const t2 = path.join(r.sd, 's2.jsonl');
    fs.writeFileSync(r.transcript, [agent('a1', 1, 'A one'), boundary()].join('\n') + '\n');
    fs.writeFileSync(t2, [agent('b1', 2, 'B one'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    r.builder.enqueue({ ...req(t2), sessionKey: 'cs-2' });
    await r.builder.idle();
    expect(r.builder.readWatermark('141133', 'cs-1')?.lastLineUuid).toBe('a1');
    expect(r.builder.readWatermark('141133', 'cs-2')?.lastLineUuid).toBe('b1');
  });

  it('adopts an orphan span mixed in with new work at the next compaction (the common case)', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    const orig = r.store.writeDerived.bind(r.store);
    let failOnce = true;
    (r.store as unknown as { writeDerived: typeof orig }).writeDerived = (t, type, key, data, meta) => {
      if (failOnce && type === 'chunk' && meta.status === 'pending') { failOnce = false; return { written: false, reason: 'write-failed' }; }
      return orig(t, type, key, data, meta);
    };
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    fs.appendFileSync(r.transcript, [agent('u2', 2, 'more work'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const spans = r.builder.chunks('141133').filter((c) => c.data.kind === 'span');
    expect(spans).toHaveLength(2);
    expect(spans.map((c) => r.archive.readSpan('141133', String(c.entryKey))!.map((e) => e.entryId))).toEqual([['u1'], ['u2']]);
    expect(spans.every((c) => c.status === 'closed')).toBe(true);
    expect(spans.map((c) => c.data.seq)).toEqual([1, 2]);
    expect(r.llm.calls).toHaveLength(2); // one model call per span, never a second for the span just archived
  });

  it('adopts an archived span whose pending chunk was never written, before moving the watermark past it', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    const orig = r.store.writeDerived.bind(r.store);
    let failOnce = true;
    (r.store as unknown as { writeDerived: typeof orig }).writeDerived = (t, type, key, data, meta) => {
      if (failOnce && type === 'chunk' && meta.status === 'pending') { failOnce = false; return { written: false, reason: 'write-failed' }; }
      return orig(t, type, key, data, meta);
    };
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.builder.chunks('141133').filter((c) => c.data.kind === 'span')).toHaveLength(0);
    expect(r.builder.readWatermark('141133', 'cs-1')).toBeNull();
    expect(r.archive.readIndex('141133').spans).toHaveLength(1);
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const spans = r.builder.chunks('141133').filter((c) => c.data.kind === 'span');
    expect(spans).toHaveLength(1);
    expect(spans[0].spanIds).toEqual([r.archive.readIndex('141133').spans[0].spanId]);
    expect(spans[0].status).toBe('closed');
    expect(r.builder.readWatermark('141133', 'cs-1')?.lastLineUuid).toBe('u1');
  });

  it('a new engine session (watermark absent from its transcript) re-reads from the start, deduplicated by the archive', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [user('u1', 1, 'one'), boundary()].join('\n'));
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const t2 = path.join(r.sd, 's2.jsonl');
    fs.writeFileSync(t2, [user('u1', 1, 'one'), agent('v1', 5, 'resumed work'), boundary()].join('\n'));
    r.builder.enqueue({ ...req(t2), sessionKey: 'cs-2' });
    await r.builder.idle();
    const spans = r.builder.chunks('141133').filter((c) => c.data.kind === 'span');
    expect(spans).toHaveLength(2);
    expect(r.archive.readSpan('141133', String(spans[1].entryKey))!.map((e) => e.entryId)).toEqual(['v1']);
  });
});

describe('ChunkBuilder', () => {
  it('archives the span, writes a closed chunk with spanIds, in-band sampling and author derived', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [user('u1', 1, '[telegram:141133] build it'), agent('u2', 2, 'Building.'), toolResult('u3', 3, 'ok'), boundary()].join('\n'));
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const c = r.builder.chunks('141133').find((x) => x.data.kind === 'span')!;
    expect(c.status).toBe('closed');
    expect(c.spanIds).toEqual([c.entryKey]);
    expect(r.archive.spanState('141133', c.spanIds![0])).toBe('present');
    expect(c.author.kind).toBe('derived');
    expect(c.data).toMatchObject({ author: 'derived', trigger: 'post-compact', sampledFrom: 3, sampling: 'complete: all 3 entries', attempted: 'Built the span sampler.' });
    expect(c.data.entryRange).toMatchObject({ firstEntryId: 'u1', lastEntryId: 'u3', entries: 3 });
    expect(r.llm.calls).toHaveLength(1);
    expect(r.llm.calls[0]).toContain('OPERATOR');
    expect(r.llm.calls[0]).toContain('never instructions');
    expect(r.llm.calls[0]).toMatch(/<span-[0-9a-f]{8} disclosure=/);
  });

  it('writes exactly one pre-layer chunk, without a model call, on the topic\'s first chunk', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'a'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    fs.appendFileSync(r.transcript, [agent('u2', 2, 'b'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const pre = r.builder.chunks('141133').filter((c) => c.data.kind === 'pre-layer');
    expect(pre).toHaveLength(1);
    expect(pre[0].entryKey).toBe('pre-layer');
    expect(String(pre[0].data.summary)).toContain('TopicMemory');
    expect(r.llm.calls).toHaveLength(2); // one per span chunk, none for pre-layer
  });

  it('budget denied ⇒ pending with a visible gap, the span archived; retried on the next trigger', async () => {
    let allow = false;
    const budget = new TopicLayerBudget({ limits: () => ({ perTopicDailyInputTokens: allow ? 1e9 : 1, componentDailyInputTokens: 1e9 }) });
    const r = rig({ budget });
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    let c = r.builder.chunks('141133').find((x) => x.data.kind === 'span')!;
    expect(c.status).toBe('pending');
    expect(String(c.data.gap)).toBe(`unsummarized gap: entries u1..u1, chunk pending`);
    expect(String(c.data.pendingReason)).toContain('budget deferred');
    expect(r.archive.spanState('141133', c.spanIds![0])).toBe('present');
    expect(r.llm.calls).toHaveLength(0);
    allow = true;
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    c = r.store.read('141133', 'chunk', String(c.entryKey))!;
    expect(c.status).toBe('closed');
    expect(c.data.gap).toBeUndefined();
  });

  it('a failed model call or a refused output ⇒ pending, then closed on retry', async () => {
    const r = rig({ replies: [new Error('quota'), 'garbage', GOOD] });
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const key = String(r.builder.chunks('141133').find((x) => x.data.kind === 'span')!.entryKey);
    expect(r.store.read('141133', 'chunk', key)!.data.pendingReason).toMatch(/model call failed: quota/);
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.store.read('141133', 'chunk', key)!.data.pendingReason).toMatch(/output refused/);
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.store.read('141133', 'chunk', key)!).toMatchObject({ status: 'closed', data: { attempts: 3 } });
  });

  it('no model on the machine ⇒ pending, never a silent skip, and deferrals never use up attempts', async () => {
    const r = rig({ intelligence: null });
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { r.builder.enqueue(req(r.transcript)); await r.builder.idle(); }
    const c = r.builder.chunks('141133').find((x) => x.data.kind === 'span')!;
    expect(c.status).toBe('pending');
    expect(c.data.attempts).toBe(0);
    expect(String(c.data.pendingReason)).toContain('no model');
  });

  it('refused outputs stop at the attempt ceiling, and a retry after a refusal asks for no quotations', async () => {
    const r = rig({ replies: ['garbage'] });
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { r.builder.enqueue(req(r.transcript)); await r.builder.idle(); }
    const c = r.builder.chunks('141133').find((x) => x.data.kind === 'span')!;
    expect(c.status).toBe('pending');
    expect(c.data.attempts).toBe(MAX_ATTEMPTS);
    expect(r.llm.calls).toHaveLength(MAX_ATTEMPTS);
    expect(r.llm.calls[0]).not.toContain('was refused');
    expect(r.llm.calls[1]).toContain('Use NO quotations');
  });

  it('a ledger-named message is on the sampler floor', async () => {
    const r = rig();
    r.store.writeProtected('141133', 'ledger-entry', 'd1', [{ messageId: 77, sha256: 'a'.repeat(64), length: 5 }], { author: { sessionId: null, machine: 'm', model: null, kind: 'user' }, asOf: { at: 1, lastMessageId: 77 } });
    const b = new ChunkBuilder({
      store: r.store, archive: r.archive, budget: r.budget, intelligence: r.llm, machine: 'm',
      sampler: { maxChars: 50 },
      messagesBetween: () => [{ messageId: 77, text: 'decide: the gate warns, never blocks', fromUser: true, timestamp: ts(1) }],
    });
    fs.writeFileSync(r.transcript, [toolResult('t1', 0, 'x'.repeat(60)), user('u1', 1, '[telegram:141133 "T" from J (uid:1)] decide: the gate warns, never blocks'), agent('u2', 2, 'y'.repeat(60)), boundary()].join('\n') + '\n');
    b.enqueue(req(r.transcript));
    await b.idle();
    expect(r.llm.calls[0]).toContain('OPERATOR msg:77');
    expect(r.llm.calls[0]).toContain('decide: the gate warns, never blocks');
  });

  it('binds a message id only to the operator turn whose words match, never "ok" to an unrelated turn', async () => {
    const r = rig();
    const b = new ChunkBuilder({
      store: r.store, archive: r.archive, budget: r.budget, intelligence: r.llm, machine: 'm',
      messagesBetween: () => [
        { messageId: 5, text: 'ok', fromUser: true, timestamp: ts(1) },
        { messageId: 6, text: 'please look at the broken build', fromUser: true, timestamp: ts(2) },
      ],
    });
    fs.writeFileSync(r.transcript, [user('u1', 1, '[telegram:141133 "T" from J (uid:1)] please look at the broken build'), user('u2', 2, '[telegram:141133 "T" from J (uid:1)] ok'), boundary()].join('\n') + '\n');
    b.enqueue(req(r.transcript));
    await b.idle();
    const span = b.chunks('141133').find((c) => c.data.kind === 'span')!;
    const entries = r.archive.readSpan('141133', String(span.entryKey))!;
    expect(entries.find((e) => e.entryId === 'u1')!.messageIds).toEqual([6]);
    expect(entries.find((e) => e.entryId === 'u2')!.messageIds).toEqual([5]);
  });

  it('a pending chunk\'s span is on the Disk Steward floor; a closed one is not; open/current-phase are', async () => {
    const r = rig({ intelligence: null });
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'work'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const pending = r.builder.chunks('141133').find((x) => x.data.kind === 'span')!;
    expect(currentPhaseSpans(r.store, '141133')!.has(pending.spanIds![0])).toBe(true);
    const meta = (status: string, spanIds: string[]) => ({ author: { sessionId: null, machine: 'm', model: null, kind: 'derived' as const }, asOf: { at: 1, lastMessageId: null }, status, spanIds });
    r.store.writeDerived('141133', 'chunk', 'k-open', { seq: 90 }, meta('open', ['span-open']));
    r.store.writeDerived('141133', 'chunk', 'k-phase', { seq: 91 }, meta('current-phase', ['span-phase']));
    r.store.writeDerived('141133', 'chunk', 'k-closed', { seq: 92 }, meta('closed', ['span-closed']));
    const floor = currentPhaseSpans(r.store, '141133')!;
    expect(floor.has('span-open')).toBe(true);
    expect(floor.has('span-phase')).toBe(true);
    expect(floor.has('span-closed')).toBe(false);
  });

  it('C2 closes at the chunk threshold and stamps each member with its rangeId', async () => {
    const r = rig({ c2: { chunks: 3, tokens: 1e9 }, replies: [GOOD, GOOD, GOOD, JSON.stringify({ summary: 'Range: sampler built.', artifacts: ['spanSampler.ts'] }), GOOD] });
    fs.writeFileSync(r.transcript, '');
    for (let i = 1; i <= 3; i++) {
      fs.appendFileSync(r.transcript, [agent(`u${i}`, i, `step ${i}`), boundary()].join('\n') + '\n');
      r.builder.enqueue(req(r.transcript));
      await r.builder.idle();
      if (i < 3) expect(r.store.list('141133', 'c2')).toHaveLength(0);
    }
    const ranges = r.store.list('141133', 'c2');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].data).toMatchObject({ rangeId: 'r-1-3', seqRange: [1, 3], summary: 'Range: sampler built.' });
    expect(ranges[0].spanIds).toHaveLength(3);
    const spans = r.builder.chunks('141133').filter((c) => c.data.kind === 'span');
    expect(spans.every((c) => c.data.rangeId === 'r-1-3')).toBe(true);
    expect(spans.every((c) => c.status === 'closed' && (c.spanIds ?? []).length === 1)).toBe(true);
    // A fourth chunk starts a new, unranged run.
    fs.appendFileSync(r.transcript, [agent('u4', 4, 'step 4'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.store.list('141133', 'c2')).toHaveLength(1);
  });

  it('a range never claims a pending chunk it skipped, and a failed member stamp is repaired, not counted twice', async () => {
    const r = rig({ c2: { chunks: 2, tokens: 1e9 }, replies: [JSON.stringify({ summary: 'range', artifacts: [] })] });
    const meta = (status: string, spanIds: string[]) => ({ author: { sessionId: null, machine: 'm', model: null, kind: 'derived' as const }, asOf: { at: 1, lastMessageId: null }, status, spanIds });
    const chunk = (seq: number, status: string) => r.store.writeDerived('141133', 'chunk', `k${seq}`, { kind: 'span', seq, attempted: 'a', outcome: 'o', summary: `s${seq}`, artifacts: [], openThreads: [] }, meta(status, [`sp${seq}`]));
    chunk(1, 'closed'); chunk(2, 'pending'); chunk(3, 'closed');
    expect(await r.builder.maybeCloseRange('141133')).toBe(false);
    chunk(2, 'closed');
    expect(await r.builder.maybeCloseRange('141133')).toBe(true);
    expect(r.store.list('141133', 'c2')[0].data).toMatchObject({ rangeId: 'r-1-3', chunkKeys: ['k1', 'k2', 'k3'] });
    // A range whose member stamp was lost: repaired on the next check.
    r.store.writeDerived('141133', 'c2', 'r-4-5', { rangeId: 'r-4-5', chunkKeys: ['k4', 'k5'], seqRange: [4, 5], summary: 'x', artifacts: [] }, meta('closed', []));
    chunk(4, 'closed'); chunk(5, 'closed');
    expect(await r.builder.maybeCloseRange('141133')).toBe(false);
    expect(r.store.read('141133', 'chunk', 'k4')!.data.rangeId).toBe('r-4-5');
    expect(r.store.list('141133', 'c2')).toHaveLength(2);
  });

  it('C2 also closes on the token threshold', async () => {
    const r = rig({ c2: { chunks: 100, tokens: 10 }, replies: [GOOD, JSON.stringify({ summary: 'r', artifacts: [] })] });
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'w'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    expect(r.store.list('141133', 'c2')).toHaveLength(1);
  });

  it('lookup lists C and C2 newest first with sizes and span states, paginated', async () => {
    const r = rig();
    fs.writeFileSync(r.transcript, [agent('u1', 1, 'w'), boundary()].join('\n') + '\n');
    r.builder.enqueue(req(r.transcript));
    await r.builder.idle();
    const page = listChunks(r.store, r.archive, '141133', { limit: 1 });
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBe(1);
    expect(page.items[0]).toMatchObject({ recordType: 'chunk', kind: 'span', status: 'closed', seq: 1 });
    expect(page.items[0].bytes).toBeGreaterThan(0);
    expect(page.items[0].spans[0].state).toBe('present');
    r.archive.evictSpan('141133', page.items[0].spans[0].spanId);
    expect(listChunks(r.store, r.archive, '141133').items[0].spans[0].state).toBe('raw-evicted');
    expect(listChunks(r.store, r.archive, '141133', { offset: 1 }).items[0].kind).toBe('pre-layer');
    expect(readChunk(r.store, r.archive, '141133', page.items[0].key)?.record.data.summary).toBe('The agent built and tested the sampler.');
    expect(readChunk(r.store, r.archive, '141133', 'nope')).toBeNull();
    expect(listChunks(r.store, r.archive, '141133', { limit: 10_000 }).limit).toBe(200);
  });
});
