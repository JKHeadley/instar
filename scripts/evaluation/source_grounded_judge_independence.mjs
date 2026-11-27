// This classifies independently retained host evidence. It does not establish
// the provenance of supplied events or authenticate a serving model.
export function assessJudgeIndependence(slotIds, receipts, firstDisclosureOrdinal) {
  if (slotIds.length !== 2 || slotIds[0] === slotIds[1]) {
    throw new TypeError('Expected two distinct scheduled slots');
  }
  const slots = slotIds.map(id => receipts.filter(receipt => receipt.slotId === id));
  if (slots.some(records => records.length !== 1) || receipts.length !== 2) return 'unknown';

  const [[first], [second]] = slots;
  if (!first.family || !second.family || !first.trialId ||
      first.trialId !== second.trialId || !first.attemptId || !second.attemptId ||
      first.attemptId === second.attemptId) return 'unknown';
  if (first.family === second.family) return 'breach';

  const completed = [first.completedOrdinal, second.completedOrdinal];
  if (completed.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 0) ||
      completed[0] === completed[1] ||
      !Number.isSafeInteger(firstDisclosureOrdinal) || firstDisclosureOrdinal < 0 ||
      completed.includes(firstDisclosureOrdinal)) return 'unknown';

  return Math.max(...completed) < firstDisclosureOrdinal ? 'supported' : 'breach';
}
