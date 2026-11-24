import { createHash } from 'node:crypto';
import { summarizeJudgeConsensus } from './source_grounded_consensus.mjs';
import { assessJudgeIndependence } from './source_grounded_judge_independence.mjs';
import { selectJudgeAttempt } from './source_grounded_judge_retry.mjs';
import { bindJudgeSlots } from './source_grounded_judge_slots.mjs';
import { prepareTrialJudgeSchedule } from './source_grounded_trial_inputs.mjs';

function sameTrial(record, expected) {
  return record.trialId === expected.trialId && record.arm === expected.arm &&
    record.repeat === expected.repeat;
}

// The host supplies independently retained terminal, plan and disclosure
// evidence. Composition checks consistency without authenticating its origin.
export function evaluateJudgeFlow(input, expected, ledgers, observations, disclosure, validateCapture) {
  const trial = prepareTrialJudgeSchedule(input, expected);
  if (trial.state !== 'bound') return trial;
  if (ledgers.length > 2 || new Set(ledgers.map(ledger => ledger.slotId)).size !== ledgers.length) {
    return { state: 'ambiguous-ledger' };
  }
  const selected = [];
  const selection = [];
  for (const ledger of ledgers) {
    const maxRetries = trial.retryLimit(ledger.slotId);
    if (maxRetries === undefined || !ledger.attempts.every(attempt => sameTrial(attempt, expected) && attempt.slotId === ledger.slotId)) {
      return { state: 'ledger-identity-mismatch' };
    }
    const result = selectJudgeAttempt(ledger.attempts, maxRetries);
    selection.push({ slotId: ledger.slotId, state: result.state });
    if (result.selected) selected.push(result.selected);
  }

  const schedule = trial.resolve(selected);
  if (schedule.state !== 'bound') return { state: schedule.state };
  const slots = bindJudgeSlots(input.capture, schedule.slots, observations, validateCapture);
  const boundReceipts = schedule.slots.filter((_, index) => slots[index].state === 'bound');
  const independence = boundReceipts.length === 2 && disclosure && sameTrial(disclosure, expected)
    ? assessJudgeIndependence(schedule.slots.map(receipt => receipt.slotId), boundReceipts, disclosure.ordinal)
    : 'unknown';

  const consensus = summarizeJudgeConsensus(input.capture.criteria, slots.map(slot => slot.findings));
  const criticalSignals = consensus.criticalFailures.map(finding => {
    const { trialId, arm, repeat, slotId, attemptId, rawHash } = schedule.slots[finding.slot];
    const id = createHash('sha256')
      .update(JSON.stringify([
        'source-grounded-critical-v1', input.planHash, trialId, arm, repeat,
        slotId, attemptId, rawHash, finding.criterionId,
      ]))
      .digest('hex');
    return { ...finding, id };
  });
  return {
    state: 'evaluated',
    selection,
    bindingStates: slots.map(slot => slot.state),
    consensus,
    criticalSignals,
    independence,
  };
}
