import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyScheduledJudges, verifyTrialInputs } from './source_grounded_trial_inputs.mjs';
import { selectJudgeAttempt } from './source_grounded_judge_retry.mjs';
import { bindJudgeSlots } from './source_grounded_judge_slots.mjs';
import { assessJudgeIndependence } from './source_grounded_judge_independence.mjs';
import { summarizeJudgeConsensus } from './source_grounded_consensus.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const criteria = [{ id: 'critical', critical: true, absence: false }];
const capture = {
  caseId: 'case', submissionId: 'submission', criteria,
  answerRaw: 'synthetic answer', sources: [{ id: 'source', text: 'evidence' }],
  availableSourceIds: ['source'],
};
const rubricBytes = Buffer.from('synthetic rubric');
const expected = { trialId: 'trial', arm: 'reduced', repeat: 2 };
const planBytes = Buffer.from(JSON.stringify({
  ...expected, judgeSlots: [{ id: 'slot-0', family: 'family-0' }, { id: 'slot-1', family: 'family-1' }],
  caseId: capture.caseId, submissionId: capture.submissionId, criteria,
  sources: [{ id: 'source', hash: sha('evidence') }],
  availableSourceIds: capture.availableSourceIds, rubricHash: sha(rubricBytes),
}));
const observations = ['fail', 'pass'].map((verdict, index) => ({
  trialId: 'trial', slotId: 'slot-' + index, attemptId: 'attempt-' + index,
  family: 'family-' + index,
  raw: JSON.stringify({ submissionId: capture.submissionId, criteria: [{ criterionId: 'critical', verdict }] }),
}));
const receipts = observations.map(({ raw, ...identity }, index) => ({
  ...expected, ...identity, ordinal: index === 0 ? 1 : 0, state: 'valid',
  completedOrdinal: index + 2, rawHash: sha(raw), answerHash: sha(capture.answerRaw),
}));
const validate = ({ judgeRaw }) => ({
  answer: { state: 'structurally-valid' },
  judge: { state: 'structurally-valid', rawHash: sha(judgeRaw) },
});

test('composes frozen inputs, a retry, selected bytes, and blind review evidence', () => {
  assert.equal(verifyTrialInputs({
    planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes, capture,
  }), 'bound');
  const selected = [
    selectJudgeAttempt([{ ordinal: 0, attemptId: 'timeout', state: 'timeout' }, receipts[0]], 1).selected,
    selectJudgeAttempt([receipts[1]], 1).selected,
  ];
  assert.equal(verifyScheduledJudges(JSON.parse(planBytes), expected, selected), 'bound');
  const bound = bindJudgeSlots(capture, selected, [...observations].reverse(), validate);
  assert.deepEqual(bound.map(slot => slot.state), ['bound', 'bound']);
  const consensus = summarizeJudgeConsensus(criteria, bound.map(slot => slot.findings));
  assert.deepEqual(consensus.criteria, [{ criterionId: 'critical', verdict: 'disputed' }]);
  assert.deepEqual(consensus.criticalFailures, [{ criterionId: 'critical', slot: 0 }]);
  assert.equal(assessJudgeIndependence(selected.map(receipt => receipt.slotId), selected, 4), 'supported');
  assert.equal(assessJudgeIndependence(selected.map(receipt => receipt.slotId), selected, 1), 'breach');
});

test('a wrong-slot output stays missing from consensus while the intact critical signal survives', () => {
  const wrong = { ...observations[1], raw: observations[0].raw };
  const bound = bindJudgeSlots(capture, receipts, [observations[0], wrong], validate);
  assert.deepEqual(bound.map(slot => slot.state), ['bound', 'binding-mismatch']);
  const consensus = summarizeJudgeConsensus(criteria, bound.map(slot => slot.findings));
  assert.equal(consensus.structurallyComplete, false);
  assert.deepEqual(consensus.criticalFailures, [{ criterionId: 'critical', slot: 0 }]);
});

test('rejects a coherent pair from another comparison arm or repeat', () => {
  const plan = JSON.parse(planBytes);
  for (const changed of [{ arm: 'full' }, { repeat: 3 }]) {
    const wrong = receipts.map(receipt => ({ ...receipt, ...changed }));
    assert.equal(verifyScheduledJudges(plan, expected, wrong), 'schedule-mismatch');
    assert.equal(verifyScheduledJudges(plan, { ...expected, ...changed }, wrong), 'trial-mismatch');
  }
});

test('rejects an unscheduled slot or changed scheduled family', () => {
  const plan = JSON.parse(planBytes);
  for (const changed of [{ slotId: 'wrong-slot' }, { family: 'wrong-family' }]) {
    assert.equal(verifyScheduledJudges(plan, expected, [{ ...receipts[0], ...changed }, receipts[1]]),
      'schedule-mismatch');
  }
});
