import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectJudgeAttempt } from './source_grounded_judge_retry.mjs';

const first = { ordinal: 0, attemptId: 'first', state: 'timeout' };
const retry = { ordinal: 1, attemptId: 'retry', state: 'valid' };

test('selects a permitted timeout retry regardless of receipt arrival order', () => {
  const ledger = [retry, first];
  assert.deepEqual(selectJudgeAttempt(ledger, 1), { state: 'selected', selected: retry });
  assert.deepEqual(ledger, [retry, first]);
});

test('a retry after a valid or non-retryable result leaves the slot unresolved', () => {
  for (const state of ['valid', 'invalid', 'failed']) {
    assert.deepEqual(selectJudgeAttempt([{ ...first, state }, retry], 1),
      { state: 'policy-violation', selected: null });
  }
  assert.equal(selectJudgeAttempt([first, retry], 0).state, 'policy-violation');
});

test('gaps, conflicting terminal receipts and repeated attempt identities fail closed', () => {
  for (const ledger of [[retry], [first, { ...first, state: 'valid' }],
    [first, { ...retry, attemptId: first.attemptId }]]) {
    assert.deepEqual(selectJudgeAttempt(ledger, 1), { state: 'ambiguous', selected: null });
  }
});

test('records no selection for absent or exhausted attempts', () => {
  assert.deepEqual(selectJudgeAttempt([], 1), { state: 'unresolved', selected: null });
  assert.deepEqual(selectJudgeAttempt([first, { ...retry, state: 'timeout' }], 1),
    { state: 'unresolved', selected: null });
});
