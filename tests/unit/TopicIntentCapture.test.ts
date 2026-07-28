/**
 * Unit tests for the topic-intent capture loop (rung 0) — Tier 1.
 *
 * Covers:
 *   - The pre-filter state-detector (isSubstantiveTurn) + its canary.
 *   - createQueuedIntelligence transport (routes through the queue's background
 *     lane, delegates to the injected provider — never a raw client).
 *   - captureTurn: substantive → ingest invoked + counters; trivial → skipped;
 *     shed; rate ceiling; degrade-never-throws.
 *   - createLlmExtractFn onDegrade observability hook.
 *   - Spec §7/§9 acceptance: agent-only refs never reach tentative; one
 *     contradiction demotes an authoritative ref below tier in one turn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  TopicIntentStore,
  buildEvent,
  projectConfidence,
} from '../../src/core/TopicIntent.js';
import {
  TopicIntentExtractor,
  createLlmExtractFn,
  type ExtractFn,
  type SignalProposal,
} from '../../src/core/TopicIntentExtractor.js';
import {
  isSubstantiveTurn,
  runPreFilterCanary,
  createQueuedIntelligence,
  captureTurn,
  createCaptureLoop,
  TOPIC_INTENT_CAPTURE_COST_CENTS,
  type CaptureLoopDeps,
} from '../../src/core/TopicIntentCapture.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

let tempDir: string;
let store: TopicIntentStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-capture-test-'));
  store = new TopicIntentStore(tempDir);
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntentCapture.test.ts' }); } catch { /* best */ }
});

/** An extractor whose extractFn returns a fixed proposal set (and counts calls). */
function makeExtractor(proposals: SignalProposal[] | (() => Promise<never>)): { extractor: TopicIntentExtractor; calls: () => number } {
  let calls = 0;
  const fn: ExtractFn = async () => {
    calls++;
    if (typeof proposals === 'function') return proposals();
    return proposals;
  };
  return { extractor: new TopicIntentExtractor(store, fn), calls: () => calls };
}

function baseDeps(extractor: TopicIntentExtractor, over: Partial<CaptureLoopDeps> = {}): CaptureLoopDeps {
  return { extractor, store, topicMemory: null, ...over };
}

describe('isSubstantiveTurn (pre-filter state-detector)', () => {
  it('skips empty / whitespace-only turns', () => {
    expect(isSubstantiveTurn('', true)).toBe(false);
    expect(isSubstantiveTurn('   ', true)).toBe(false);
    expect(isSubstantiveTurn(undefined, true)).toBe(false);
    expect(isSubstantiveTurn(null, true)).toBe(false);
  });

  it('skips whole-message bare acks (either side)', () => {
    for (const ack of ['ok', 'okay', 'yep', 'thanks!', 'thank you', 'ty', 'got it', '👍', 'sure', 'done']) {
      expect(isSubstantiveTurn(ack, true)).toBe(false);
    }
  });

  it('FAILS OPEN: an ack-prefixed substantive turn passes', () => {
    expect(isSubstantiveTurn('ok but actually I think we should switch to Path B', true)).toBe(true);
  });

  it('skips agent sentinel / heartbeat / proxy lines (agent turns only)', () => {
    expect(isSubstantiveTurn('🔭 echo is actively working on something. Your message has been delivered to the session.', false)).toBe(false);
    expect(isSubstantiveTurn('⏳ resumed 2 watchers on this topic.', false)).toBe(false);
  });

  it('does NOT treat a user message that resembles a sentinel phrase as a sentinel', () => {
    // Same text, but fromUser=true → not matched by the agent-only sentinel rule.
    expect(isSubstantiveTurn('your message has been delivered to the session, right?', true)).toBe(true);
  });

  it('passes genuine facts/decisions', () => {
    expect(isSubstantiveTurn("Let's use Postgres, not SQLite — we need concurrent writes.", true)).toBe(true);
  });
});

