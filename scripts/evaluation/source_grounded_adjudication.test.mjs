import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeCriticalResolutions as summarize } from './source_grounded_adjudication.mjs';

const signal = Object.freeze({ id: 'critical-a', criterionId: 'critical', slot: 0 });
const receipt = (resolution, id = 'receipt') => ({ id, signalId: signal.id, resolution });

test('records each recognized resolution alongside its original signal', () => {
  for (const decision of ['confirmed', 'judge-error', 'reference-defect']) {
    assert.deepEqual(summarize([signal], [receipt(decision)]),
      [{ signal, resolution: decision, receiptId: 'receipt' }]);
  }
});

test('leaves missing, conflicting and unrecognized resolutions unresolved', () => {
  for (const records of [[], [receipt('invented')], [receipt('judge-error', '')], [receipt('judge-error'), receipt('confirmed', 'other')]]) {
    assert.deepEqual(summarize([signal], records),
      [{ signal, resolution: 'unresolved', receiptId: null }]);
  }
});

test('a resolution cannot be reused for a different critical finding', () => {
  const other = { ...signal, id: 'critical-b', slot: 1 };
  assert.deepEqual(summarize([signal, other], [receipt('judge-error')]).map(item => item.resolution),
    ['judge-error', 'unresolved']);
});

test('rejects absent or duplicate signal identities before applying a resolution', () => {
  const malformed = { id: 'receipt', resolution: 'judge-error' };
  assert.throws(() => summarize([{ criterionId: 'critical', slot: 0 }], [malformed]), TypeError);
  assert.throws(() => summarize([signal, { ...signal, slot: 1 }], [receipt('judge-error')]), TypeError);
});
