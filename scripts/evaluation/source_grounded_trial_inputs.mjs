import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const sha = value => createHash('sha256').update(value).digest('hex');

// Supply the host’s structural parser and the independently held plan digest.
// The plan hash is checked against the exact bytes, not reserialized JSON.
function checkTrialInputs({ planBytes, planHash, parsePlan, rubricBytes, capture }) {
  if (sha(planBytes) !== planHash) return { state: 'plan-mismatch' };
  const plan = parsePlan(planBytes);
  if (plan.caseId !== capture.caseId || plan.submissionId !== capture.submissionId) {
    return { state: 'trial-mismatch' };
  }
  if (sha(rubricBytes) !== plan.rubricHash ||
      !isDeepStrictEqual(capture.criteria, plan.criteria)) {
    return { state: 'rubric-mismatch' };
  }
  const sources = capture.sources.map(({ id, text }) => ({ id, hash: sha(text) }));
  if (!isDeepStrictEqual(sources, plan.sources) ||
      !isDeepStrictEqual(capture.availableSourceIds, plan.availableSourceIds)) {
    return { state: 'sources-mismatch' };
  }
  return { state: 'bound', plan };
}

export function verifyTrialInputs(input) {
  return checkTrialInputs(input).state;
}

export function verifyTrialJudgeSchedule(input, expected, receipts) {
  return resolveTrialJudgeSchedule(input, expected, receipts).state;
}

// Successful schedules are ordered by the frozen plan, including empty slots.
export function resolveTrialJudgeSchedule(input, expected, receipts) {
  const result = checkTrialInputs(input);
  if (result.state !== 'bound') return result;
  const state = verifyScheduledJudges(result.plan, expected, receipts);
  if (state !== 'bound') return { state };
  const byId = new Map(receipts.map(receipt => [receipt.slotId, receipt]));
  return { state, slots: result.plan.judgeSlots.map(({ id }) => byId.get(id) ?? null) };
}

// Expected identity comes from the host's selected trial, never a judge
// receipt. The parsed plan and its scheduled slots have been schema-checked.
export function verifyScheduledJudges(plan, expected, receipts) {
  if (plan.trialId !== expected.trialId || plan.arm !== expected.arm ||
      plan.repeat !== expected.repeat) return 'trial-mismatch';

  const slots = new Map(plan.judgeSlots.map(slot => [slot.id, slot.family]));
  if (slots.size !== 2 || plan.judgeSlots.length !== 2 ||
      receipts.length > 2 || new Set(receipts.map(receipt => receipt.slotId)).size !== receipts.length ||
      new Set(receipts.map(receipt => receipt.attemptId)).size !== receipts.length) {
    return 'schedule-mismatch';
  }
  for (const receipt of receipts) {
    if (receipt.trialId !== plan.trialId || receipt.arm !== plan.arm ||
        receipt.repeat !== plan.repeat || !slots.has(receipt.slotId) ||
        slots.get(receipt.slotId) !== receipt.family) return 'schedule-mismatch';
  }
  return 'bound';
}
