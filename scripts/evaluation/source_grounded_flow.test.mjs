import { evaluateJudgeFlow } from './source_grounded_judge_flow.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { resolveTrialJudgeSchedule, verifyTrialJudgeSchedule } from './source_grounded_trial_inputs.mjs';
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
  ...expected, judgeSlots: [{ id: 'slot-0', family: 'family-0', maxRetries: 1 }, { id: 'slot-1', family: 'family-1', maxRetries: 0 }],
  caseId: capture.caseId, submissionId: capture.submissionId, criteria,
  sources: [{ id: 'source', hash: sha('evidence') }],
  availableSourceIds: capture.availableSourceIds, rubricHash: sha(rubricBytes),
}));
const observations = ['fail', 'pass'].map((verdict, index) => ({
  ...expected, slotId: 'slot-' + index, attemptId: 'attempt-' + index,
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
  const selected = [
    selectJudgeAttempt([{ ordinal: 0, attemptId: 'timeout', state: 'timeout' }, receipts[0]], 1).selected,
    selectJudgeAttempt([receipts[1]], 1).selected,
  ];
  assert.equal(verifyTrialJudgeSchedule({ planBytes, planHash: sha(planBytes), parsePlan: JSON.parse,
    rubricBytes, capture }, expected, selected), 'bound');
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
  const input = { planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes, capture };
  for (const changed of [{ arm: 'full' }, { repeat: 3 }]) {
    const wrong = receipts.map(receipt => ({ ...receipt, ...changed }));
    assert.equal(verifyTrialJudgeSchedule(input, expected, wrong), 'schedule-mismatch');
    assert.equal(verifyTrialJudgeSchedule(input, { ...expected, ...changed }, wrong), 'trial-mismatch');
  }
});

test('rejects an unscheduled slot or changed scheduled family', () => {
  const input = { planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes, capture };
  for (const changed of [{ slotId: 'wrong-slot' }, { family: 'wrong-family' }]) {
    assert.equal(verifyTrialJudgeSchedule(input, expected, [{ ...receipts[0], ...changed }, receipts[1]]),
      'schedule-mismatch');
  }
});

test('schedule verification uses only the plan whose exact bytes were verified', () => {
  const changed = JSON.parse(planBytes);
  changed.judgeSlots[0].family = 'substituted-family';
  const modified = Buffer.from(JSON.stringify(changed));
  assert.equal(verifyTrialJudgeSchedule({
    planBytes: modified, planHash: sha(planBytes), rubricBytes, capture,
    parsePlan: () => assert.fail('modified plan reached the parser'),
  }, expected, [{ ...receipts[0], family: 'substituted-family' }, receipts[1]]), 'plan-mismatch');
});

test('a missing selected receipt preserves its scheduled slot and the surviving critical finding', () => {
  const input = { planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes, capture };
  const schedule = resolveTrialJudgeSchedule(input, expected, [receipts[0]]);
  assert.deepEqual(schedule, { state: 'bound', slots: [receipts[0], null] });
  const slots = bindJudgeSlots(capture, schedule.slots, observations, validate);
  assert.deepEqual(slots.map(slot => slot.state), ['bound', 'slot-empty']);
  const result = summarizeJudgeConsensus(criteria, slots.map(slot => slot.findings));
  assert.equal(result.structurallyComplete, false);
  assert.deepEqual(result.criticalFailures, [{ criterionId: 'critical', slot: 0 }]);
  assert.deepEqual(resolveTrialJudgeSchedule(input, expected, []), { state: 'bound', slots: [null, null] });
});

test('composed flow uses the selected retry for binding and independence evidence', () => {
  const input = { planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes, capture };
  const timeout = { ...receipts[0], ordinal: 0, attemptId: 'timeout', state: 'timeout' };
  const ledgers = [
    { slotId: receipts[0].slotId, maxRetries: 1, attempts: [timeout, receipts[0]] },
    { slotId: receipts[1].slotId, maxRetries: 1, attempts: [receipts[1]] },
  ];
  const disclosure = { ...expected, ordinal: 4 };
  const noRetryPlan = JSON.parse(planBytes);
  noRetryPlan.judgeSlots[0].maxRetries = 0;
  const lockedBytes = Buffer.from(JSON.stringify(noRetryPlan));
  const blocked = evaluateJudgeFlow({ ...input, planBytes: lockedBytes, planHash: sha(lockedBytes) },
    expected, ledgers, observations, disclosure, validate);
  assert.equal(blocked.selection[0].state, 'policy-violation');
  assert.deepEqual(blocked.bindingStates, ['slot-empty', 'bound']);
  const aged = { ...observations[0], attemptId: timeout.attemptId };
  const good = evaluateJudgeFlow(input, expected, ledgers, [aged, ...observations], disclosure, validate);
  assert.deepEqual(good.bindingStates, ['bound', 'bound']);
  assert.equal(good.independence, 'supported');
  const missing = evaluateJudgeFlow(input, expected, ledgers, [aged, observations[1]], disclosure, validate);
  assert.deepEqual(missing.bindingStates, ['output-missing', 'bound']);
  assert.equal(missing.independence, 'unknown');
  assert.equal(evaluateJudgeFlow(input, expected, ledgers, observations,
    { ...disclosure, repeat: 999 }, validate).independence, 'unknown');
  const mixed = [{ ...ledgers[0], attempts: [{ ...timeout, trialId: 'wrong' }, receipts[0]] }, ledgers[1]];
  assert.equal(evaluateJudgeFlow(input, expected, mixed, observations, disclosure, validate).state,
    'ledger-identity-mismatch');
});
