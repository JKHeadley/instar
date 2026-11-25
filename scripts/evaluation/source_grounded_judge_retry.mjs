// Ordinals and terminal classifications come from the host's validated
// attempt ledger. Selection leaves the original ledger and costs intact.
export function selectJudgeAttempt(attempts, maxRetries) {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('Invalid frozen retry limit');
  }
  const ordered = [...attempts].sort((a, b) => a.ordinal - b.ordinal);
  const ids = new Set();
  let selected = null;
  for (const [ordinal, record] of ordered.entries()) {
    if (ordinal !== record.ordinal || typeof record.attemptId !== 'string' ||
        !record.attemptId || ids.has(record.attemptId)) {
      return { state: 'ambiguous', selected: null };
    }
    ids.add(record.attemptId);
    if (ordinal > maxRetries || selected ||
        (ordinal > 0 && ordered[ordinal - 1].state !== 'timeout')) {
      return { state: 'policy-violation', selected: null };
    }
    switch (record.state) {
      case 'valid':
        selected = record;
        break;
      case 'timeout':
      case 'invalid':
      case 'failed':
        break;
      default:
        return { state: 'ambiguous', selected: null };
    }
  }
  return selected ? { state: 'selected', selected } : { state: 'unresolved', selected: null };
}
