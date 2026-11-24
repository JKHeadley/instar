// Offline evidence reduction. The host supplies the two scheduled slots in
// order after binding and validating their output. null denotes an empty slot.
// The result describes structure and votes only. The host retains raw findings,
// establishes independence and decides eligibility separately.
const verdicts = new Set(['pass', 'fail', 'disputed']);

function completeSlot(findings, criteria) {
  if (findings === null) return { state: 'empty' };
  if (!Array.isArray(findings) || findings.length !== criteria.size) {
    return { state: 'invalid' };
  }
  const byId = new Map();
  for (const finding of findings) {
    if (!finding || !criteria.has(finding.criterionId) ||
        byId.has(finding.criterionId) || !verdicts.has(finding.verdict)) return { state: 'invalid' };
    byId.set(finding.criterionId, finding);
  }
  return { state: 'valid', byId };
}

export function summarizeJudgeConsensus(criteria, slots) {
  if (!Array.isArray(criteria) || criteria.length === 0 ||
      !Array.isArray(slots) || slots.length !== 2) {
    throw new TypeError('Expected a frozen criterion list and two scheduled judge slots');
  }
  const byId = new Map();
  for (const criterion of criteria) {
    if (!criterion || typeof criterion.id !== 'string' || !criterion.id ||
        typeof criterion.critical !== 'boolean' || byId.has(criterion.id)) {
      throw new TypeError('Invalid frozen criterion');
    }
    byId.set(criterion.id, criterion);
  }

  const first = completeSlot(slots[0], byId);
  const second = completeSlot(slots[1], byId);
  const criticalFailures = [];
  const results = [];
  for (const { id, critical } of byId.values()) {
    const a = first.byId?.get(id);
    const b = second.byId?.get(id);
    if (critical && a?.verdict === 'fail') criticalFailures.push({ criterionId: id, slot: 0 });
    if (critical && b?.verdict === 'fail') criticalFailures.push({ criterionId: id, slot: 1 });
    let verdict = 'incomplete';
    if (a && b) verdict = a.verdict === b.verdict ? a.verdict : 'disputed';
    results.push({ criterionId: id, verdict });
  }

  return {
    structurallyComplete: first.state === 'valid' && second.state === 'valid',
    slotStates: [first.state, second.state],
    criteria: results,
    criticalFailures,
  };
}
