import { summarizeJudgeConsensus } from './source_grounded_consensus.mjs';
import { assessJudgeIndependence } from './source_grounded_judge_independence.mjs';
import { selectJudgeAttempt } from './source_grounded_judge_retry.mjs';
import { bindJudgeSlots } from './source_grounded_judge_slots.mjs';
import { checkTrialInputs, resolveScheduledJudges, verifyScheduledJudges } from './source_grounded_trial_inputs.mjs';

function sameTrial(record, expected) {
  return record.trialId === expected.trialId && record.arm === expected.arm &&
    record.repeat === expected.repeat;
}

// The host supplies independently retained terminal, plan and disclosure
// evidence. Composition checks consistency without authenticating its origin.
export function evaluateJudgeFlow(input, expected, ledgers, observations, disclosure, validateCapture) {
  const trial = checkTrialInputs(input);
  if (trial.state !== 'bound') return trial;
  const scheduleState = verifyScheduledJudges(trial.plan, expected, []);
  if (scheduleState !== 'bound') return { state: scheduleState };
  const policies = new Map(trial.plan.judgeSlots.map(slot => [slot.id, slot.maxRetries]));
  if ([...policies.values()].some(limit => !Number.isSafeInteger(limit) || limit < 0)) {
    return { state: 'retry-policy-mismatch' };
  }
  if (ledgers.length > 2 || new Set(ledgers.map(ledger => ledger.slotId)).size !== ledgers.length) {
    return { state: 'ambiguous-ledger' };
  }
  const selected = [];
  const selection = [];
  for (const ledger of ledgers) {
    if (!policies.has(ledger.slotId) || !ledger.attempts.every(attempt => sameTrial(attempt, expected) && attempt.slotId === ledger.slotId)) {
      return { state: 'ledger-identity-mismatch' };
    }
    const result = selectJudgeAttempt(ledger.attempts, policies.get(ledger.slotId));
    selection.push({ slotId: ledger.slotId, state: result.state });
    if (result.selected) selected.push(result.selected);
  }

  const schedule = resolveScheduledJudges(trial.plan, expected, selected);
  if (schedule.state !== 'bound') return { state: schedule.state };
  const slots = bindJudgeSlots(input.capture, schedule.slots, observations, validateCapture);
  const boundReceipts = schedule.slots.filter((_, index) => slots[index].state === 'bound');
  const independence = boundReceipts.length === 2 && disclosure && sameTrial(disclosure, expected)
    ? assessJudgeIndependence(schedule.slots.map(receipt => receipt.slotId), boundReceipts, disclosure.ordinal)
    : 'unknown';

  return {
    state: 'evaluated',
    selection,
    bindingStates: slots.map(slot => slot.state),
    consensus: summarizeJudgeConsensus(input.capture.criteria, slots.map(slot => slot.findings)),
    independence,
  };
}
