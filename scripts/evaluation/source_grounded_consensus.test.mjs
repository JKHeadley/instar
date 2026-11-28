import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeJudgeConsensus as summarize } from './source_grounded_consensus.mjs';

const criteria = [{ id: 'C', critical: true }, { id: 'N', critical: false }];
const findings = (critical, other) => [
  { criterionId: 'C', verdict: critical },
  { criterionId: 'N', verdict: other },
];

test('combines unanimous and disputed criteria without erasing critical failures', () => {
  const a = findings('fail', 'fail');
  const b = findings('pass', 'fail').reverse();
  for (const [slots, failedSlot] of [[[a, b], 0], [[b, a], 1]]) {
    assert.deepEqual(summarize(criteria, slots), {
      structurallyComplete: true,
      slotStates: ['valid', 'valid'],
      criteria: [{ criterionId: 'C', verdict: 'disputed' }, { criterionId: 'N', verdict: 'fail' }],
      criticalFailures: [{ criterionId: 'C', slot: failedSlot }],
    });
  }
});

test('records both critical failures even when judges agree', () => {
  const result = summarize(criteria, [findings('fail', 'pass'), findings('fail', 'pass')]);
  assert.deepEqual(result.criteria.map(({ verdict }) => verdict), ['fail', 'pass']);
  assert.deepEqual(result.criticalFailures.map(({ slot }) => slot), [0, 1]);
});

test('missing and malformed slots contribute no verdict or critical signal', () => {
  for (const bad of [null, findings('fail', 'pass').slice(0, 1), findings('fail', 'unknown'), {}]) {
    const result = summarize(criteria, [bad, findings('fail', 'pass')]);
    assert.equal(result.structurallyComplete, false);
    assert.deepEqual(result.slotStates, [bad === null ? 'empty' : 'invalid', 'valid']);
    assert.deepEqual(result.criteria.map(({ verdict }) => verdict), ['incomplete', 'incomplete']);
    assert.deepEqual(result.criticalFailures, [{ criterionId: 'C', slot: 1 }]);
  }
});

test('rejects an ambiguous frozen criterion list and a third vote', () => {
  assert.throws(() => summarize([criteria[0], criteria[0]], [null, null]), TypeError);
  assert.throws(() => summarize(criteria, [null, null, null]), TypeError);
});


test('two disputed votes produce a disputed criterion with no fabricated failure', () => {
  const result = summarize(criteria, [findings('disputed', 'pass'), findings('disputed', 'pass')]);
  assert.deepEqual(result.criteria.map(({ verdict }) => verdict), ['disputed', 'pass']);
  assert.deepEqual(result.criticalFailures, []);
});
