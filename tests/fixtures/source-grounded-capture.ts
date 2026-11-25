import { createHash } from 'node:crypto';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function capture() {
  const text = 'A😀B';
  return { version: 1, caseId: 'case', submissionId: 'submission', sources: [{ id: 's', text, sha256: hash(text) }],
    availableSourceIds: ['s'], criteria: [{ id: 'criterion', absence: false, critical: true }],
    answerRaw: JSON.stringify({ version: 1, caseId: 'case', status: 'supported', answer: 'A request exists.',
      claims: [{ claimId: 'c', text: 'A request exists.', basis: 'explicit-source', citations: [{ sourceId: 's', start: 1, end: 2 }] }], limitations: [] }),
    judgeRaw: JSON.stringify({ version: 1, submissionId: 'submission', criteria: [{ criterionId: 'criterion', verdict: 'pass', reason: 'Synthetic shape check.', evidence: [{ collection: 'source', recordId: 's', start: 1, end: 2 }], answerClaimIds: ['c'] }], unlistedMaterialClaims: [], limitations: [] }) };
}
