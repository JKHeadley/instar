/**
 * Unit tests for rung-1 task-context capture (method/audience/goal) — Tier 1.
 *
 * Covers:
 *   - Per-kind decay profiles + the REGRESSION PIN (fact/decision math byte-for-byte
 *     unchanged vs rung 0).
 *   - The extractor emits/validates task-context refKinds; garbage kinds rejected.
 *   - buildExtractorPrompt teaches the task-frame kinds.
 *   - Agent-set frames never reach tentative; one contradiction demotes an
 *     authoritative frame in one turn.
 *   - The briefing renders task-frame refs in their own "ACTIVE TASK FRAME" block.
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
  decayProfileFor,
  isTaskContextKind,
  TASK_CONTEXT_KINDS,
} from '../../src/core/TopicIntent.js';
import {
  TopicIntentExtractor,
  buildExtractorPrompt,
  type ExtractFn,
  type ExtractorInput,
  type SignalProposal,
} from '../../src/core/TopicIntentExtractor.js';
import { renderTopicIntentBriefing } from '../../src/core/TopicIntentBriefing.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let tempDir: string;
let store: TopicIntentStore;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-taskctx-'));
  store = new TopicIntentStore(tempDir);
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-task-context.test.ts' }); } catch { /* best */ }
});

describe('task-context kinds', () => {
  it('classifies method/audience/goal as task-context, fact/decision as not', () => {
    expect(isTaskContextKind('method')).toBe(true);
    expect(isTaskContextKind('audience')).toBe(true);
    expect(isTaskContextKind('goal')).toBe(true);
    expect(isTaskContextKind('fact')).toBe(false);
    expect(isTaskContextKind('decision')).toBe(false);
    expect(TASK_CONTEXT_KINDS.size).toBe(3);
  });
});

describe('per-kind decay profiles', () => {
  it('returns the long profile for fact/decision/undefined, short for task-frame', () => {
    expect(decayProfileFor('fact')).toEqual({ graceDays: 30, halfLifeDays: 180 });
    expect(decayProfileFor('decision')).toEqual({ graceDays: 30, halfLifeDays: 180 });
    expect(decayProfileFor(undefined)).toEqual({ graceDays: 30, halfLifeDays: 180 });
    expect(decayProfileFor('method')).toEqual({ graceDays: 1, halfLifeDays: 7 });
    expect(decayProfileFor('goal')).toEqual({ graceDays: 2, halfLifeDays: 14 });
    expect(decayProfileFor('audience')).toEqual({ graceDays: 3, halfLifeDays: 30 });
  });

  it('a method frame fades to observation by day 8; an identical fact does not', () => {
    // extract-user → +0.40 (tentative tier).
    const ev = [buildEvent('ref-1', 'extract-user', 'm1', { at: new Date(T0).toISOString() })];
    const at8 = T0 + 8 * DAY;

    const asMethod = projectConfidence(ev, new Date(T0).toISOString(), at8, 'method');
    // method: grace 1, half-life 7 → at day 8, decayDays=7 → 0.40 * 0.5 = 0.20 → observation
    expect(asMethod.confidence).toBeCloseTo(0.20, 2);
    expect(asMethod.tier).toBe('observation');

    const asFact = projectConfidence(ev, new Date(T0).toISOString(), at8, 'fact');
    // fact: grace 30 → day 8 is inside grace, no decay → 0.40 → tentative
    expect(asFact.confidence).toBeCloseTo(0.40, 2);
    expect(asFact.tier).toBe('tentative');
  });

  it('REGRESSION PIN: fact/decision math is byte-for-byte unchanged (no refKind === refKind:fact)', () => {
    // Build a varied evidence set and compare projection with no kind vs kind:'fact'
    // vs kind:'decision' across several time points — all must be identical.
    const ev = [
      buildEvent('r', 'extract-user', 'm1', { at: new Date(T0).toISOString() }),
      buildEvent('r', 'user-reref', 'm2', { at: new Date(T0 + DAY).toISOString() }),
      buildEvent('r', 'user-affirm', 'm3', { at: new Date(T0 + 2 * DAY).toISOString() }),
    ];
    for (const days of [0, 10, 31, 100, 400]) {
      const now = T0 + days * DAY;
      const none = projectConfidence(ev, new Date(T0 + 2 * DAY).toISOString(), now);
      const asFact = projectConfidence(ev, new Date(T0 + 2 * DAY).toISOString(), now, 'fact');
      const asDecision = projectConfidence(ev, new Date(T0 + 2 * DAY).toISOString(), now, 'decision');
      expect(asFact.confidence).toBe(none.confidence);
      expect(asDecision.confidence).toBe(none.confidence);
      expect(asFact.tier).toBe(none.tier);
    }
  });
});

