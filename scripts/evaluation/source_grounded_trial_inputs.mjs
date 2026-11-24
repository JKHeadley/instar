import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const sha = value => createHash('sha256').update(value).digest('hex');

// Supply the host’s structural parser and the independently held plan digest.
// The plan hash is checked against the exact bytes, not reserialized JSON.
export function verifyTrialInputs({ planBytes, planHash, parsePlan, rubricBytes, capture }) {
  if (sha(planBytes) !== planHash) return 'plan-mismatch';
  const plan = parsePlan(planBytes);
  if (plan.caseId !== capture.caseId || plan.submissionId !== capture.submissionId) {
    return 'trial-mismatch';
  }
  if (sha(rubricBytes) !== plan.rubricHash ||
      !isDeepStrictEqual(capture.criteria, plan.criteria)) {
    return 'rubric-mismatch';
  }
  const sources = capture.sources.map(({ id, text }) => ({ id, hash: sha(text) }));
  if (!isDeepStrictEqual(sources, plan.sources) ||
      !isDeepStrictEqual(capture.availableSourceIds, plan.availableSourceIds)) {
    return 'sources-mismatch';
  }
  return 'bound';
}
