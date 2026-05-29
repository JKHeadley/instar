/**
 * Unit (Tier 1) for the Usher precision-numerator wiring (rung 4).
 *
 * Covers BOTH sides of every decision boundary with realistic inputs:
 *   - salientTerms: stopword/short-token stripping, lowercasing
 *   - contextCoveredBy: covers (≥2 shared & ≥50%) vs not (1 shared / low coverage / empty)
 *   - findCoveredSignalIds: skips already-acted, respects the recency window
 *   - markActedByCoverage: marks matches, stamps via/at, idempotent, never-throws
 *   - UsherSignalStore.markActed opts: via stamping + acted_by_use/miss split + backward-compat
 *   - creditUsherOnOutbound / creditUsherOnMiss: guards (null store / null miss / no topic / no text)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UsherSignalStore, type UsherSignal } from '../../src/core/UsherSignalStore.js';
import {
  salientTerms,
  contextCoveredBy,
  findCoveredSignalIds,
  markActedByCoverage,
  creditUsherOnOutbound,
  creditUsherOnMiss,
  USE_WINDOW_MS,
} from '../../src/core/UsherActedCorrelator.js';

let tempDir: string;
let store: UsherSignalStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usher-acted-'));
  store = new UsherSignalStore(tempDir);
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/UsherActedCorrelator.test.ts' }); } catch { /* */ }
});

function sig(overrides: Partial<UsherSignal> = {}): UsherSignal {
  return {
    id: overrides.id ?? 'usig-x',
    contextRef: overrides.contextRef ?? 'ref-1',
    contextText: overrides.contextText ?? 'we are testing the pipeline over telegram',
    reason: overrides.reason ?? 'why',
    turn: overrides.turn ?? 1,
    at: overrides.at ?? new Date().toISOString(),
    acted: overrides.acted ?? false,
    actedVia: overrides.actedVia,
    actedAt: overrides.actedAt,
  };
}

describe('salientTerms', () => {
  it('lowercases, strips stopwords + short tokens, dedupes', () => {
    const t = salientTerms('We are TESTING the Pipeline over Telegram!!');
    expect(t.has('testing')).toBe(true);
    expect(t.has('pipeline')).toBe(true);
    expect(t.has('telegram')).toBe(true);
    // stopwords + short tokens gone
    expect(t.has('we')).toBe(false);
    expect(t.has('are')).toBe(false);
    expect(t.has('the')).toBe(false);
    expect(t.has('over')).toBe(false);
  });
  it('empty / non-string → empty set', () => {
    expect(salientTerms('').size).toBe(0);
    // @ts-expect-error testing defensive path
    expect(salientTerms(null).size).toBe(0);
  });
});

describe('contextCoveredBy', () => {
  it('TRUE when the probe covers ≥2 shared terms and ≥50% of the context', () => {
    expect(contextCoveredBy(
      'testing pipeline telegram',
      'Sure — I will keep testing the pipeline tonight.',
    )).toBe(true); // shared {testing,pipeline}=2, coverage 2/3≈0.67
  });
  it('FALSE on a single coincidental shared word', () => {
    expect(contextCoveredBy(
      'testing pipeline telegram',
      'the telegram bot is unrelated chatter',
    )).toBe(false); // shared {telegram}=1 < MIN_SHARED
  });
  it('FALSE when coverage is below half even with 2 shared', () => {
    expect(contextCoveredBy(
      'alpha beta gamma delta epsilon zeta', // 6 salient
      'alpha beta only', // shared 2 but coverage 2/6≈0.33
    )).toBe(false);
  });
  it('FALSE on empty context or empty probe', () => {
    expect(contextCoveredBy('', 'anything here')).toBe(false);
    expect(contextCoveredBy('testing pipeline', '')).toBe(false);
  });
});

describe('findCoveredSignalIds', () => {
  it('returns ids of covered, NOT-acted signals only', () => {
    const signals = [
      sig({ id: 'a', contextText: 'deploy staging pipeline tonight' }),
      sig({ id: 'b', contextText: 'unrelated neo4j migration', acted: false }),
      sig({ id: 'c', contextText: 'deploy staging pipeline tonight', acted: true }), // already acted → skip
    ];
    const ids = findCoveredSignalIds(signals, 'I will deploy the staging pipeline now');
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
  });
  it('respects the recency window (maxAgeMs)', () => {
    const now = 1_000_000_000_000;
    const fresh = sig({ id: 'fresh', at: new Date(now - 1000).toISOString(), contextText: 'deploy staging pipeline' });
    const old = sig({ id: 'old', at: new Date(now - 10 * 60 * 60 * 1000).toISOString(), contextText: 'deploy staging pipeline' });
    const ids = findCoveredSignalIds([fresh, old], 'deploy the staging pipeline', { maxAgeMs: 6 * 60 * 60 * 1000, nowMs: now });
    expect(ids).toEqual(['fresh']);
  });
});

