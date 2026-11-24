import { expect, it } from 'vitest';
// @ts-expect-error Internal evaluation script has no public TypeScript interface.
import { validateCapture } from '../../scripts/evaluation/source_grounded_validate.mjs';
import { capture } from '../fixtures/source-grounded-capture.js';

it('retains invalid answer and independently records judge errors', () => {
  const c = capture(); c.answerRaw = '{'; c.judgeRaw = '{';
  expect(validateCapture(c)).toMatchObject({ answer: { state: 'failed-answer' }, judge: { state: 'judge-error' }, qualificationAuthorized: false });
});
it('allows judge truth evidence withheld from answering arm without inventing availability', () => {
  const c = capture(); c.availableSourceIds = []; const a = JSON.parse(c.answerRaw); a.status = 'insufficient-evidence'; a.claims = []; a.limitations = ['No relevant source supplied.']; c.answerRaw = JSON.stringify(a);
  const j = JSON.parse(c.judgeRaw); j.criteria[0].answerClaimIds = []; c.judgeRaw = JSON.stringify(j);
  expect(validateCapture(c)).toMatchObject({ answer: { state: 'structurally-valid' }, judge: { state: 'structurally-valid' } });
});
it('requires exact unique complete criteria and known claim references', () => {
  for (const mutation of ['missing', 'duplicate', 'unknown-claim', 'empty-evidence']) {
    const c = capture(); const j = JSON.parse(c.judgeRaw);
    if (mutation === 'missing') j.criteria = [];
    if (mutation === 'duplicate') j.criteria.push(j.criteria[0]);
    if (mutation === 'unknown-claim') j.criteria[0].answerClaimIds = ['invented'];
    if (mutation === 'empty-evidence') j.criteria[0].evidence = [];
    c.judgeRaw = JSON.stringify(j); expect(validateCapture(c).judge.state).toBe('judge-error');
  }
});
it('resolves judge spans across claim and limitation strings and rejects unknown records', () => {
  const c = capture(); const a = JSON.parse(c.answerRaw); a.limitations = ['Unverified.']; c.answerRaw = JSON.stringify(a);
  const j = JSON.parse(c.judgeRaw); j.unlistedMaterialClaims = [{ recordId: 'limitations/0', start: 0, end: 3, reason: 'Synthetic check.' }]; j.criteria[0].evidence = [{ collection: 'answer', recordId: 'claims/c/text', start: 0, end: 1 }]; c.judgeRaw = JSON.stringify(j);
  expect(validateCapture(c).judge.state).toBe('structurally-valid');
  j.unlistedMaterialClaims[0].recordId = 'limitations/99'; c.judgeRaw = JSON.stringify(j); expect(validateCapture(c).judge.state).toBe('judge-error');
});
it('rejects source tampering and duplicate manifest identities as capture errors', () => {
  const c = capture(); c.sources[0].text = 'changed'; expect(() => validateCapture(c)).toThrow('source-hash-mismatch');
  const d = capture(); d.sources.push(d.sources[0]); expect(() => validateCapture(d)).toThrow('duplicate-identifier');
});
it('rejects mismatched identities, unknown judge sources and same-count unknown criteria', () => {
  const a = capture(); const answer = JSON.parse(a.answerRaw); answer.caseId = 'wrong'; a.answerRaw = JSON.stringify(answer);
  expect(validateCapture(a).answer.error).toBe('case-identity-mismatch');
  for (const mode of ['identity', 'criterion', 'source']) {
    const c = capture(); const j = JSON.parse(c.judgeRaw);
    if (mode === 'identity') j.submissionId = 'wrong';
    if (mode === 'criterion') j.criteria[0].criterionId = 'wrong';
    if (mode === 'source') j.criteria[0].evidence[0].recordId = 'wrong';
    c.judgeRaw = JSON.stringify(j); expect(validateCapture(c).judge.state).toBe('judge-error');
  }
});
it('classifies missing and oversized outputs without inventing a semantic grade', () => {
  const c = capture(); const missing = { ...c, answerRaw: null, judgeRaw: null };
  expect(validateCapture(missing)).toMatchObject({ answer: { state: 'failed-answer', error: 'missing-answer' }, judge: { state: 'judge-error', error: 'missing-judge' } });
  const bigAnswer = { ...c, answerRaw: ' '.repeat(128 * 1024 + 1) }; expect(validateCapture(bigAnswer).answer.error).toBe('payload-too-large');
  const bigJudge = { ...c, judgeRaw: ' '.repeat(256 * 1024 + 1) }; expect(validateCapture(bigJudge).judge.error).toBe('payload-too-large');
});
it('accepts an empty evidence array only with host-declared absence criterion', () => {
  const c = capture(); c.criteria[0].absence = true; const j = JSON.parse(c.judgeRaw); j.criteria[0].evidence = []; c.judgeRaw = JSON.stringify(j);
  expect(validateCapture(c).judge.state).toBe('structurally-valid');
  c.criteria[0].absence = false; expect(validateCapture(c).judge.error).toBe('evidence-required');
});
