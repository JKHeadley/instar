import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyTrialInputs } from './source_grounded_trial_inputs.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const rubricBytes = Buffer.from('Synthetic rubric\n');
const capture = {
  caseId: 'case', submissionId: 'submission',
  criteria: [{ id: 'criterion', critical: true, absence: false }],
  sources: [{ id: 's', text: 'A😀B' }, { id: 'hidden', text: 'reference' }],
  availableSourceIds: ['s'],
};
const planBytes = Buffer.from(JSON.stringify({
  caseId: capture.caseId, submissionId: capture.submissionId,
  criteria: capture.criteria, rubricHash: sha(rubricBytes),
  sources: capture.sources.map(({ id, text }) => ({ id, hash: sha(text) })),
  availableSourceIds: capture.availableSourceIds,
}));
const input = { planBytes, planHash: sha(planBytes), parsePlan: JSON.parse, rubricBytes, capture };

test('accepts the intact plan and the exact rubric and sources', () => {
  assert.equal(verifyTrialInputs(input), 'bound');
});

test('checks exact plan bytes before using the parser', () => {
  assert.equal(verifyTrialInputs({
    ...input, planBytes: Buffer.concat([planBytes, Buffer.from('\n')]),
    parsePlan: () => assert.fail('unbound plan reached parser'),
  }), 'plan-mismatch');
});

test('rejects a valid-looking change to the rubric or criterion flags', () => {
  assert.equal(verifyTrialInputs({ ...input, rubricBytes: Buffer.from('Changed rubric') }), 'rubric-mismatch');
  assert.equal(verifyTrialInputs({
    ...input, capture: { ...capture, criteria: [{ ...capture.criteria[0], critical: false }] },
  }), 'rubric-mismatch');
});

test('rejects changed source bytes with a matching replacement digest and added exposure', () => {
  const text = 'changed';
  assert.equal(verifyTrialInputs({
    ...input, capture: { ...capture, sources: [{ id: 's', text, sha256: sha(text) }, capture.sources[1]] },
  }), 'sources-mismatch');
  assert.equal(verifyTrialInputs({
    ...input, capture: { ...capture, availableSourceIds: ['s', 'hidden'] },
  }), 'sources-mismatch');
});

test('requires byte buffers even when a string would hash to the expected value', () => {
  assert.equal(verifyTrialInputs({ ...input, planBytes: planBytes.toString() }), 'invalid-bytes');
  assert.equal(verifyTrialInputs({ ...input, rubricBytes: rubricBytes.toString() }), 'invalid-bytes');
});
