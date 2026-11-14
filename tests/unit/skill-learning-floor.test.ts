/**
 * Floor — Tier 1 (Testing Integrity Standard).
 * Spec: docs/specs/skill-learning-sentinel.md §3.3 (the deterministic floor: count-based, no time bound,
 * never widened by a model) and §3.6 (one `accepted` or two `accepted-inferred` = one clean run).
 */
import { describe, it, expect } from 'vitest';
import { evaluateFloor } from '../../src/monitoring/skillLearning/Floor.js';
import type { Identity, OutcomeLabel, OutcomeRow, RequestRow } from '../../src/monitoring/skillLearning/types.js';

const FLOOR = { minOccurrences: 2, minCorroboratedCleanRuns: 1 };

function req(i: number, at: string, identity: Identity = 'verified', runId = `run-${i}`): RequestRow {
  return {
    kind: 'request', eventId: `e${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(1000 + i) },
    topicId: '42', sessionName: `s${i}`, at, channel: 'telegram', identity, state: 'classified', procedureKey: 'ci-health',
    paraphrase: 'weekly CI health', repeatable: true, runId, machineId: 'm1',
  };
}

function out(runId: string, label: OutcomeLabel, extra: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    kind: 'outcome', eventId: `o-${runId}`, runId, revision: 1, procedureKey: 'ci-health', topicId: '42', label,
    provisional: false, windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-01T01:00:00Z', at: '2026-01-01T01:00:00Z', machineId: 'm1', ...extra,
  };
}

const notLearned = () => false;

describe('skill-learning floor (§3.3)', () => {
  it('a quarterly recurrence passes: two verified occurrences 90 days apart with one accepted run, no time bound', () => {
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-04-06T10:00:00Z')],
      outcomes: [out('run-1', 'accepted'), out('run-2', 'unknown')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(true);
    expect(r.counts).toMatchObject({ occurrences: 2, verifiedOccurrences: 2, cleanRuns: 1, acceptedRuns: 1 });
    expect(r.cleanRunIds).toEqual(['run-1']);
  });

  it('one occurrence is not a recurrence (below-min-occurrences)', () => {
    const r = evaluateFloor({ requests: [req(1, '2026-01-05T10:00:00Z')], outcomes: [out('run-1', 'accepted')], floor: FLOOR, isLearnedSkill: notLearned });
    expect(r.passes).toBe(false);
    expect(r.failure).toBe('below-min-occurrences');
  });

  it('asserted-identity rows never count toward the floor (support only)', () => {
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z', 'asserted'), req(2, '2026-02-05T10:00:00Z', 'asserted'), req(3, '2026-03-05T10:00:00Z', 'verified')],
      outcomes: [out('run-1', 'accepted'), out('run-2', 'accepted')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(false);
    expect(r.failure).toBe('below-min-occurrences');
    expect(r.counts.occurrences).toBe(3);
    expect(r.counts.verifiedOccurrences).toBe(1);
  });

  it('a clean run from an asserted row is not corroborated; an unverified-catchup run neither', () => {
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z', 'asserted'), req(2, '2026-02-05T10:00:00Z'), req(3, '2026-03-05T10:00:00Z', 'unverified-catchup'), req(4, '2026-04-05T10:00:00Z')],
      outcomes: [out('run-1', 'accepted'), out('run-3', 'accepted'), out('run-2', 'unknown'), out('run-4', 'unknown')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    // Two verified occurrences (run-2, run-4) meet condition 1, but both are `unknown`; the accepted runs
    // belong to the asserted and catch-up rows → no corroborated clean run.
    expect(r.passes).toBe(false);
    expect(r.failure).toBe('below-min-clean-runs');
  });

  it('`unknown` and `weak-positive` never make a clean run (provisional or not)', () => {
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z'), req(3, '2026-03-05T10:00:00Z')],
      outcomes: [out('run-1', 'unknown'), out('run-2', 'weak-positive', { provisional: true }), out('run-3', 'unknown', { provisional: true })],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(false);
    expect(r.failure).toBe('below-min-clean-runs');
    expect(r.counts.cleanRuns).toBe(0);
  });

  it('three accepted runs from TODAY (still provisional) pass the floor — no hidden windowDays delay', () => {
    const today = new Date().toISOString();
    const r = evaluateFloor({
      requests: [req(1, today), req(2, today), req(3, today)],
      outcomes: [out('run-1', 'accepted', { provisional: true }), out('run-2', 'accepted', { provisional: true }), out('run-3', 'accepted-inferred', { provisional: true })],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(true);
    expect(r.counts).toMatchObject({ acceptedRuns: 2, acceptedInferredRuns: 1, cleanRuns: 2 });
    // A later flip to `corrected` removes the run from the clean set by itself.
    const flipped = evaluateFloor({
      requests: [req(1, today), req(2, today)],
      outcomes: [out('run-1', 'corrected'), out('run-2', 'unknown', { provisional: true })],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(flipped.passes).toBe(false);
    expect(flipped.failure).toBe('below-min-clean-runs');
  });

  it('two accepted-inferred runs equal one clean run; one does not', () => {
    const one = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z')],
      outcomes: [out('run-1', 'accepted-inferred')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(one.passes).toBe(false);
    expect(one.failure).toBe('below-min-clean-runs');
    const two = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z')],
      outcomes: [out('run-1', 'accepted-inferred'), out('run-2', 'accepted-inferred')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(two.passes).toBe(true);
    expect(two.counts).toMatchObject({ acceptedInferredRuns: 2, cleanRuns: 1 });
  });

  it('covered-by-handwritten: skillUsed on >= 2 occurrences by a hand-written skill records, no action', () => {
    const used = { skill: 'ci-report', contentHash: 'h', corroborated: true, versionUncertain: false };
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z'), req(3, '2026-03-05T10:00:00Z')],
      outcomes: [out('run-1', 'accepted', { skillUsed: used }), out('run-2', 'accepted', { skillUsed: used }), out('run-3', 'accepted')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(false);
    expect(r.failure).toBe('covered-by-handwritten');
    expect(r.coveredBy).toEqual({ skill: 'ci-report', learned: false, occurrences: 2 });
  });

  it('covered-by-learned: the same coverage by a learned skill is the improve path', () => {
    const used = { skill: 'ci-health-report', contentHash: 'h', corroborated: true, versionUncertain: false };
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z')],
      outcomes: [out('run-1', 'accepted', { skillUsed: used }), out('run-2', 'accepted-inferred', { skillUsed: used })],
      floor: FLOOR, isLearnedSkill: (n) => n === 'ci-health-report',
    });
    expect(r.failure).toBe('covered-by-learned');
    expect(r.coveredBy?.learned).toBe(true);
  });

  it('a single skill use is not coverage (one use can be a misfire)', () => {
    const used = { skill: 'ci-report', contentHash: 'h', corroborated: true, versionUncertain: false };
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z')],
      outcomes: [out('run-1', 'accepted', { skillUsed: used }), out('run-2', 'accepted')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(true);
  });

  it('corrected runs are reported for the drafter but never count as clean', () => {
    const r = evaluateFloor({
      requests: [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z'), req(3, '2026-03-05T10:00:00Z')],
      outcomes: [out('run-1', 'corrected'), out('run-2', 'redo'), out('run-3', 'accepted')],
      floor: FLOOR, isLearnedSkill: notLearned,
    });
    expect(r.passes).toBe(true);
    expect(r.counts.correctedRuns).toBe(2);
    expect(r.correctedRunIds.sort()).toEqual(['run-1', 'run-2']);
    expect(r.cleanRunIds).toEqual(['run-3']);
  });

  it('the floor is deterministic: the same rows in any order yield the same verdict', () => {
    const requests = [req(1, '2026-01-05T10:00:00Z'), req(2, '2026-02-05T10:00:00Z'), req(3, '2026-03-05T10:00:00Z')];
    const outcomes = [out('run-1', 'accepted'), out('run-2', 'unknown'), out('run-3', 'corrected')];
    const a = evaluateFloor({ requests, outcomes, floor: FLOOR, isLearnedSkill: notLearned });
    const b = evaluateFloor({ requests: [...requests].reverse(), outcomes: [...outcomes].reverse(), floor: FLOOR, isLearnedSkill: notLearned });
    expect(b.passes).toBe(a.passes);
    expect(b.counts).toEqual(a.counts);
  });
});
