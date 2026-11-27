import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bindJudgeSlots } from './source_grounded_judge_slots.mjs';
import { selectJudgeAttempt } from './source_grounded_judge_retry.mjs';
import { summarizeJudgeConsensus } from './source_grounded_consensus.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const capture = { submissionId: 'shared', answerRaw: 'captured answer' };
const criteria = [{ id: 'critical', critical: true }];
const inputs = ['fail', 'pass'].map((verdict, index) => ({
  trialId: 'trial', arm: 'full', repeat: 0, slotId: `slot-${index}`, attemptId: `attempt-${index}`, family: `family-${index}`,
  raw: JSON.stringify({ submissionId: 'shared', criteria: [{ criterionId: 'critical', verdict }] }),
}));
const receipts = inputs.map(({ raw, ...ids }) => ({
  ...ids, rawHash: sha(raw), answerHash: sha(capture.answerRaw),
}));
const validate = ({ judgeRaw }) => ({
  answer: { state: 'structurally-valid' },
  judge: { state: 'structurally-valid', rawHash: sha(judgeRaw) },
});

test('binds by scheduled slot and attempt independent of input order', () => {
  const old = { ...inputs[0], attemptId: 'earlier-attempt' };
  const slots = bindJudgeSlots(capture, receipts, [inputs[1], old, inputs[0]], validate);
  assert.deepEqual(slots.map(slot => slot.state), ['bound', 'bound']);
  const result = summarizeJudgeConsensus(criteria, slots.map(slot => slot.findings));
  assert.deepEqual(result.criticalFailures, [{ criterionId: 'critical', slot: 0 }]);
});

test('rejects swapped otherwise valid outputs without calling validation', () => {
  const swapped = inputs.map((input, index) => ({ ...input, raw: inputs[1 - index].raw }));
  const slots = bindJudgeSlots(capture, receipts, swapped, () => assert.fail('unbound input'));
  assert.deepEqual(slots.map(slot => slot.state), ['binding-mismatch', 'binding-mismatch']);
});

test('keeps missing, duplicate and structurally invalid outputs distinct', () => {
  const slots = bindJudgeSlots(capture, receipts, [inputs[0], inputs[0]], validate);
  assert.deepEqual(slots.map(slot => slot.state), ['ambiguous', 'output-missing']);
  const rejected = bindJudgeSlots(capture, receipts, inputs, () => ({
    answer: { state: 'structurally-valid' }, judge: { state: 'judge-error' },
  }));
  assert.deepEqual(rejected.map(slot => slot.state), ['invalid', 'invalid']);
});

test('a selected timeout retry enters the original slot exactly once', () => {
  const timedOut = { ordinal: 0, attemptId: 'earlier-attempt', state: 'timeout' };
  const successful = { ...receipts[0], ordinal: 1, state: 'valid' };
  const { selected } = selectJudgeAttempt([successful, timedOut], 1);
  const slots = bindJudgeSlots(capture, [selected, receipts[1]], [
    { ...inputs[0], attemptId: timedOut.attemptId, raw: inputs[1].raw },
    ...inputs,
  ], validate);
  assert.deepEqual(slots.map(slot => slot.state), ['bound', 'bound']);
  const result = summarizeJudgeConsensus(criteria, slots.map(slot => slot.findings));
  assert.deepEqual(result.criteria, [{ criterionId: 'critical', verdict: 'disputed' }]);
  assert.deepEqual(result.criticalFailures, [{ criterionId: 'critical', slot: 0 }]);
});

test('rejects exact output bytes recorded for a different arm or repeat', () => {
  for (const change of [{ arm: 'reduced' }, { repeat: 1 }]) {
    const slots = bindJudgeSlots(capture, receipts, [{ ...inputs[0], ...change }, inputs[1]], validate);
    assert.deepEqual(slots.map(slot => slot.state), ['binding-mismatch', 'bound']);
    assert.throws(() => bindJudgeSlots(capture, [{ ...receipts[0], ...change }, receipts[1]], inputs, validate),
      TypeError);
  }
});