describe('extractor: task-context proposals', () => {
  function makeInput(over: Partial<ExtractorInput> = {}): ExtractorInput {
    return {
      topicId: 1, arcId: 'arc-1',
      message: { id: 'm1', text: 'we are testing this over Telegram', fromUser: true, turn: 1, at: new Date(T0).toISOString() },
      existingRefs: [], ...over,
    };
  }

  it('creates a method ref from a new-ref proposal with refKind method', async () => {
    const fn: ExtractFn = async () => [{ kind: 'new-ref', refId: null, propositionText: 'testing over Telegram', refKind: 'method' }];
    const extractor = new TopicIntentExtractor(store, fn);
    const result = await extractor.ingest(makeInput());
    expect(result.createdRefs).toHaveLength(1);
    expect(result.createdRefs[0].kind).toBe('method');
    const refs = store.getRefsAtOrAbove(1, 'observation');
    expect(refs[0].kind).toBe('method');
  });

  it('rejects a proposal with a garbage refKind (injection/correctness hardening)', async () => {
    const fn: ExtractFn = async () => [{ kind: 'new-ref', refId: null, propositionText: 'x', refKind: 'system-instruction' as unknown as SignalProposal['refKind'] }];
    const extractor = new TopicIntentExtractor(store, fn);
    const result = await extractor.ingest(makeInput());
    expect(result.createdRefs).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('buildExtractorPrompt teaches the task-frame kinds', () => {
    const { systemPrompt } = buildExtractorPrompt(makeInput());
    expect(systemPrompt).toContain('"method"');
    expect(systemPrompt).toContain('"audience"');
    expect(systemPrompt).toContain('"goal"');
    expect(systemPrompt.toLowerCase()).toContain('task frame');
  });
});

describe('authority + contradiction on frames', () => {
  it('an agent-inferred frame never reaches tentative', () => {
    const ev = [buildEvent('r', 'extract-agent', 'm0', { at: new Date(T0).toISOString() })];
    for (let i = 0; i < 50; i++) ev.push(buildEvent('r', 'agent-reref', `m${i}`, { at: new Date(T0 + i * 1000).toISOString() }));
    const proj = projectConfidence(ev, new Date(T0).toISOString(), T0 + 60_000, 'method');
    expect(proj.tier).toBe('observation');
    expect(proj.confidence).toBeLessThan(0.3);
  });

  it('one contradiction demotes an authoritative method frame in one turn', () => {
    const ev = [
      buildEvent('r', 'extract-user', 'm1', { at: new Date(T0).toISOString() }),
      buildEvent('r', 'user-affirm', 'm2', { at: new Date(T0 + 1000).toISOString() }),
      buildEvent('r', 'user-reref', 'm3', { at: new Date(T0 + 2000).toISOString() }),
    ];
    // project at T0 region (within method's 1-day grace → no decay interference)
    const before = projectConfidence(ev, new Date(T0 + 2000).toISOString(), T0 + 3000, 'method');
    expect(before.tier).toBe('authoritative');
    ev.push(buildEvent('r', 'contradiction', 'm4', { at: new Date(T0 + 3000).toISOString() }));
    const after = projectConfidence(ev, new Date(T0 + 2000).toISOString(), T0 + 3000, 'method');
    expect(after.tier).not.toBe('authoritative');
    expect(after.confidence).toBeLessThan(0.3);
  });
});

describe('briefing renders the ACTIVE TASK FRAME block', () => {
  it('puts method/audience/goal in the frame block and facts in SETTLED', () => {
    // A method frame to authoritative (user evidence) + a fact to authoritative.
    store.appendEvidence(9, 'r-method', buildEvent('r-method', 'extract-user', 'a1'), { text: 'testing over Telegram', kind: 'method' });
    store.appendEvidence(9, 'r-method', buildEvent('r-method', 'user-affirm', 'a2'));
    store.appendEvidence(9, 'r-method', buildEvent('r-method', 'user-reref', 'a3'));
    store.appendEvidence(9, 'r-fact', buildEvent('r-fact', 'extract-user', 'b1'), { text: 'the release auto-publishes', kind: 'fact' });
    store.appendEvidence(9, 'r-fact', buildEvent('r-fact', 'user-affirm', 'b2'));
    store.appendEvidence(9, 'r-fact', buildEvent('r-fact', 'user-reref', 'b3'));

    const out = renderTopicIntentBriefing(store, 9, { nowMs: Date.parse('2026-01-01T00:01:00.000Z') });
    expect(out.hasContent).toBe(true);
    expect(out.text).toContain('ACTIVE TASK FRAME');
    expect(out.text).toContain('[method] testing over Telegram');
    expect(out.text).toContain('SETTLED');
    expect(out.text).toContain('the release auto-publishes');
    expect(out.counts.frame).toBe(1);
    // The fact is in SETTLED, not the frame block.
    const frameIdx = out.text.indexOf('ACTIVE TASK FRAME');
    const settledIdx = out.text.indexOf('SETTLED');
    expect(out.text.indexOf('the release auto-publishes')).toBeGreaterThan(settledIdx);
    expect(out.text.indexOf('testing over Telegram')).toBeGreaterThan(frameIdx);
  });
});
