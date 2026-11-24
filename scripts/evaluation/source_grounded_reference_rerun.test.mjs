import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReferenceRerun as assess } from './source_grounded_reference_rerun.mjs';

const defect = { resolution: 'reference-defect', receiptId: 'defect', referenceVersion: 'v1' };
const corrected = { defectReceiptId: 'defect', referenceVersion: 'v2' };
const affected = ['full', 'reduced', 'no-context'];
const reruns = affected.map(originalRunId => ({ ...corrected, originalRunId, id: originalRunId + '-v2' }));

test('requires every frozen comparison run regardless of submission order', () => {
  assert.equal(assess(defect, corrected, affected, [...reruns].reverse()), 'covered');
  assert.equal(assess(defect, corrected, affected, [reruns[1]]), 'incomplete');
});

test('rejects the wrong defect, unchanged reference and unrelated rerun', () => {
  assert.equal(assess(defect, { ...corrected, defectReceiptId: 'different' }, affected, reruns), 'unbound');
  assert.equal(assess(defect, { ...corrected, referenceVersion: 'v1' }, affected, reruns), 'unbound');
  assert.equal(assess(defect, corrected, affected, [{ ...reruns[0], originalRunId: 'unrelated' }]), 'unbound');
});

test('rejects duplicate coverage, duplicate replacements and reuse of original IDs', () => {
  for (const replacements of [[reruns[0], reruns[0]], [reruns[0], { ...reruns[1], id: reruns[0].id }],
    [{ ...reruns[0], id: affected[0] }]]) {
    assert.equal(assess(defect, corrected, affected, replacements), 'unbound');
  }
});
