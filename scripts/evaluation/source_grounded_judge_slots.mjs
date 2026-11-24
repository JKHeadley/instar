import { createHash } from 'node:crypto';

function digest(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// Receipts are supplied by the host from its separate evidence store. This
// verifies consistency with those receipts, not their origin or independence.
export function bindJudgeSlots(capture, receipts, inputs, validateCapture) {
  const found = receipts.filter(receipt => receipt !== null);
  if (receipts.length !== 2 || (found.length === 2 &&
      (found[0].slotId === found[1].slotId || found[0].attemptId === found[1].attemptId ||
       found[0].trialId !== found[1].trialId))) {
    throw new TypeError('Expected two scheduled judge slots from one trial');
  }

  return receipts.map(receipt => {
    if (receipt === null) return { state: 'slot-empty', findings: null };
    const matches = inputs.filter(input =>
      input.slotId === receipt.slotId && input.attemptId === receipt.attemptId);
    if (matches.length === 0) return { state: 'output-missing', findings: null };
    if (matches.length !== 1) return { state: 'ambiguous', findings: null };
    const input = matches[0];
    if (input.trialId !== receipt.trialId || input.family !== receipt.family ||
        typeof input.raw !== 'string' || digest(input.raw) !== receipt.rawHash ||
        typeof capture.answerRaw !== 'string' || digest(capture.answerRaw) !== receipt.answerHash) {
      return { state: 'binding-mismatch', findings: null };
    }

    const report = validateCapture({ ...capture, judgeRaw: input.raw });
    if (report.answer.state !== 'structurally-valid' ||
        report.judge.state !== 'structurally-valid' || report.judge.rawHash !== receipt.rawHash) {
      return { state: 'invalid', findings: null };
    }
    return { state: 'bound', findings: JSON.parse(input.raw).criteria };
  });
}
