import { createHash } from 'node:crypto';

function digest(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// Receipts are supplied by the host from its separate evidence store. This
// verifies consistency with those receipts, not their origin or independence.
export function bindJudgeSlots(capture, receipts, inputs, validateCapture) {
  if (receipts.length !== 2 || receipts[0].slotId === receipts[1].slotId ||
      receipts[0].attemptId === receipts[1].attemptId ||
      receipts[0].trialId !== receipts[1].trialId) {
    throw new TypeError('Expected two distinct scheduled judge slots and attempts from one trial');
  }

  return receipts.map(receipt => {
    const matches = inputs.filter(input =>
      input.slotId === receipt.slotId && input.attemptId === receipt.attemptId);
    if (matches.length === 0) return { state: 'missing', findings: null };
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
