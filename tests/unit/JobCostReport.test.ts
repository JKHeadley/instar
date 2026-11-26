/**
 * JobCostReport (docs/specs/job-cost-reduction.md §9): per-slug math against the real
 * TokenLedger + FeatureMetricsLedger, the weighting, baseline null → auto-freeze at
 * 7 days, manual freeze + already-frozen refusal, and the transcript backfill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { JobCostReport, JobCostBaselineFrozenError, weighTokens, firstUserPrompt, JOB_COST_WEIGHTS } from '../../src/scheduler/JobCostReport.js';
import type { JobRun } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

let dir: string;
let ledger: TokenLedger;
let fm: FeatureMetricsLedger;
let runs: JobRun[];
let now: number;

function run(slug: string, startedAt: number, extra: Partial<JobRun> & { tokens?: number; runner?: string } = {}): JobRun {
  return { runId: `${slug}-${startedAt}`, slug, sessionId: `tmux-${slug}-${startedAt}`, trigger: 'scheduled',
    startedAt: new Date(startedAt).toISOString(), result: 'success', machineId: 'm1', ...extra } as JobRun;
}

function makeReport(extra: Partial<ConstructorParameters<typeof JobCostReport>[0]> = {}): JobCostReport {
  return new JobCostReport({
    stateDir: dir,
    machineId: () => 'm1',
    runHistory: { query: () => ({ runs }) },
    tokenLedger: ledger,
    featureMetrics: fm,
    now: () => now,
    ...extra,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcr-'));
  ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent', attributionBackfill: 'off' });
  fm = new FeatureMetricsLedger({ dbPath: ':memory:', now: () => now });
  runs = [];
  now = T0;
});
afterEach(() => { ledger.close(); fm.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/JobCostReport.test.ts' }); });

describe('weighTokens', () => {
  it('uses input 1, output 5, cache-read 0.1, cache-write 1.25', () => {
    expect(JOB_COST_WEIGHTS).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(weighTokens({ in: 100, out: 10, cacheRead: 1000, cacheWrite: 40 })).toBe(100 + 50 + 100 + 50);
  });
});

describe('JobCostReport.compute', () => {
  it('reports per-slug runs, sessions, feature calls and weighted tokens; baseline null with a reason', async () => {
    const report = makeReport();
    report.ensureCollectionStarted();
    now = T0 + 2 * DAY;
    runs = [
      run('health-check', T0 + DAY, { tokens: 0, runner: 'script' }),
      run('health-check', T0 + DAY + 1, { result: 'failure', tokens: 0 }),
      run('commitment-detection', T0 + DAY),
      run('old', T0 - 30 * DAY),
      run('other-machine', T0 + DAY, { machineId: 'm2' }),
    ];
    ledger.recordJobSession('tmux-cd', 'commitment-detection', 'm1', T0 + DAY);
    ledger.bindJobSessionTranscript('tmux-cd', 'uuid-cd');
    ledger.recordEvent({ requestId: 'r1', sessionId: 'uuid-cd', ts: T0 + DAY + 5, model: 'claude-opus-5-5',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 40 });
    ledger.recordJobSession('tmux-tri', 'health-check', 'm1', T0 + DAY, 'triage'); // never bound
    fm.record({ feature: 'JobAnomalyNarrator', outcome: 'fired', tokensIn: 200, tokensCached: 100, tokensOut: 20,
      model: 'claude-haiku-4-5', framework: 'claude-code', jobSlug: 'health-check', machineId: 'm1', runId: 'ep-1', ts: T0 + DAY });
    fm.record({ feature: 'JobAnomalyNarrator', outcome: 'shed', jobSlug: 'health-check', ts: T0 + DAY }); // no call ran
    fm.record({ feature: 'Unrelated', outcome: 'fired', tokensIn: 999, ts: T0 + DAY });

    const out = await report.compute(7);
    expect(out.baseline).toBeNull();
    expect(out.baselineReason).toMatch(/collecting/);
    const hc = out.slugs.find(s => s.slug === 'health-check')!;
    expect(hc).toMatchObject({ runs: 2, scriptRuns: 2, failures: 1, modelCalls: 1, narrations: 1, triageSessions: 1 });
    expect(hc.tokens).toEqual({ in: 100, out: 20, cacheRead: 100, cacheWrite: 0 });
    expect(hc.weightedTokens).toBe(100 + 100 + 10);
    expect(hc.frameworks).toEqual({ 'claude-code': 1 });
    expect(hc.sessions.triage).toMatchObject({ recorded: 1, unbound: 1 });
    const cd = out.slugs.find(s => s.slug === 'commitment-detection')!;
    expect(cd).toMatchObject({ runs: 1, scriptRuns: 0, modelCalls: 1 });
    expect(cd.weightedTokens).toBe(100 + 50 + 100 + 50);
    expect(cd.models).toEqual({ 'claude-opus-5-5': 1 });
    expect(out.slugs.find(s => s.slug === 'old')).toBeUndefined();
    expect(out.slugs.find(s => s.slug === 'other-machine')).toBeUndefined();
    expect(out.unboundJobSessions).toBe(1);
    expect(out.totals.runs).toBe(3);
    expect(out.weights).toEqual(JOB_COST_WEIGHTS);
  });

  it('auto-freezes over the prospective week on the first report ≥ 7 days after collection start', async () => {
    const report = makeReport();
    report.ensureCollectionStarted();
    runs = [run('j', T0 + DAY), run('j', T0 + 3 * DAY, { result: 'failure' }), run('j', T0 + 8 * DAY)];
    now = T0 + 7 * DAY - 1;
    expect((await report.compute(7)).baseline).toBeNull();
    now = T0 + 9 * DAY;
    const out = await report.compute(7);
    expect(out.baseline).toMatchObject({ method: 'prospective', dateRange: { from: new Date(T0).toISOString(), to: new Date(T0 + 7 * DAY).toISOString() } });
    const j = out.slugs.find(s => s.slug === 'j')!;
    expect(j.baseline).toMatchObject({ runs: 2, failures: 1 });
    expect(j.baseline!.failuresPerDay).toEqual([0, 0, 0, 1, 0, 0, 0]);
    // The file on disk carries method, weights, dateRange, perSlug, unmapped, frozenAt.
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'job-cost-baseline.json'), 'utf-8'));
    expect(Object.keys(file)).toEqual(expect.arrayContaining(['method', 'weights', 'dateRange', 'perSlug', 'unmapped', 'frozenAt']));
    expect(file.weights).toEqual(JOB_COST_WEIGHTS);
  });

  it('manual freeze works early, and refuses a second freeze unless forced', async () => {
    const report = makeReport();
    report.ensureCollectionStarted();
    now = T0 + 2 * DAY;
    runs = [run('j', T0 + DAY)];
    const file = await report.freeze();
    expect(file.method).toBe('prospective-manual');
    expect(file.dateRange!.from).toBe(new Date(T0).toISOString()); // clipped to collection start
    await expect(report.freeze()).rejects.toBeInstanceOf(JobCostBaselineFrozenError);
    const again = await report.freeze({ force: true });
    expect(again.frozenAt).toBeTruthy();
    expect((await report.compute(7)).baseline).not.toBeNull();
  });

  it('states missing sources instead of reading them as zero', async () => {
    const out = await makeReport({ tokenLedger: null, featureMetrics: null }).compute(7);
    expect(out.sources).toEqual({ runHistory: true, tokenLedger: false, featureMetrics: false });
  });
});

describe('backfill', () => {
  it('maps first prompts by the job VIEW METADATA signature or the body prefix; counts unmapped', async () => {
    const heads: Record<string, string> = {
      '/t/a.jsonl': JSON.stringify({ type: 'user', message: { role: 'user', content: '[VIEW METADATA]\n  "metadata": { "source": { "type": "job", "id": "health-check" } }\n[/VIEW METADATA]\n\nbody' } }),
      '/t/b.jsonl': JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Run the grading pass now and check the three field types of the response.' }] } }),
      '/t/c.jsonl': JSON.stringify({ type: 'user', message: { role: 'user', content: '[VIEW METADATA] mangled no id' } }),
      '/t/d.jsonl': JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi there, can you help me' } }),
    };
    const fakeLedger = {
      jobTokenTotals: () => [], jobSessionCounts: () => [],
      sessionUsageInWindow: () => ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        sessionId: id, filePath: id === 'e' ? null : `/t/${id}.jsonl`, modelCalls: 2, tokensIn: 10, tokensOut: 1, cacheRead: 100, cacheWrite: 0,
      })),
    };
    const report = makeReport({
      tokenLedger: fakeLedger,
      jobBodies: () => new Map([['llm-decision-grading', 'Run the grading pass now and check the three field types of the response.']]),
      readHead: async (p) => heads[p] ?? null,
    });
    const b = (await report.backfill(0, T0))!;
    expect(Object.keys(b.perSlug).sort()).toEqual(['health-check', 'llm-decision-grading']);
    expect(b.perSlug['health-check']).toMatchObject({ sessions: 1, modelCalls: 2, weightedTokens: 10 + 5 + 10 });
    expect(b.unmapped).toBe(1);
    expect(b.nonJobSessions).toBe(1);
    expect(b.unreadable).toBe(1);
  });

  it('firstUserPrompt skips non-user lines and truncated JSON', () => {
    const head = [JSON.stringify({ type: 'summary', x: '"user"' }), JSON.stringify({ type: 'user', message: { content: 'hello' } }), '{"type":"user",'].join('\n');
    expect(firstUserPrompt(head)).toBe('hello');
    expect(firstUserPrompt('{"type":"assi')).toBeNull();
  });
});
