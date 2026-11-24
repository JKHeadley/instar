import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeJudgeConsensus } from './source_grounded_consensus.mjs';
import { assessJudgeIndependence as assess } from './source_grounded_judge_independence.mjs';

const slots = ['a', 'b'];
const a = { slotId: 'a', attemptId: 'a1', trialId: 'trial', family: 'first', completedOrdinal: 1 };
const b = { slotId: 'b', attemptId: 'b1', trialId: 'trial', family: 'second', completedOrdinal: 3 };

test('supports distinct families recorded as complete before disclosure', () => {
  assert.equal(assess(slots, [b, a], 4), 'supported');
});

test('detects shared family or disclosure before both completed', () => {
  assert.equal(assess(slots, [a, { ...b, family: a.family }], 4), 'breach');
  assert.equal(assess(slots, [a, b], 2), 'breach');
});

test('missing or ambiguous host evidence remains unknown', () => {
  for (const [receipts, disclosure] of [
    [[a], 4], [[a, a], 4], [[a, b], null], [[a, b], 3],
    [[a, { ...b, trialId: 'other' }], 4],
  ]) assert.equal(assess(slots, receipts, disclosure), 'unknown');
});

test('an independence breach stays separate from structural agreement and critical signals', () => {
  const finding = [{ criterionId: 'c', verdict: 'fail' }];
  const consensus = summarizeJudgeConsensus([{ id: 'c', critical: true }], [finding, finding]);
  assert.equal(assess(slots, [a, b], 2), 'breach');
  assert.equal(consensus.structurallyComplete, true);
  assert.equal(consensus.criteria[0].verdict, 'fail');
  assert.deepEqual(consensus.criticalFailures.map(signal => signal.slot), [0, 1]);
});
