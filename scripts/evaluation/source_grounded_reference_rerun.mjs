// Check coverage against the host's frozen affected-run inventory. This does
// not approve the corrected reference or clear the historical finding.
export function assessReferenceRerun(defect, corrected, affectedRuns, reruns) {
  if (defect.resolution !== 'reference-defect' || !defect.receiptId ||
      corrected.defectReceiptId !== defect.receiptId ||
      !defect.referenceVersion || !corrected.referenceVersion ||
      corrected.referenceVersion === defect.referenceVersion) return 'unbound';

  const affected = new Map(affectedRuns.map(run => [run.id, run]));
  if (affected.size === 0 || affected.size !== affectedRuns.length ||
      affectedRuns.some(run => !run.id || !run.caseId || !run.submissionId ||
        !run.arm || !Number.isSafeInteger(run.repeat) || run.repeat < 0)) return 'unbound';
  const originals = new Set(affected.keys());
  const replacementIds = new Set();
  for (const rerun of reruns) {
    const original = affected.get(rerun.originalRunId);
    if (!original || rerun.caseId !== original.caseId || rerun.submissionId !== original.submissionId ||
        rerun.arm !== original.arm || rerun.repeat !== original.repeat ||
        rerun.defectReceiptId !== defect.receiptId ||
        rerun.referenceVersion !== corrected.referenceVersion ||
        !rerun.id || originals.has(rerun.id) || replacementIds.has(rerun.id)) {
      return 'unbound';
    }
    affected.delete(rerun.originalRunId);
    replacementIds.add(rerun.id);
  }
  return affected.size === 0 ? 'covered' : 'incomplete';
}
