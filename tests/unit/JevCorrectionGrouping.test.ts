/**
 * Unit — JevCorrectionGrouping (spec: docs/specs/correction-meaning-grouping.md).
 *
 * Pins both sides of every decision: candidate floor; Jev confident same /
 * confident not-same / unsure; unsure → referee true / false / failure; no key
 * and disabled fall back to word overlap; cache reuse and pruning; the per-run
 * call budget; and the analyzer's complete-link rule over meaning edges
 * (A~B and B~C never chain to A~C).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  JevCorrectionGrouper,
  buildJevCorrectionGrouper,
  candidatePairs,
  pairKey,
  GROUPING_MODEL,
  type MeaningGroupingConfig,
} from '../../src/core/JevCorrectionGrouping.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionAnalyzer, learningTokenSet } from '../../src/monitoring/CorrectionAnalyzer.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const dirs: string[] = [];
let ledger: CorrectionLedger | null = null;
afterEach(() => {
  ledger?.close(); ledger = null;
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/JevCorrectionGrouping.test.ts:afterEach' });
});
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-')); dirs.push(d); return d; }

/** Fake Jev: P(same) per pair decided by `score(stateText)`. */
function fakeJev(score: (state: string) => number, opts: { model?: string; status?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: string; questions: Record<string, unknown> };
    calls.push(body.state);
    if (opts.status && opts.status !== 200) return { ok: false, status: opts.status, json: async () => ({}) };
    const p = score(body.state);
    const ans = { choice: p > 0.5 ? 'same' : 'related', probabilities: { same: p, related: 1 - p, different: 0, cannot_tell: 0 } };
    return { ok: true, status: 200, json: async () => ({ model: opts.model ?? GROUPING_MODEL, usage: { input_tokens: 600 }, answers: { same: ans, same_rev: ans } }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fakeReferee(answer: boolean | 'fail') {
  const prompts: string[] = [];
  const p: IntelligenceProvider = {
    evaluate: async (prompt: string) => {
      prompts.push(prompt);
      if (answer === 'fail') throw new Error('boom');
      return JSON.stringify({ same: answer });
    },
  } as unknown as IntelligenceProvider;
  return { provider: p, prompts };
}

function grouper(dir: string, cfg: MeaningGroupingConfig, fetchImpl: typeof fetch, referee: IntelligenceProvider | null = null, key: string | null = 'k') {
  return new JevCorrectionGrouper({
    getConfig: () => cfg,
    readKey: () => key,
    cachePath: path.join(dir, 'state', 'pairs.json'),
    logPath: path.join(dir, 'logs', 'grouping.jsonl'),
    referee,
    fetchImpl,
  });
}

const rec = (key: string, learning: string, kind = 'user-preference') => ({ dedupeKey: key, kind, learning });

describe('candidatePairs', () => {
  it('keeps same-kind pairs at or above the word-overlap floor and drops the rest', () => {
    const records = [
      rec('a', 'merge approved changes without waiting'),
      rec('b', 'merge changes once approved, never wait'),
      rec('c', 'use plain language in reports'),
      rec('d', 'merge approved changes without waiting', 'infra-gap'),
    ];
    const pairs = candidatePairs(records, learningTokenSet, 0.05);
    expect(pairs.map(([x, y]) => x.dedupeKey + y.dedupeKey)).toEqual(['ab']);
  });
});

describe('JevCorrectionGrouper.prepare', () => {
  const A = rec('ka', 'Require approval only for constitution changes.');
  const B = rec('kb', 'Ask the user to approve constitution changes only, never other changes.');

  it('confident Jev "same" (above the band) is an edge', async () => {
    const { fetchImpl, calls } = fakeJev(() => 0.95);
    const g = grouper(tmp(), { enabled: true }, fetchImpl);
    const out = await g.prepare([A, B], learningTokenSet);
    expect(out.report.mode).toBe('meaning');
    expect(out.report.jevCalls).toBe(1);
    expect(out.report.sameEdges).toBe(1);
    expect(out.sameMeaning!(A, B)).toBe(true);
    expect(calls[0]).toContain('NOTE A: ');
  });

  it('confident Jev "not same" (below the band) is no edge, and no referee call', async () => {
    const { fetchImpl } = fakeJev(() => 0.1);
    const ref = fakeReferee(true);
    const out = await grouper(tmp(), { enabled: true }, fetchImpl, ref.provider).prepare([A, B], learningTokenSet);
    expect(out.sameMeaning!(A, B)).toBe(false);
    expect(ref.prompts).toHaveLength(0);
  });

  it('unsure → referee true is an edge; referee false is not; referee failure leaves it unsure', async () => {
    for (const [answer, edge, unsure] of [[true, true, 0], [false, false, 0], ['fail', false, 1]] as const) {
      const { fetchImpl } = fakeJev(() => 0.5);
      const ref = fakeReferee(answer);
      const out = await grouper(tmp(), { enabled: true }, fetchImpl, ref.provider).prepare([A, B], learningTokenSet);
      expect(ref.prompts).toHaveLength(1);
      expect(out.sameMeaning!(A, B)).toBe(edge);
      expect(out.report.unsurePairs).toBe(unsure);
    }
  });

  it('unsure with no referee is no edge', async () => {
    const { fetchImpl } = fakeJev(() => 0.6);
    const out = await grouper(tmp(), { enabled: true }, fetchImpl, null).prepare([A, B], learningTokenSet);
    expect(out.sameMeaning!(A, B)).toBe(false);
    expect(out.report.unsurePairs).toBe(1);
  });

  it('falls back to word overlap (null lookup) when disabled or without a key', async () => {
    const { fetchImpl, calls } = fakeJev(() => 0.95);
    const off = await grouper(tmp(), { enabled: false }, fetchImpl).prepare([A, B], learningTokenSet);
    expect(off.sameMeaning).toBeNull();
    expect(off.report.reason).toBe('disabled');
    const noKey = await grouper(tmp(), { enabled: true }, fetchImpl, null, null).prepare([A, B], learningTokenSet);
    expect(noKey.sameMeaning).toBeNull();
    expect(noKey.report.reason).toBe('no-key');
    expect(calls).toHaveLength(0);
  });

  it('a served-model mismatch or HTTP error makes no edge and caches nothing', async () => {
    const dir = tmp();
    const mismatch = fakeJev(() => 0.95, { model: 'jev-0.1' });
    const out = await grouper(dir, { enabled: true }, mismatch.fetchImpl).prepare([A, B], learningTokenSet);
    expect(out.sameMeaning!(A, B)).toBe(false);
    expect(out.report.jevFailures).toBe(1);
    expect(out.report.deferred).toBe(1);
    const err = fakeJev(() => 0.95, { status: 500 });
    const out2 = await grouper(dir, { enabled: true }, err.fetchImpl).prepare([A, B], learningTokenSet);
    expect(out2.report.jevFailures).toBe(1);
  });

  it('reuses cached verdicts (no second call) and prunes pairs no longer open', async () => {
    const dir = tmp();
    const C = rec('kc', 'Approve only constitution changes yourself.');
    const first = fakeJev(() => 0.95);
    await grouper(dir, { enabled: true }, first.fetchImpl).prepare([A, B, C], learningTokenSet);
    expect(first.calls.length).toBe(3);
    const second = fakeJev(() => 0.95);
    const out = await grouper(dir, { enabled: true }, second.fetchImpl).prepare([A, B], learningTokenSet);
    expect(second.calls).toHaveLength(0);
    expect(out.report.cached).toBe(1);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'pairs.json'), 'utf8'));
    expect(Object.keys(stored.pairs)).toEqual([pairKey('ka', 'kb')]);
  });

  it('stops at the per-run call budget and reports the rest as deferred', async () => {
    const many = Array.from({ length: 5 }, (_, i) => rec(`k${i}`, `approve constitution changes only variant ${i}`));
    const { fetchImpl, calls } = fakeJev(() => 0.95);
    const out = await grouper(tmp(), { enabled: true, maxJevCallsPerRun: 3 }, fetchImpl).prepare(many, learningTokenSet);
    expect(calls).toHaveLength(3);
    expect(out.report.deferred).toBe(out.report.candidates - 3);
  });

  it('writes content-free audit rows (pair keys and numbers, never the learning text)', async () => {
    const dir = tmp();
    const { fetchImpl } = fakeJev(() => 0.95);
    await grouper(dir, { enabled: true }, fetchImpl).prepare([A, B], learningTokenSet);
    const log = fs.readFileSync(path.join(dir, 'logs', 'grouping.jsonl'), 'utf8');
    expect(log).toContain('"kind":"jev"');
    expect(log).not.toContain('constitution');
  });
});