describe('pre-filter canary', () => {
  it('classifies every known sample correctly', () => {
    const result = runPreFilterCanary();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('createQueuedIntelligence (transport: queue + subscription provider)', () => {
  it('routes the call through the queue background lane and delegates to the injected provider', async () => {
    const seen: { lane?: string; cost?: number } = {};
    let delegated = false;
    const provider: IntelligenceProvider = {
      async evaluate() { delegated = true; return 'RESULT'; },
    };
    const enqueue = async (lane: 'interactive' | 'background', fn: (s: AbortSignal) => Promise<string>, cost?: number) => {
      seen.lane = lane; seen.cost = cost;
      return fn(new AbortController().signal);
    };
    const queued = createQueuedIntelligence(provider, enqueue);
    const out = await queued.evaluate('prompt');
    expect(out).toBe('RESULT');
    expect(delegated).toBe(true);            // delegates to the subscription provider, not a raw client
    expect(seen.lane).toBe('background');     // capture yields to interactive work
    expect(seen.cost).toBe(TOPIC_INTENT_CAPTURE_COST_CENTS);
  });

  it('propagates a queue cap-breach throw (so the extractor can degrade)', async () => {
    const provider: IntelligenceProvider = { async evaluate() { return 'x'; } };
    const enqueue = async () => { throw new Error('LLM daily spend cap exceeded'); };
    const queued = createQueuedIntelligence(provider, enqueue);
    await expect(queued.evaluate('p')).rejects.toThrow(/cap exceeded/);
  });
});

describe('createLlmExtractFn onDegrade observability', () => {
  const input = {
    topicId: 7, arcId: 'arc-7',
    message: { id: 'm1', text: 'hi', fromUser: true, turn: 1, at: '2026-01-01T00:00:00.000Z' },
    existingRefs: [],
  };

  it('fires no-intelligence when no provider is configured (and still returns [])', async () => {
    const seen: Array<[string, number]> = [];
    const out = await createLlmExtractFn(undefined, (r, t) => seen.push([r, t]))(input);
    expect(out).toEqual([]);
    expect(seen).toEqual([['no-intelligence', 7]]);
  });

  it('fires error when the provider throws (and still returns [])', async () => {
    const seen: Array<[string, number]> = [];
    const provider: IntelligenceProvider = { async evaluate() { throw new Error('boom'); } };
    const out = await createLlmExtractFn(provider, (r, t) => seen.push([r, t]))(input);
    expect(out).toEqual([]);
    expect(seen).toEqual([['error', 7]]);
  });
});

describe('captureTurn', () => {
  const TOPIC = 4242;

  function entry(over: Record<string, unknown> = {}) {
    return { messageId: 'srv-1', topicId: TOPIC, text: 'we will ship rung 0 first', fromUser: true, ...over };
  }

  it('no-topic → returns no-topic, no store write', async () => {
    const { extractor, calls } = makeExtractor([]);
    const out = await captureTurn(baseDeps(extractor), entry({ topicId: undefined }));
    expect(out.status).toBe('no-topic');
    expect(calls()).toBe(0);
  });

  it('trivial turn → skipped-prefilter, extractor never called, counter ticks', async () => {
    const { extractor, calls } = makeExtractor([]);
    const out = await captureTurn(baseDeps(extractor), entry({ text: 'ok' }));
    expect(out.status).toBe('skipped-prefilter');
    expect(calls()).toBe(0);
    expect(store.read(TOPIC).telemetry.capture!.prefilter_skipped).toBe(1);
    expect(store.read(TOPIC).telemetry.capture!.turns_seen).toBe(1);
  });

  it('substantive turn → ingest invoked, ref created, funnel counters move', async () => {
    const { extractor, calls } = makeExtractor([
      { kind: 'new-ref', refId: null, propositionText: 'ship rung 0 first', refKind: 'decision' },
    ]);
    const out = await captureTurn(baseDeps(extractor), entry());
    expect(out.status).toBe('captured');
    expect(calls()).toBe(1);
    expect(out.createdRefs).toBe(1);
    const cap = store.read(TOPIC).telemetry.capture!;
    expect(cap.extractions_attempted).toBe(1);
    expect(cap.extractions_emitted).toBe(1);
    expect(cap.refs_created).toBe(1);
    expect(cap.last_capture_at).toBeTruthy();
    // The ref is actually in the store (the cabinet filled).
    expect(store.getRefsAtOrAbove(TOPIC, 'observation').length).toBe(1);
  });

  it('load-shedding → skipped-shed, extractor not called', async () => {
    const { extractor, calls } = makeExtractor([]);
    const out = await captureTurn(baseDeps(extractor, { shouldShed: () => true }), entry());
    expect(out.status).toBe('skipped-shed');
    expect(calls()).toBe(0);
    expect(store.read(TOPIC).telemetry.capture!.degraded_shed).toBe(1);
  });

  it('per-topic rate ceiling → skipped-rate once the window is full', async () => {
    const { extractor } = makeExtractor([]);
    const deps = baseDeps(extractor, { rateCeiling: { maxPerWindow: 2, windowMs: 60_000 } });
    const loop = createCaptureLoop(deps); // owns the rate state across calls
    expect((await loop(entry({ messageId: 'a' }))).status).toBe('captured');
    expect((await loop(entry({ messageId: 'b' }))).status).toBe('captured');
    const third = await loop(entry({ messageId: 'c' }));
    expect(third.status).toBe('skipped-rate');
    expect(store.read(TOPIC).telemetry.capture!.rate_limited).toBe(1);
  });

  it('NEVER throws into the caller — a throwing extractor degrades to a counter tick', async () => {
    const { extractor } = makeExtractor(async () => { throw new Error('provider exploded'); });
    const out = await captureTurn(baseDeps(extractor), entry());
    expect(out.status).toBe('degraded');
    expect(store.read(TOPIC).telemetry.capture!.degraded_cap_or_error).toBe(1);
  });

  it('feeds the rolling summary into the extractor input (broader context)', async () => {
    let sawSummary: string | undefined;
    const fn: ExtractFn = async (input) => { sawSummary = input.rollingSummary; return []; };
    const extractor = new TopicIntentExtractor(store, fn);
    const deps = baseDeps(extractor, { topicMemory: { getTopicSummary: () => ({ summary: 'we are building the capture loop' }) } });
    await captureTurn(deps, entry());
    expect(sawSummary).toBe('we are building the capture loop');
  });
});

describe('spec acceptance §7/§9 (confidence boundaries)', () => {
  it('§7: agent-only evidence never reaches the tentative tier', () => {
    // Max agent-only accumulation: extract-agent (+0.10 cap) + many agent-reref (+0.05 cap) = 0.15.
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const events = [buildEvent('ref-a', 'extract-agent', 'm0', { at: new Date(T0).toISOString() })];
    for (let i = 0; i < 50; i++) {
      events.push(buildEvent('ref-a', 'agent-reref', `m${i}`, { at: new Date(T0 + i * 1000).toISOString() }));
    }
    const proj = projectConfidence(events, new Date(T0).toISOString(), T0 + 60_000);
    expect(proj.tier).toBe('observation');   // strictly below tentative (0.3)
    expect(proj.confidence).toBeLessThan(0.3);
  });

  it('§9: one recent contradiction demotes an authoritative ref below tier in one turn', () => {
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    // Build to authoritative with user-authored evidence: 0.40 + 0.30 + 0.10 = 0.80.
    const events = [
      buildEvent('ref-x', 'extract-user', 'm1', { at: new Date(T0).toISOString() }),
      buildEvent('ref-x', 'user-affirm', 'm2', { at: new Date(T0 + 1000).toISOString() }),
      buildEvent('ref-x', 'user-reref', 'm3', { at: new Date(T0 + 2000).toISOString() }),
    ];
    const before = projectConfidence(events, new Date(T0 + 2000).toISOString(), T0 + 3000);
    expect(before.tier).toBe('authoritative');
    // One new contradiction (-0.60) on a distinct message → 0.80 - 0.60 = 0.20 → observation.
    events.push(buildEvent('ref-x', 'contradiction', 'm4', { at: new Date(T0 + 3000).toISOString() }));
    const after = projectConfidence(events, new Date(T0 + 2000).toISOString(), T0 + 3000);
    expect(after.tier).not.toBe('authoritative');
    expect(after.confidence).toBeLessThan(0.3);
  });
});