describe('UsherSignalStore.markActed opts (via split + backward-compat)', () => {
  it('stamps actedVia/actedAt and increments the matching split counter', () => {
    const id = store.recordSignal(7, { contextRef: 'r', contextText: 't', reason: 'w', turn: 1 })!;
    expect(store.markActed(7, id, { via: 'use', at: '2026-01-01T00:00:00.000Z' })).toBe(true);
    const m = store.getMetrics(7);
    expect(m.acted).toBe(1);
    expect(m.acted_by_use).toBe(1);
    expect(m.acted_by_miss ?? 0).toBe(0);
    const s = store.getSignals(7).find(x => x.id === id)!;
    expect(s.actedVia).toBe('use');
    expect(s.actedAt).toBe('2026-01-01T00:00:00.000Z');
  });
  it('miss path increments acted_by_miss; idempotent on repeat', () => {
    const id = store.recordSignal(7, { contextRef: 'r', contextText: 't', reason: 'w', turn: 1 })!;
    expect(store.markActed(7, id, { via: 'miss' })).toBe(true);
    expect(store.markActed(7, id, { via: 'miss' })).toBe(false); // idempotent
    const m = store.getMetrics(7);
    expect(m.acted).toBe(1);
    expect(m.acted_by_miss).toBe(1);
  });
  it('backward-compat: 2-arg markActed still works (no via)', () => {
    const id = store.recordSignal(7, { contextRef: 'r', contextText: 't', reason: 'w', turn: 1 })!;
    expect(store.markActed(7, id)).toBe(true);
    expect(store.getMetrics(7).acted).toBe(1);
  });
});

describe('markActedByCoverage (integration over the real store)', () => {
  it('marks the covered signal acted with the given via, returns its id', () => {
    const id = store.recordSignal(9, { contextRef: 'r', contextText: 'deploy staging pipeline tonight', reason: 'w', turn: 1 })!;
    const marked = markActedByCoverage(store, 9, 'On it — I will deploy the staging pipeline tonight.', 'use');
    expect(marked).toEqual([id]);
    expect(store.getMetrics(9).acted_by_use).toBe(1);
  });
  it('does nothing when nothing is covered', () => {
    store.recordSignal(9, { contextRef: 'r', contextText: 'deploy staging pipeline', reason: 'w', turn: 1 });
    expect(markActedByCoverage(store, 9, 'totally unrelated chit chat about lunch', 'use')).toEqual([]);
    expect(store.getMetrics(9).acted).toBe(0);
  });
  it('best-effort: bad probe text / topic → [] (never throws)', () => {
    // @ts-expect-error defensive
    expect(markActedByCoverage(store, 9, null, 'use')).toEqual([]);
    // @ts-expect-error defensive
    expect(markActedByCoverage(store, NaN, 'text', 'use')).toEqual([]);
  });
});

describe('creditUsherOnOutbound (path a wrapper)', () => {
  it('credits a recent matching nudge with via=use', () => {
    const id = store.recordSignal(11, { contextRef: 'r', contextText: 'unify the memory stores', reason: 'w', turn: 1 })!;
    const credited = creditUsherOnOutbound(store, 11, 'Great — unifying the memory stores now.');
    expect(credited).toEqual([id]);
    expect(store.getMetrics(11).acted_by_use).toBe(1);
  });
  it('null/undefined store → [] (Usher disabled)', () => {
    expect(creditUsherOnOutbound(null, 11, 'anything')).toEqual([]);
    expect(creditUsherOnOutbound(undefined, 11, 'anything')).toEqual([]);
  });
  it('does not credit a nudge older than the use window', () => {
    const now = 2_000_000_000_000;
    store.recordSignal(11, { contextRef: 'r', contextText: 'unify the memory stores', reason: 'w', turn: 1, at: new Date(now - USE_WINDOW_MS - 1000).toISOString() });
    const credited = creditUsherOnOutbound(store, 11, 'unifying the memory stores', { now: () => now });
    expect(credited).toEqual([]);
  });
});

describe('creditUsherOnMiss (path b wrapper)', () => {
  it('credits a prior nudge with via=miss when the correction covers it', () => {
    const id = store.recordSignal(13, { contextRef: 'r', contextText: 'we are testing over telegram', reason: 'w', turn: 1 })!;
    const missSignal = { category: 'staleness' }; // non-null = a real miss
    const credited = creditUsherOnMiss(store, missSignal, { topicId: 13, text: "actually, you forgot we are testing over telegram" });
    expect(credited).toEqual([id]);
    expect(store.getMetrics(13).acted_by_miss).toBe(1);
  });
  it('no-op when there was no miss (null signal)', () => {
    store.recordSignal(13, { contextRef: 'r', contextText: 'we are testing over telegram', reason: 'w', turn: 1 });
    expect(creditUsherOnMiss(store, null, { topicId: 13, text: 'we are testing over telegram' })).toEqual([]);
    expect(store.getMetrics(13).acted).toBe(0);
  });
  it('no-op when topic or text is missing', () => {
    store.recordSignal(13, { contextRef: 'r', contextText: 'we are testing over telegram', reason: 'w', turn: 1 });
    const miss = { category: 'staleness' };
    expect(creditUsherOnMiss(store, miss, { topicId: null, text: 'we are testing over telegram' })).toEqual([]);
    expect(creditUsherOnMiss(store, miss, { topicId: 13 })).toEqual([]);
  });
});
