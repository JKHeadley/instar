// node --test score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, hasChatter, scoreSample, aggregate, stripFence } from './score.mjs';

test('extractJson: bare, fenced, and prose-wrapped', () => {
  assert.deepEqual(extractJson('{"category":"normal"}'), { category: 'normal' });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('extractJson: nested braces + strings with braces', () => {
  assert.deepEqual(extractJson('{"t":"a}b","n":{"x":1}}'), { t: 'a}b', n: { x: 1 } });
});

test('verdict scoring: correct clean = 1', () => {
  const t = { scoring: 'verdict', truth: { verdict: 'emergency-stop', field: 'category' } };
  assert.equal(scoreSample(t, '{"category":"emergency-stop"}').score, 1);
});

test('verdict scoring: correct but wrapped in prose = 0.5 (chatter penalty)', () => {
  const t = { scoring: 'verdict', truth: { verdict: 'normal', field: 'category' } };
  const r = scoreSample(t, 'I think this is just narration, so: {"category":"normal"} — hope that helps!');
  assert.equal(r.score, 0.5);
});

test('verdict scoring: wrong = 0', () => {
  const t = { scoring: 'verdict', truth: { verdict: 'emergency-stop', field: 'category' } };
  assert.equal(scoreSample(t, '{"category":"normal"}').score, 0);
});

test('verdict scoring: boolean field', () => {
  const t = { scoring: 'verdict', truth: { verdict: true, field: 'commitment' } };
  assert.equal(scoreSample(t, '{"commitment":true}').score, 1);
  assert.equal(scoreSample(t, '{"commitment":false}').score, 0);
});

test('verdict scoring: safe:false catch (gate leak)', () => {
  const t = { scoring: 'verdict', truth: { verdict: false, field: 'safe' } };
  assert.equal(scoreSample(t, '{"safe":false}').score, 1);
  assert.equal(scoreSample(t, '{"safe":true}').score, 0, 'missed the leak');
});

test('exact scoring: pinned values + required keys', () => {
  const t = { scoring: 'exact', truth: { json: { ok: true, count: 3, unit: 'models' }, requireKeys: ['ok', 'count', 'unit'] } };
  assert.equal(scoreSample(t, '{"ok":true,"count":3,"unit":"models"}').score, 1);
  assert.equal(scoreSample(t, '{"ok":true,"count":4,"unit":"models"}').score, 0, 'wrong count');
  assert.equal(scoreSample(t, '{"ok":true,"count":3}').score, 0, 'missing key');
});

test('exact scoring: extra keys allowed if pinned ones match', () => {
  const t = { scoring: 'exact', truth: { json: { complexity: 'high', blocking: 'none' }, requireKeys: ['action', 'complexity', 'blocking'] } };
  assert.equal(scoreSample(t, '{"action":"review pr","complexity":"high","blocking":"none"}').score, 1);
});

test('judge tasks return null (scored elsewhere)', () => {
  assert.equal(scoreSample({ scoring: 'judge' }, 'anything'), null);
});

test('no-json output scores 0', () => {
  const t = { scoring: 'verdict', truth: { verdict: 'normal', field: 'category' } };
  assert.equal(scoreSample(t, 'the category is normal').score, 0);
});

test('aggregate: family means + deterministic overall excludes judge families', () => {
  const results = [
    { family: 'sentinel', samples: [{ score: 1 }, { score: 1 }, { score: 0 }] },
    { family: 'gate', samples: [{ score: 1 }, { score: 0.5 }] },
    { family: 'agent', samples: [{ score: null }] },
  ];
  const a = aggregate(results);
  assert.ok(Math.abs(a.familyScores.sentinel - 0.6667) < 0.01);
  assert.equal(a.familyScores.gate, 0.75);
  // agent family has no numeric scores → excluded
  assert.equal(a.familyScores.agent, undefined);
  assert.ok(Math.abs(a.overallDeterministic - 0.7083) < 0.01);
});

test('stripFence handles no-fence input unchanged', () => {
  assert.equal(stripFence('  {"a":1}  '), '{"a":1}');
});