describe('buildJevCorrectionGrouper — dev-agent gate', () => {
  it('omitted enabled is live on a development agent and dark on the fleet', async () => {
    const { fetchImpl } = fakeJev(() => 0.95);
    const A = rec('ka', 'Require approval only for constitution changes.');
    const B = rec('kb', 'Ask approval for constitution changes only.');
    for (const [dev, mode] of [[true, 'meaning'], [false, 'words']] as const) {
      const g = buildJevCorrectionGrouper({
        readLiveConfig: () => undefined, developmentAgent: dev, readSecret: () => 'k', stateDir: tmp(), fetchImpl,
      });
      expect((await g.prepare([A, B], learningTokenSet)).report.mode).toBe(mode);
    }
  });
});

describe('CorrectionAnalyzer with meaning edges', () => {
  function fresh(): CorrectionLedger {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'test', maxOccurrencesPerKey: 200 });
    return ledger;
  }

  it('keeps complete-link: meaning edges A~B and B~C do not chain A and C', async () => {
    const l = fresh();
    const a = l.record({ kind: 'user-preference', learning: 'alpha one', scrubbedSummary: 'a', deterministicWeight: 3, detectedAt: '2026-05-01T10:00:00Z' })!;
    const b = l.record({ kind: 'user-preference', learning: 'alpha two', scrubbedSummary: 'b', deterministicWeight: 3, detectedAt: '2026-05-02T10:00:00Z' })!;
    const c = l.record({ kind: 'user-preference', learning: 'alpha three', scrubbedSummary: 'c', deterministicWeight: 3, detectedAt: '2026-05-03T10:00:00Z' })!;
    const same = new Set([pairKey(a.dedupeKey, b.dedupeKey), pairKey(b.dedupeKey, c.dedupeKey)]);
    const keyOf = new Map([a, b, c].map((r) => [r.learning, r.dedupeKey]));
    const { fetchImpl } = fakeJev((state) => {
      const [x, y] = state.split('\n').map((line) => line.replace(/^NOTE [AB]: /, ''));
      return same.has(pairKey(keyOf.get(x)!, keyOf.get(y)!)) ? 0.95 : 0.05;
    });
    const analyzer = new CorrectionAnalyzer(l, undefined, grouper(tmp(), { enabled: true }, fetchImpl));
    await analyzer.refreshMeaningGrouping();
    expect(analyzer.groups().map((g) => g.map((r) => r.id))).toEqual([[a.id, b.id], [c.id]]);
  });

  it('a group of four reworded records crosses the unchanged preference gate', async () => {
    const l = fresh();
    const learnings = [
      'Require approval only for constitution changes.',
      'Only ask me to approve changes to the constitution.',
      'Constitution edits are the one thing that needs my approval.',
      'Do not ask for approval except for constitution changes.',
    ];
    learnings.forEach((learning, i) => l.record({
      kind: 'user-preference', learning, scrubbedSummary: `s${i}`, deterministicWeight: 3,
      topicId: 1, sessionId: `session-${(i % 2) + 1}`, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z`,
    }));
    const wordsOnly = new CorrectionAnalyzer(l);
    expect(wordsOnly.analyze().crossed).toHaveLength(0);
    const { fetchImpl } = fakeJev(() => 0.97);
    const analyzer = new CorrectionAnalyzer(l, undefined, grouper(tmp(), { enabled: true }, fetchImpl));
    const report = await analyzer.refreshMeaningGrouping();
    expect(report?.mode).toBe('meaning');
    const result = analyzer.analyze();
    expect(result.crossed).toHaveLength(1);
    expect(result.crossed[0].clusterRecords).toHaveLength(4);
  });

  it('without a grouper the analyzer behaves exactly as before', async () => {
    const l = fresh();
    l.record({ kind: 'user-preference', learning: 'x y z', scrubbedSummary: 's', deterministicWeight: 3 });
    const analyzer = new CorrectionAnalyzer(l);
    expect(await analyzer.refreshMeaningGrouping()).toBeNull();
    expect(analyzer.analyze().considered).toBe(1);
  });
});

describe('POST /corrections/analyze request budget', () => {
  it('outlasts the grouping run budget plus one in-flight referee call (second-pass concern)', async () => {
    const { buildRequestTimeoutOverrides, resolveRequestTimeout, CORRECTIONS_ANALYZE_TIMEOUT_MS } = await import('../../src/server/middleware.js');
    const { DEFAULT_RUN_BUDGET_MS } = await import('../../src/core/JevCorrectionGrouping.js');
    expect(resolveRequestTimeout('/corrections/analyze', 30_000, buildRequestTimeoutOverrides())).toBe(CORRECTIONS_ANALYZE_TIMEOUT_MS);
    expect(CORRECTIONS_ANALYZE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RUN_BUDGET_MS + 60_000);
  });
});

describe('cachedLookup', () => {
  it('is null with nothing cached, so the groups read never claims meaning mode it did not use', async () => {
    const { fetchImpl } = fakeJev(() => 0.95);
    const dir = tmp();
    const g = grouper(dir, { enabled: true }, fetchImpl);
    expect(g.cachedLookup()).toBeNull();
    await g.prepare([rec('ka', 'approve constitution changes only'), rec('kb', 'constitution changes alone need approval')], learningTokenSet);
    expect(g.cachedLookup()).not.toBeNull();
  });
});

describe('renderPairState', () => {
  it('refuses a note longer than the scrub span or carrying a private-key marker (the pair is skipped, never cut blind)', async () => {
    const { renderPairState } = await import('../../src/core/JevCorrectionGrouping.js');
    expect(renderPairState('short rule', 'another rule')).toBe('NOTE A: short rule\nNOTE B: another rule');
    expect(renderPairState('x'.repeat(5000), 'another rule')).toBeNull();
    expect(renderPairState('-----BEGIN RSA PRIVATE KEY----- abc', 'another rule')).toBeNull();
  });
});
