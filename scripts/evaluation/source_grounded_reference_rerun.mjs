// Check coverage against the host's frozen affected-run inventory. This does
// not approve the corrected reference or clear the historical finding.
export function assessReferenceRerun(defect, corrected, affectedRunIds, reruns) {
  if (defect.resolution !== 'reference-defect' || !defect.receiptId ||
      corrected.defectReceiptId !== defect.receiptId ||
      !defect.referenceVersion || !corrected.referenceVersion ||
      corrected.referenceVersion === defect.referenceVersion) return 'unbound';

  const affected = new Set(affectedRunIds);
  if (affected.size === 0 || affected.size !== affectedRunIds.length) return 'unbound';
  const replacementIds = new Set();
  for (const rerun of reruns) {
    if (!affected.delete(rerun.originalRunId) ||
        rerun.defectReceiptId !== defect.receiptId ||
        rerun.referenceVersion !== corrected.referenceVersion ||
        !rerun.id || affectedRunIds.includes(rerun.id) || replacementIds.has(rerun.id)) {
      return 'unbound';
    }
    replacementIds.add(rerun.id);
  }
  return affected.size === 0 ? 'covered' : 'incomplete';
}
