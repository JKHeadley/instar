// safe-fs-allow: test file — temp dirs via mkdtemp, removed through SafeFsExecutor.
// safe-git-allow: test file — no git calls.
/**
 * Unit — context budget measurement (context-budget-layered-summaries §11,
 * Phase 1 S13): the Phase 0 cost weighting, rework counting from the ledger's
 * tool inputs, dedupe of a session copied into two config homes, `pending`
 * while the poller lags, Anchors counted per state (never-evaluated is not no-anchor), the
 * ledger scanning a follow-me home, the transcript-root resolver, and the
 * per-trigger LayerUpdate rollup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenLedger, reworkKey } from '../../src/monitoring/TokenLedger.js';
import { claudeTranscriptRoots } from '../../src/monitoring/claudeTranscriptRoots.js';
import { costWeigh, reworkWithFreshness, computeContextBudgetMetrics, parseMetricsQuery, COST_WEIGHTS, POLLER_LAG_TOLERANCE_MS } from '../../src/monitoring/contextBudgetMetrics.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { LayerSpendLog } from '../../src/monitoring/contextLayers/layerSpendLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import Database from 'better-sqlite3';

const OP = 'tests/unit/context-budget-metrics.test.ts';
const SID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-11-10T10:00:00.000Z');

const iso = (ms: number) => new Date(ms).toISOString();
function req(n: number, o: { sid?: string; tools?: Array<{ id: string; name: string; input: Record<string, unknown> }>; read?: number; w1h?: number; w5m?: number; input?: number; output?: number; noSplit?: boolean } = {}) {
  const w1h = o.w1h ?? 1000; const w5m = o.w5m ?? 0;
  return JSON.stringify({
    type: 'assistant', sessionId: o.sid ?? SID, cwd: '/agent', timestamp: iso(T0 + n * 1000), uuid: `a-${n}`, requestId: `req-${o.sid ?? SID}-${n}`,
    message: {
      id: `m-${n}`, model: 'claude-opus-5-5',
      content: (o.tools ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
      usage: {
        input_tokens: o.input ?? 4, output_tokens: o.output ?? 100, cache_read_input_tokens: o.read ?? 50_000, cache_creation_input_tokens: w1h + w5m,
        ...(o.noSplit ? {} : { cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m } }),
      },
    },
  });
}
function userPrompt(n: number, text: string, sid = SID) {
  return JSON.stringify({ type: 'user', sessionId: sid, timestamp: iso(T0 + n * 1000), uuid: `u-${n}`, message: { role: 'user', content: text } });
}
function boundary(n: number, sid = SID) {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: sid, timestamp: iso(T0 + n * 1000), uuid: `cb-${n}` });
}

describe('context budget metrics — unit', () => {
  const dirs: string[] = [];
  const ledgers: TokenLedger[] = [];
  const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  afterEach(() => {
    for (const l of ledgers.splice(0)) l.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });
  const mkLedger = (o: Partial<ConstructorParameters<typeof TokenLedger>[0]> = {}) => { const l = new TokenLedger({ dbPath: ':memory:', attributionBackfill: 'off', ...o }); ledgers.push(l); return l; };

  it('cost weighting uses the Phase 0 weights (read 0.1, 1 h write 2.0, 5 min write 1.25, uncached 1, output 5)', () => {
    const c = costWeigh([{ requests: 2, uncached: 10, cacheRead: 100_000, cacheWrite: 3_000, cacheWrite1hKnown: 2_000, cacheWriteSplitUnknown: 0, output: 200 }]);
    // 10 + 0.1×100000 + 2×2000 + 1.25×1000 = 15260; + 5×200 = 16260
    expect(c.inputWeighted).toBe(15_260);
    expect(c.allInWeighted).toBe(16_260);
    expect(c.perRequest.inputWeighted).toBe(7_630);
    expect(c.cacheWrite5m).toBe(1_000);
    // A write with no recorded split is priced as 1 h (the Phase 0 observation) and disclosed.
    const u = costWeigh([{ requests: 1, uncached: 0, cacheRead: 0, cacheWrite: 500, cacheWrite1hKnown: 0, cacheWriteSplitUnknown: 500, output: 0 }]);
    expect(u.inputWeighted).toBe(1_000);
    expect(u.cacheWriteSplitUnknown).toBe(500);
    expect(costWeigh([]).perRequest.inputWeighted).toBeNull();
    expect(COST_WEIGHTS).toEqual({ uncached: 1, cacheRead: 0.1, cacheWrite1h: 2, cacheWrite5m: 1.25, output: 5 });
  });

  it('records the 1 h write split and leaves it null on a line without it', () => {
    const l = mkLedger();
    l.ingestLine(req(1, { w1h: 700, w5m: 300 }));
    l.ingestLine(req(2, { w1h: 400, noSplit: true }));
    const [t] = l.sessionRequestTotals({ sinceMs: 0 });
    expect(t.requests).toBe(2);
    expect(t.cacheWrite1hKnown).toBe(700);
    expect(t.cacheWriteSplitUnknown).toBe(400);
    expect(t.writeSplitUnknownRequests).toBe(1);
  });

  it('rework: a re-read and a re-run within 30 turns count; a different command, a far repeat and a same-request repeat do not', () => {
    const l = mkLedger();
    l.ingestLine(req(1, { tools: [{ id: 't1', name: 'Read', input: { file_path: '/repo/src/a.ts' } }, { id: 't2', name: 'Bash', input: { command: 'npm  test' } }] }));
    // Same request, same Read again (parallel call): not rework.
    l.ingestLine(req(1, { tools: [{ id: 't1b', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] }));
    l.ingestLine(req(2, { tools: [{ id: 't3', name: 'Read', input: { file_path: '/repo/src/./a.ts', offset: 40 } }] })); // re-read (normalized path, other range)
    l.ingestLine(req(3, { tools: [{ id: 't4', name: 'Bash', input: { command: '  npm test ' } }] })); // re-run (whitespace normalized)
    l.ingestLine(req(4, { tools: [{ id: 't5', name: 'Bash', input: { command: 'npm run lint' } }] })); // different command
    l.ingestLine(req(5, { tools: [{ id: 't6', name: 'Grep', input: { pattern: 'x' } }] })); // not a counted tool
    // Requests with no tool call are still turns.
    for (let n = 6; n < 40; n++) l.ingestLine(req(n));
    l.ingestLine(req(40, { tools: [{ id: 't7', name: 'Bash', input: { command: 'npm run lint' } }] })); // 36 turns after t5: not rework
    // Copying the same entries again (a second config home) changes nothing.
    l.ingestLine(req(3, { tools: [{ id: 't4', name: 'Bash', input: { command: '  npm test ' } }] }));
    const r = l.reworkForSession(SID, { sinceMs: 0, windowTurns: 30 });
    expect(r.repeats).toBe(2);
    expect(r.byTool.Read.repeats).toBe(1);
    expect(r.byTool.Bash.repeats).toBe(1);
    expect(r.toolInputs).toBe(2 + 1 + 1 + 1 + 1 + 1);
    expect(reworkKey('Grep', { pattern: 'x' })).toBeNull();
    expect(reworkKey('Bash', { command: 'a   b' })).toEqual(reworkKey('Bash', { command: 'a b' }));
    expect(reworkKey('Read', { file_path: '/x/y.ts' })?.hash).not.toContain('/x/');
  });

  it('pending while the poller lags on a copy (judged per file); ok once read recently; partial when history predates the side records', () => {
    const rw = { toolInputs: 10, repeats: 1, byTool: { Read: { inputs: 5, repeats: 1 }, Bash: { inputs: 5, repeats: 0 } }, windowTurns: 30 };
    const lag = (o: Partial<{ laggingFiles: number; unreadBytes: number; partialSideRecords: boolean }>) => ({ files: 1, unreadBytes: 0, laggingFiles: 0, oldestReadAt: null, partialSideRecords: false, ...o });
    expect(reworkWithFreshness(rw, lag({ unreadBytes: 500, laggingFiles: 1 })).status).toBe('pending');
    expect(reworkWithFreshness(rw, lag({ unreadBytes: 500 })).status).toBe('ok');
    expect(reworkWithFreshness(rw, lag({ partialSideRecords: true })).status).toBe('partial-before-upgrade');
    expect(reworkWithFreshness(rw, lag({}))).toMatchObject({ status: 'ok', rate: 0.1 });
    // Per-file lag in the ledger: a copy read just now is not lagging; a stale one is.
    const home = tmp('cbm-lag-');
    const f = path.join(home, `${SID}.jsonl`);
    fs.writeFileSync(f, req(1) + '\n');
    const l = mkLedger();
    l.ingestFile(f);
    fs.appendFileSync(f, req(2) + '\n');
    expect(l.sessionScanLag(SID, { now: Date.now(), toleranceMs: POLLER_LAG_TOLERANCE_MS })).toMatchObject({ laggingFiles: 0 });
    expect(l.sessionScanLag(SID, { now: Date.now() + POLLER_LAG_TOLERANCE_MS + 1000, toleranceMs: POLLER_LAG_TOLERANCE_MS }).laggingFiles).toBe(1);
  });

  it('a file part-read before the side records existed reads partial-before-upgrade', () => {
    const home = tmp('cbm-part-');
    const db = path.join(home, 'l.db');
    const f = path.join(home, `${SID}.jsonl`);
    const firstLine = req(1) + '\n';
    fs.writeFileSync(f, firstLine + req(2) + '\n');
    // The pre-upgrade state: a ledger DB that already read the first line (an
    // offset row) but has no side-record map for the file.
    const raw = new Database(db);
    raw.exec('CREATE TABLE file_offsets (file_path TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0, inode INTEGER, size INTEGER, head_hash TEXT, last_read INTEGER NOT NULL)');
    raw.prepare('INSERT INTO file_offsets (file_path, offset, inode, size, head_hash, last_read) VALUES (?, ?, ?, ?, NULL, ?)').run(f, Buffer.byteLength(firstLine), fs.statSync(f).ino, Buffer.byteLength(firstLine), Date.now());
    raw.close();
    const b = mkLedger({ dbPath: db });
    b.ingestFile(f);
    expect(b.sessionScanLag(SID).partialSideRecords).toBe(true);
    expect(b.sessionRequestTotals({ sinceMs: 0 })[0].requests).toBe(1);
  });

  it('retention never prunes the side-record map of a live file read before its first request (no false partial)', () => {
    const home = tmp('cbm-prune-');
    const f = path.join(home, `${SID}.jsonl`);
    fs.writeFileSync(f, userPrompt(0, '[telegram:4242 "t"] start') + '\n');
    const l = mkLedger();
    l.ingestFile(f); // no request yet: the session has no token events
    l.pruneOlderThan(Date.now() - 86_400_000);
    fs.appendFileSync(f, req(1) + '\n');
    l.ingestFile(f);
    expect(l.sessionScanLag(SID).partialSideRecords).toBe(false);
  });

  it('a large transcript is read in byte-capped pieces that resume to the same totals', () => {
    const home = tmp('cbm-cap-');
    fs.mkdirSync(path.join(home, 'p'));
    const f = path.join(home, 'p', `${SID}.jsonl`);
    fs.writeFileSync(f, Array.from({ length: 40 }, (_, i) => req(i)).join('\n') + '\n');
    const l = mkLedger({ maxBytesPerFileRead: 2_000 });
    expect(l.ingestFile(f).complete).toBe(false);
    let guard = 0;
    while (l.ingestFile(f).complete === false && guard++ < 100) { /* resume from the stored offset */ }
    expect(l.sessionRequestTotals({ sinceMs: 0 })[0].requests).toBe(40);
    // A scan with a tiny byte budget keeps its cursor on the cut file and finishes over later scans.
    const s3 = mkLedger({ claudeProjectsDir: home, maxBytesPerFileRead: 2_000, maxBytesPerScan: 3_000 });
    const first = s3.scanAll();
    expect(first.filesScanned).toBeLessThanOrEqual(2);
    for (let i = 0; i < 100; i++) s3.scanAll();
    expect(s3.sessionRequestTotals({ sinceMs: 0 })[0].requests).toBe(40);
  });

  it('a compaction written as a boundary line and a summary line counts once', () => {
    const l = mkLedger();
    l.ingestLine(userPrompt(0, '[telegram:4242 "t"] one'));
    l.ingestLine(boundary(10));
    l.ingestLine(JSON.stringify({ type: 'user', isCompactSummary: true, sessionId: SID, timestamp: iso(T0 + 11_000), uuid: 'cs-11', message: { role: 'user', content: 'summary' } }));
    l.ingestLine(userPrompt(20, '[telegram:4242 "t"] two'));
    expect(l.promptsInContext(SID)).toMatchObject({ compactions: 1, prompts: 2, inContext: 1 });
  });

  it('the ledger scans a follow-me home, dedupes a session copied into two homes, and reports unread bytes for a lagging file', () => {
    const home = tmp('cbm-home-');
    const proj = '-agent';
    const homeA = path.join(home, '.claude', 'projects', proj);
    const homeB = path.join(home, '.claude-followme-acct', 'projects', proj);
    fs.mkdirSync(homeA, { recursive: true }); fs.mkdirSync(homeB, { recursive: true });
    const lines = [userPrompt(0, '[telegram:4242 "topic-4242"] please check the build'), req(1), req(2), boundary(3), userPrompt(4, '[telegram:4242 "topic-4242"] and then the docs'), req(5)];
    // A follow-me login switch copies the transcript prefix into the other home.
    fs.writeFileSync(path.join(homeA, `${SID}.jsonl`), lines.slice(0, 3).join('\n') + '\n');
    fs.writeFileSync(path.join(homeB, `${SID}.jsonl`), lines.join('\n') + '\n');
    const roots = claudeTranscriptRoots({ home, defaultHome: path.join(home, '.claude') });
    expect(roots.sort()).toEqual([path.join(home, '.claude', 'projects'), path.join(home, '.claude-followme-acct', 'projects')].sort());
    const l = mkLedger({ claudeProjectsDirs: () => roots });
    expect(l.projectRoots().length).toBe(2);
    l.scanAll();
    const [t] = l.sessionRequestTotals({ sinceMs: 0 });
    expect(t.requests).toBe(3); // req 1, 2 counted once although both homes hold them
    expect(l.sessionTopics({ sinceMs: 0 })).toEqual([expect.objectContaining({ sessionId: SID, topicId: 4242, prompts: 2 })]);
    expect(l.promptsInContext(SID)).toMatchObject({ prompts: 2, inContext: 1, compactions: 1 });
    expect(l.sessionScanLag(SID)).toMatchObject({ files: 2, unreadBytes: 0 });
    fs.appendFileSync(path.join(homeB, `${SID}.jsonl`), req(6) + '\n');
    expect(l.sessionScanLag(SID).unreadBytes).toBeGreaterThan(0);
    // Without the follow-me root (the old behaviour), the copy-only requests are missed.
    const old = mkLedger({ claudeProjectsDir: path.join(home, '.claude', 'projects') });
    old.scanAll();
    expect(old.sessionRequestTotals({ sinceMs: 0 })[0].requests).toBe(2);
  });

  it('transcript roots include a pool login outside home and skip a missing one', () => {
    const home = tmp('cbm-roots-');
    const outside = tmp('cbm-pool-');
    fs.mkdirSync(path.join(outside, 'projects'));
    const roots = claudeTranscriptRoots({ home, defaultHome: path.join(home, '.claude'), pool: { list: () => [{ framework: 'claude-code', configHome: outside }, { framework: 'codex-cli', configHome: home }, { framework: 'claude-code', configHome: path.join(home, 'nope') }] } });
    expect(roots).toEqual([path.join(outside, 'projects')]);
  });

  it('layer spend rollup counts attempts and provider tokens per day by trigger, and survives a reload', () => {
    const sd = tmp('cbm-spend-');
    const file = path.join(sd, 'spend.json');
    let now = T0;
    const log = new LayerSpendLog({ file, now: () => now });
    log.recordUsage('turn', { inputTokens: 1200, outputTokens: 80, cachedTokens: 100 });
    log.recordAttempt('turn', { called: true, updated: true, deferred: false, error: false });
    log.recordAttempt('tick', { called: false, updated: false, deferred: true, error: false });
    now += 86_400_000;
    log.recordAttempt('tick', { called: true, updated: false, deferred: false, error: false });
    const days = new LayerSpendLog({ file, now: () => now }).byDay(7);
    expect(days.map((d) => d.day)).toEqual(['2026-11-10', '2026-11-11']);
    expect(days[0].turn).toMatchObject({ attempts: 1, calls: 1, updated: 1, measuredCalls: 1, tokensIn: 1200, tokensOut: 80, tokensCached: 100 });
    expect(days[0].tick).toMatchObject({ attempts: 1, calls: 0, deferred: 1 });
    expect(days[1].tick).toMatchObject({ attempts: 1, calls: 1 });
  });

  it('metrics: Anchors are counted (zero topics reads as zero topics, the builder as not wired), a bad query is refused, and no ledger is reported as unavailable', () => {
    const sd = tmp('cbm-m-');
    const layers = buildContextLayers({ stateDir: sd });
    const m = computeContextBudgetMetrics({ layers, stateDir: sd, ledger: null });
    expect(m.anchors).toMatchObject({ source: 'layer store on this machine', topics: 0, anchored: 0, 'no-anchor': 0, 'not-yet-evaluated': 0, ledger: { total: 0, scope: 'listed-topics', topicsCounted: 0 }, builder: { wired: false } });
    expect(m.ledger).toEqual({ available: false, reason: 'token-ledger-unavailable' });
    expect(m.overall).toEqual({ unavailable: 'token-ledger-unavailable' });
    expect(parseMetricsQuery({ topic: '12x' }).ok).toBe(false);
    expect(parseMetricsQuery({ topic: '0' }).ok).toBe(false);
    expect(parseMetricsQuery({ sinceHours: '-1' }).ok).toBe(false);
    expect(parseMetricsQuery({ topic: '42', sinceHours: '99999' })).toEqual({ ok: true, query: { topicId: 42, sinceHours: 720 } });
  });

  it('metrics: per-topic numbers from a real ledger — cost, rework, verbatim share, U size, G/C growth inputs', () => {
    const sd = tmp('cbm-t-');
    const layers = buildContextLayers({ stateDir: sd });
    const l = mkLedger();
    l.ingestLine(userPrompt(0, '[telegram:4242 "t"] check the build'));
    l.ingestLine(req(1, { tools: [{ id: 'r1', name: 'Read', input: { file_path: '/a.ts' } }] }));
    l.ingestLine(req(2, { tools: [{ id: 'r2', name: 'Read', input: { file_path: '/a.ts' } }] }));
    const now = T0 + 3_600_000;
    const m = computeContextBudgetMetrics({
      layers, stateDir: sd, ledger: l, now: () => now,
      topicMemory: { operatorCorpusSize: () => ({ messages: 3, chars: 400, forwarded: 1 }) },
      topicIntentStore: { read: () => ({ telemetry: { capture: { extractions_attempted: 7, layer_ticks: 2, budget_deferred: 1 } } }) },
    }, { topicId: 4242 });
    expect(m.sessions).toHaveLength(1);
    expect(m.sessions[0].topicId).toBe(4242);
    expect(m.sessions[0].cost.perRequest.inputWeighted).toBe(4 + 5_000 + 2_000);
    expect(m.sessions[0].liveContext.latest).toBe(4 + 50_000 + 1_000);
    const [t] = m.topics;
    expect(t.rework).toMatchObject({ toolInputs: 2, repeats: 1, rate: 0.5 });
    expect(t.u).toEqual({ messages: 3, forwarded: 1, chars: 400, estimatedTokens: 100 });
    expect(t.extractor).toMatchObject({ extractions_attempted: 7, layer_ticks: 2, budget_deferred: 1 });
    expect(t.operatorVerbatimShare).toMatchObject({ delivered: 1, verbatimInContext: 1, share: 1 });
    expect(t.liveSetBudgetInputs.g.status).toBe('no-records-yet');
    // No layer record for the topic yet: never evaluated, which is not the same as no-anchor.
    expect(t.anchorLedger).toMatchObject({ anchor: 'not-yet-evaluated', anchorRows: 0, ledger: { total: 0 } });
    expect(m.anchors).toMatchObject({ topics: 0, 'not-yet-evaluated': 0, ledger: { total: 0 } });
  });

  it('metrics: Anchor states and ledger counts come from the layer store (S6 replaces the unavailable read)', () => {
    const sd = tmp('cbm-a-');
    const layers = buildContextLayers({ stateDir: sd });
    const meta = (status: string) => ({ author: { sessionId: null, machine: 'm', model: null, kind: 'user' as const }, asOf: { at: T0, lastMessageId: 1 }, status });
    const ref = { messageId: 1, sha256: 'a'.repeat(64), length: 40 };
    layers.store.writeProtected('4242', 'anchor', 'current', [ref], meta('anchored'), { messageIds: [1] });
    layers.store.writeProtected('4242', 'ledger-entry', 'dc-ref-1', [ref], meta('derived-settled'), { type: 'decision', at: T0 });
    layers.store.writeProtected('4242', 'ledger-entry', 'ev-ref-2', [], meta('tentative'), { type: 'evolution', at: T0 });
    layers.store.writeProtected('5353', 'anchor', 'current', [], meta('no-anchor'), {});
    const m = computeContextBudgetMetrics({ layers, stateDir: sd, ledger: null, now: () => T0 });
    expect(m.anchors).toMatchObject({ topics: 2, anchored: 1, 'no-anchor': 1, 'not-yet-evaluated': 0 });
    expect(m.anchors.ledger).toMatchObject({ total: 2, byType: { decision: 1, evolution: 1 }, byStatus: { 'derived-settled': 1, tentative: 1 } });
    const t = m.topics.find((x) => x.topicId === 4242)!;
    expect(t.anchorLedger).toMatchObject({ anchor: 'anchored', anchorRows: 1, ledger: { total: 2 } });
  });

  it('overall is uncapped and flags the per-session cut; a session keeps a topic whose prompt is older than the window', () => {
    const sd = tmp('cbm-o-');
    const layers = buildContextLayers({ stateDir: sd });
    const l = mkLedger();
    for (let i = 0; i < 55; i++) l.ingestLine(req(i, { sid: `sess-${String(i).padStart(4, '0')}-aaaa` }));
    // Prompt three days before the window; the session's request is inside it.
    const old = 'bbbbbbbb-0000-4000-8000-000000000001';
    l.ingestLine(JSON.stringify({ type: 'user', sessionId: old, timestamp: iso(T0 - 3 * 86_400_000), uuid: 'u-old', message: { role: 'user', content: '[telegram:5151 "t"] long job' } }));
    l.ingestLine(req(1000, { sid: old }));
    const now = T0 + 3_600_000;
    const m = computeContextBudgetMetrics({ layers, stateDir: sd, ledger: l, now: () => now }, { sinceHours: 24 });
    expect(m.ledger).toMatchObject({ sessionsInWindow: 56, sessionsListed: 50, sessionsTruncated: true });
    expect((m.overall as { requests: number; sessions: number }).requests).toBe(56);
    const scoped = computeContextBudgetMetrics({ layers, stateDir: sd, ledger: l, now: () => now }, { topicId: 5151 });
    expect(scoped.sessions[0]).toMatchObject({ sessionId: old, topicId: 5151 });
    expect(scoped.topics[0].cost).toMatchObject({ requests: 1, sessions: 1 });
    // A topic with no session in the window says so instead of reading zero.
    const empty = computeContextBudgetMetrics({ layers, stateDir: sd, ledger: l, now: () => now }, { topicId: 6262 });
    expect(empty.topics[0].cost).toEqual({ unavailable: 'no-session-in-window' });
    expect(empty.topics[0].rework).toEqual({ unavailable: 'no-session-in-window' });
  });
});
