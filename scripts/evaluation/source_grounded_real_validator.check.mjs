import { evaluateJudgeFlow } from './source_grounded_judge_flow.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessJudgeIndependence } from './source_grounded_judge_independence.mjs';
import { selectJudgeAttempt } from './source_grounded_judge_retry.mjs';
import { bindJudgeSlots } from './source_grounded_judge_slots.mjs';
import { summarizeJudgeConsensus } from './source_grounded_consensus.mjs';
import { resolveTrialJudgeSchedule, verifyTrialJudgeSchedule, verifyTrialInputs } from './source_grounded_trial_inputs.mjs';

const [validatorRoot] = process.argv.slice(2);
assert(validatorRoot, 'Pass the local validator worktree path');
const load = relative => import(pathToFileURL(resolve(validatorRoot, relative)).href);
const [{ validateCapture }, { capture }] = await Promise.all([
  load('scripts/evaluation/source_grounded_validate.mjs'),
  load('tests/fixtures/source-grounded-capture.ts'),
]);

const sha = data => createHash('sha256').update(data).digest('hex');
const input = capture();
const identity = { trialId: 'synthetic', arm: 'full', repeat: 0 };
const rubricBytes = Buffer.from('Synthetic fixture rubric');
const observations = ['fail', 'pass'].map((verdict, index) => {
  const judge = JSON.parse(input.judgeRaw);
  judge.criteria[0].verdict = verdict;
  return {
    ...identity, slotId: 'slot-' + index, family: 'family-' + index,
    attemptId: 'attempt-' + index, raw: JSON.stringify(judge),
  };
});
const terminal = observations.map(({ raw, ...record }, index) => ({
  ...record, rawHash: sha(raw), answerHash: sha(input.answerRaw),
  state: 'valid', ordinal: index === 0 ? 1 : 0, completedOrdinal: index + 2,
}));
const receipts = [
  selectJudgeAttempt([{ state: 'timeout', ordinal: 0, attemptId: 'timeout' }, terminal[0]], 1).selected,
  selectJudgeAttempt([terminal[1]], 1).selected,
];
const plan = {
  ...identity, caseId: input.caseId, submissionId: input.submissionId,
  criteria: input.criteria, availableSourceIds: input.availableSourceIds,
  sources: input.sources.map(({ id, text }) => ({ id, hash: sha(text) })),
  rubricHash: sha(rubricBytes),
  judgeSlots: receipts.map(({ slotId: id, family }, index) => ({ id, family, maxRetries: index === 0 ? 1 : 0 })),
};
const planBytes = Buffer.from(JSON.stringify(plan));
const verifiedPlan = { planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes };
const aggregate = slots => summarizeJudgeConsensus(input.criteria, slots.map(slot => slot.findings));

assert.equal(verifyTrialJudgeSchedule({ ...verifiedPlan, capture: input }, identity, receipts), 'bound');

const intact = bindJudgeSlots(input, receipts, observations, validateCapture);
assert.deepEqual(intact.map(slot => slot.state), ['bound', 'bound']);
assert.equal(aggregate(intact).criteria[0].verdict, 'disputed');
assert.deepEqual(aggregate(intact).criticalFailures, [{ criterionId: 'criterion', slot: 0 }]);

const withheld = { ...input, availableSourceIds: [] };
assert.equal(verifyTrialInputs({ ...verifiedPlan, capture: withheld }), 'sources-mismatch');
assert.deepEqual(bindJudgeSlots(withheld, receipts, observations, validateCapture).map(slot => slot.state),
  ['invalid', 'invalid']);

const wrong = [observations[0], { ...observations[1], raw: observations[0].raw }];
const incomplete = bindJudgeSlots(input, receipts, wrong, validateCapture);
assert.deepEqual(incomplete.map(slot => slot.state), ['bound', 'binding-mismatch']);
assert.equal(aggregate(incomplete).structurallyComplete, false);
assert.deepEqual(aggregate(incomplete).criticalFailures, [{ criterionId: 'criterion', slot: 0 }]);

const partial = resolveTrialJudgeSchedule({ ...verifiedPlan, capture: input }, identity, [receipts[0]]);
assert.equal(partial.state, 'bound');
const partialSlots = bindJudgeSlots(input, partial.slots, observations, validateCapture);
assert.deepEqual(partialSlots.map(slot => slot.state), ['bound', 'slot-empty']);
assert.deepEqual(aggregate(partialSlots).criticalFailures, [{ criterionId: 'criterion', slot: 0 }]);

const ledgers = [
  { slotId: terminal[0].slotId, attempts: [{ ...terminal[0], state: 'timeout', ordinal: 0, attemptId: 'timeout' }, terminal[0]] },
  { slotId: terminal[1].slotId, attempts: [terminal[1]] },
];
const disclosure = { ...identity, ordinal: 4 };
const evaluated = evaluateJudgeFlow({ ...verifiedPlan, capture: input }, identity, ledgers,
  observations, disclosure, validateCapture);
assert.deepEqual(evaluated.bindingStates, ['bound', 'bound']);
assert.equal(evaluated.independence, 'supported');
assert.deepEqual(evaluated.consensus.criticalFailures, [{ criterionId: 'criterion', slot: 0 }]);
assert.equal(evaluateJudgeFlow({ ...verifiedPlan, capture: withheld }, identity, ledgers,
  observations, disclosure, validateCapture).state, 'sources-mismatch');
const rejected = evaluateJudgeFlow({ ...verifiedPlan, capture: input }, identity, ledgers,
  wrong, disclosure, validateCapture);
assert.deepEqual(rejected.bindingStates, ['bound', 'binding-mismatch']);
assert.equal(rejected.independence, 'unknown');

const wrongRepeat = evaluateJudgeFlow({ ...verifiedPlan, capture: input }, identity, ledgers,
  [observations[0], { ...observations[1], repeat: 1 }], disclosure, validateCapture);
assert.deepEqual(wrongRepeat.bindingStates, ['bound', 'binding-mismatch']);
assert.equal(wrongRepeat.independence, 'unknown');

const lostOutput = evaluateJudgeFlow({ ...verifiedPlan, capture: input }, identity, ledgers,
  [observations[0]], disclosure, validateCapture);
assert.deepEqual(lostOutput.bindingStates, ['bound', 'output-missing']);
assert.equal(lostOutput.independence, 'unknown');
assert.deepEqual(lostOutput.consensus.criticalFailures, [{ criterionId: 'criterion', slot: 0 }]);

const slotIds = receipts.map(receipt => receipt.slotId);
assert.equal(assessJudgeIndependence(slotIds, receipts, 4), 'supported');
assert.equal(assessJudgeIndependence(slotIds, receipts, 1), 'breach');
console.log('Real validator check passed: retry, intact results, withheld source, wrong-slot output, missing output, and early disclosure.');
