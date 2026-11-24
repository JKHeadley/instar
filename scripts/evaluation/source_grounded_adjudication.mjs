const resolutions = new Set(['confirmed', 'judge-error', 'reference-defect']);

// The host supplies decisions already checked against its frozen policy.
// This records resolution separately; it never grants qualification.
export function summarizeCriticalResolutions(signals, acceptedReceipts) {
  const signalIds = new Set();
  for (const { id } of signals) {
    if (typeof id !== 'string' || !id || signalIds.has(id)) {
      throw new TypeError('Expected unique host-bound critical signal IDs');
    }
    signalIds.add(id);
  }
  return signals.map(signal => {
    const candidates = acceptedReceipts.filter(receipt => receipt.signalId === signal.id);
    const receipt = candidates.length === 1 ? candidates[0] : null;
    const resolution = receipt && typeof receipt.id === 'string' && receipt.id && resolutions.has(receipt.resolution)
      ? receipt.resolution : 'unresolved';
    return { signal, resolution, receiptId: resolution === 'unresolved' ? null : receipt.id };
  });
}
