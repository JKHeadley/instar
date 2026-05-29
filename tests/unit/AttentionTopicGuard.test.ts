/**
 * Tier-1 unit tests for AttentionTopicGuard — the per-source + global forum-topic
 * circuit breaker (2026-05-28 topic-flood lockdown). Covers both sides of every
 * boundary: under/over budget, critical-priority bypass (case-insensitive),
 * sustained-flood single episode, post-silence reset, the GLOBAL cap that defeats
 * source-key variation, config validation, and key eviction.
 */

import { describe, expect, it } from 'vitest';
import { AttentionTopicGuard, DEFAULT_ATTENTION_TOPIC_GUARD, GLOBAL_BUCKET } from '../../src/messaging/AttentionTopicGuard.js';

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// A budget that won't let the global cap interfere with per-source tests.
const HIGH_GLOBAL = { maxTopicsGlobal: 100_000, maxTrackedSources: 100_000 };

describe('AttentionTopicGuard', () => {
  it('allows items up to the budget, then coalesces the rest within the window (under the source bucket)', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 3, ...HIGH_GLOBAL }, clock.now);

    expect(g.decide('collaboration-redrive', 'NORMAL')).toEqual({ action: 'allow' });
    expect(g.decide('collaboration-redrive', 'NORMAL')).toEqual({ action: 'allow' });
    expect(g.decide('collaboration-redrive', 'NORMAL')).toEqual({ action: 'allow' });
    expect(g.decide('collaboration-redrive', 'NORMAL')).toEqual({ action: 'coalesce', firstInEpisode: true, suppressedCount: 1, bucket: 'collaboration-redrive' });
    expect(g.decide('collaboration-redrive', 'NORMAL')).toEqual({ action: 'coalesce', firstInEpisode: false, suppressedCount: 2, bucket: 'collaboration-redrive' });
  });

  it('isolates the per-source budget (while under the global cap)', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 1, ...HIGH_GLOBAL }, clock.now);
    expect(g.decide('source-a', 'NORMAL').action).toBe('allow');
    expect(g.decide('source-a', 'NORMAL').action).toBe('coalesce');
    expect(g.decide('source-b', 'NORMAL').action).toBe('allow'); // its own fresh budget
  });

  it('NEVER coalesces HIGH or URGENT, case-insensitive, and treats CRITICAL as critical', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 1, maxTopicsGlobal: 1, maxTrackedSources: 10 }, clock.now);
    expect(g.decide('svc', 'NORMAL').action).toBe('allow');
    expect(g.decide('svc', 'NORMAL').action).toBe('coalesce'); // budget burned
    // critical priorities always bypass — in any case, repeatedly, even over budget.
    for (const p of ['HIGH', 'high', 'URGENT', 'urgent', 'CRITICAL', 'critical']) {
      expect(g.decide('svc', p).action).toBe('allow');
    }
  });

  it('GLOBAL cap defeats source-key variation (the high-cardinality dodge)', () => {
    const clock = makeClock();
    // per-source budget is generous, but the global ceiling is 4. A mis-wired
    // source that uses a UNIQUE key per item must still be bounded.
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 100, maxTopicsGlobal: 4, maxTrackedSources: 10_000 }, clock.now);
    let allowed = 0;
    let globalCoalesced = 0;
    for (let i = 0; i < 50; i++) {
      const d = g.decide(`unique-source-${i}`, 'NORMAL'); // never repeats a key
      if (d.action === 'allow') allowed++;
      else { expect(d.bucket).toBe(GLOBAL_BUCKET); globalCoalesced++; }
    }
    expect(allowed).toBe(4);          // exactly the global ceiling of new topics
    expect(globalCoalesced).toBe(46); // everything else folds into ONE global bucket
  });

  it('a sustained flood stays a SINGLE episode (one bucket) while items keep arriving', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 3, ...HIGH_GLOBAL }, clock.now);
    for (let i = 0; i < 3; i++) expect(g.decide('flood', 'NORMAL').action).toBe('allow');
    let firstSeen = false;
    for (let i = 0; i < 20; i++) {
      clock.advance(60_000); // 1 min apart — window stays full
      const d = g.decide('flood', 'NORMAL');
      expect(d.action).toBe('coalesce');
      if (d.action === 'coalesce' && d.firstInEpisode) firstSeen = true;
    }
    expect(firstSeen).toBe(true);
    expect(g.episodeCount('flood')).toBe(20); // one running episode, not 20 topics
  });

  it('resets the episode after a full window of silence', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 1, ...HIGH_GLOBAL }, clock.now);
    expect(g.decide('s', 'NORMAL').action).toBe('allow');
    expect(g.decide('s', 'NORMAL').action).toBe('coalesce');
    expect(g.episodeCount('s')).toBe(1);
    clock.advance(11 * 60_000); // longer than the window
    expect(g.decide('s', 'NORMAL').action).toBe('allow'); // budget refilled
    expect(g.episodeCount('s')).toBe(0);
  });

  it('is a pass-through when disabled', () => {
    const g = new AttentionTopicGuard({ enabled: false, windowMs: 1, maxTopicsPerSource: 0, maxTopicsGlobal: 0, maxTrackedSources: 1 });
    for (let i = 0; i < 50; i++) expect(g.decide('x', 'NORMAL').action).toBe('allow');
  });

  it('treats missing/blank source as a single "unknown" bucket', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 10 * 60_000, maxTopicsPerSource: 1, ...HIGH_GLOBAL }, clock.now);
    expect(g.decide(undefined, 'NORMAL').action).toBe('allow');
    expect(g.decide('   ', 'NORMAL').action).toBe('coalesce');
  });

  it('coerces invalid config so a NaN/negative value cannot silently disable the guard', () => {
    const clock = makeClock();
    // NaN budget would make `>= NaN` always false → guard never trips. Coercion
    // must fall back to the safe default instead.
    const g = new AttentionTopicGuard({ enabled: true, windowMs: NaN as unknown as number, maxTopicsPerSource: NaN as unknown as number, maxTopicsGlobal: -5 as unknown as number, maxTrackedSources: 0 }, clock.now);
    expect(g.config.windowMs).toBe(DEFAULT_ATTENTION_TOPIC_GUARD.windowMs);
    expect(g.config.maxTopicsPerSource).toBe(DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsPerSource);
    expect(g.config.maxTopicsGlobal).toBeGreaterThanOrEqual(g.config.maxTopicsPerSource);
    // and it actually trips:
    for (let i = 0; i < DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsPerSource; i++) expect(g.decide('s', 'NORMAL').action).toBe('allow');
    expect(g.decide('s', 'NORMAL').action).toBe('coalesce');
  });

  it('bounds memory: distinct source keys are evicted once stale beyond the cap', () => {
    const clock = makeClock();
    const g = new AttentionTopicGuard({ enabled: true, windowMs: 60_000, maxTopicsPerSource: 1, maxTopicsGlobal: 1_000_000, maxTrackedSources: 50 }, clock.now);
    for (let i = 0; i < 200; i++) {
      g.decide(`s-${i}`, 'NORMAL');
      clock.advance(2_000); // 2s apart; after 60s, old keys age out of the window
    }
    expect(g.trackedSourceCount).toBeLessThanOrEqual(50);
  });

  it('ships enabled by default with a sane budget and a global ceiling', () => {
    expect(DEFAULT_ATTENTION_TOPIC_GUARD.enabled).toBe(true);
    expect(DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsPerSource).toBeGreaterThan(0);
    expect(DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsGlobal).toBeGreaterThanOrEqual(DEFAULT_ATTENTION_TOPIC_GUARD.maxTopicsPerSource);
    expect(DEFAULT_ATTENTION_TOPIC_GUARD.windowMs).toBeGreaterThan(0);
  });
});
