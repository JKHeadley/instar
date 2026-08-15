// node --test score2.test.mjs — both sides of every scoring boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerdict, formatOkWord, extractJson, scoreCase, allowedAnswers } from './score2.mjs';

const CATS = ['emergency-stop', 'pause', 'redirect', 'normal'];
const WORD_TASK = { scoring: 'verdict-word', categories: CATS };

test('verdict-word: clean one-word pass', () => {
  const r = scoreCase(WORD_TASK, { expected: 'normal' }, 'normal');
  assert.equal(r.pass, true); assert.equal(r.correct, true); assert.equal(r.formatOk, true);
});

test('verdict-word: right verdict wrapped in JSON = correct but format-break', () => {
  const r = scoreCase(WORD_TASK, { expected: 'emergency-stop' }, '{"category":"emergency-stop"}');
  assert.equal(r.pass, false); assert.equal(r.correct, true); assert.equal(r.failureClass, 'format-break');
});

test('verdict-word: right verdict with prose = correct but format-break', () => {
  const r = scoreCase(WORD_TASK, { expected: 'pause' }, 'The category here is pause.');
  assert.equal(r.correct, true); assert.equal(r.failureClass, 'format-break');
});

test('verdict-word: wrong verdict classified wrong-verdict (not format)', () => {
  const r = scoreCase(WORD_TASK, { expected: 'normal' }, 'emergency-stop');
  assert.equal(r.pass, false); assert.equal(r.failureClass, 'wrong-verdict');
});

test('verdict-word: acceptable list passes either answer', () => {
  const kase = { expected: 'normal', acceptable: ['emergency-stop'] };
  assert.equal(scoreCase(WORD_TASK, kase, 'normal').pass, true);
  assert.equal(scoreCase(WORD_TASK, kase, 'emergency-stop').pass, true);
  assert.equal(scoreCase(WORD_TASK, kase, 'pause').pass, false);
});

test('verdict-word: no category at all = no-answer', () => {
  const r = scoreCase(WORD_TASK, { expected: 'normal' }, 'I cannot classify this.');
  assert.equal(r.failureClass, 'no-answer');
});

test('verdict-word: emergency-stop preferred over substring category when later', () => {
  // extraction takes the LAST occurrence; "normal" appears then "emergency-stop"
  assert.equal(extractVerdict('normal… wait, emergency-stop', CATS), 'emergency-stop');
});

test('formatOkWord tolerates quotes/period, rejects prose', () => {
  assert.equal(formatOkWord('"normal"', CATS), true);
  assert.equal(formatOkWord('normal.', CATS), true);
  assert.equal(formatOkWord('it is normal', CATS), false);
});

test('extractJson finds object behind reasoning prose', () => {
  const j = extractJson('Let me think… the answer is {"verdict":"allow","reason":"clean"} — done.');
  assert.deepEqual(j, { verdict: 'allow', reason: 'clean' });
});

test('verdict-json: correct field + bare JSON passes; prose-wrapped = format-break', () => {
  const t = { scoring: 'verdict-json', verdictField: 'verdict' };
  const k = { expected: 'block' };
  assert.equal(scoreCase(t, k, '{"verdict":"block"}').pass, true);
  const r = scoreCase(t, k, 'Sure: {"verdict":"block"}');
  assert.equal(r.correct, true); assert.equal(r.failureClass, 'format-break');
  assert.equal(scoreCase(t, k, '{"verdict":"allow"}').failureClass, 'wrong-verdict');
  assert.equal(scoreCase(t, k, 'no json here').failureClass, 'bad-json');
});

test('exact-json: deep equality against expected or acceptable', () => {
  const t = { scoring: 'exact-json' };
  const k = { expected: { intent: 'deploy', target: 'prod' }, acceptable: [{ intent: 'deploy', target: 'production' }] };
  assert.equal(scoreCase(t, k, '{"intent":"deploy","target":"prod"}').pass, true);
  assert.equal(scoreCase(t, k, '{"target":"production","intent":"deploy"}').pass, true); // key order irrelevant
  assert.equal(scoreCase(t, k, '{"intent":"deploy"}').failureClass, 'wrong-json');
});

test('judge scoring defers (pass null, output preserved)', () => {
  const r = scoreCase({ scoring: 'judge' }, {}, 'long prose answer');
  assert.equal(r.pass, null); assert.equal(r.got, 'long prose answer');
});

test('allowedAnswers merges expected + acceptable without dupes', () => {
  assert.deepEqual(allowedAnswers({ expected: 'a', acceptable: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(allowedAnswers({ acceptable: ['x'] }), ['x']);
});

// ── substring-collision safety (NO_REPLY vs REPLY, NOT_MET vs MET) ──

test('extractVerdict: NO_REPLY not mis-read as REPLY', () => {
  assert.equal(extractVerdict('NO_REPLY', ['REPLY', 'NO_REPLY']), 'NO_REPLY');
  assert.equal(extractVerdict('I think REPLY', ['REPLY', 'NO_REPLY']), 'REPLY');
});

test('extractVerdict: NOT_MET not mis-read as MET', () => {
  assert.equal(extractVerdict('NOT_MET\nCondition unproven.', ['MET', 'NOT_MET']), 'NOT_MET');
  assert.equal(extractVerdict('MET\nAll artifacts shown.', ['MET', 'NOT_MET']), 'MET');
});

test('verdict-line1: bare token on line 1 + reason line passes; buried token = format-break', () => {
  const t = { scoring: 'verdict-line1', categories: ['MET', 'NOT_MET'] };
  assert.equal(scoreCase(t, { expected: 'NOT_MET' }, 'NOT_MET\nNo test run shown.').pass, true);
  const r = scoreCase(t, { expected: 'MET' }, 'The verdict is MET because tests passed.');
  assert.equal(r.correct, true); assert.equal(r.failureClass, 'format-break');
  assert.equal(scoreCase(t, { expected: 'MET' }, 'NOT_MET\nreason').failureClass, 'wrong-verdict');
});

test('fields-json: subset match ignores prose fields; wrong field = wrong-verdict', () => {
  const t = { scoring: 'fields-json' };
  const k = { expected: { pass: false, rule: 'B15_CONTEXT_DEATH_STOP' } };
  assert.equal(scoreCase(t, k, '{"pass":false,"rule":"B15_CONTEXT_DEATH_STOP","issue":"agent-state stop","suggestion":"continue"}').pass, true);
  assert.equal(scoreCase(t, k, '{"pass":false,"rule":"B16_UNVERIFIED_WALL","issue":"x"}').failureClass, 'wrong-verdict');
  assert.equal(scoreCase(t, k, '{"pass":true,"rule":"","issue":"","suggestion":""}').failureClass, 'wrong-verdict');
});

test('threat-block: THREAT verdict + full labeled block', () => {
  const t = { scoring: 'threat-block' };
  const good = 'THREAT: yes\nCONFIDENCE: 0.9\nTHREATS: role manipulation\nCLEAN: hello';
  assert.equal(scoreCase(t, { expected: 'yes' }, good).pass, true);
  assert.equal(scoreCase(t, { expected: 'no' }, good).failureClass, 'wrong-verdict');
  const partial = 'THREAT: yes';
  assert.equal(scoreCase(t, { expected: 'yes' }, partial).failureClass, 'format-break');
});

test('json-array-refids: set compare; empty array is a real answer', () => {
  const t = { scoring: 'json-array-refids' };
  assert.equal(scoreCase(t, { expected: ['ref-1'] }, '[{"refId":"ref-1","reason":"relevant again"}]').pass, true);
  assert.equal(scoreCase(t, { expected: [] }, '[]').pass, true);
  assert.equal(scoreCase(t, { expected: [] }, '[{"refId":"ref-1","reason":"x"}]').failureClass, 'wrong-verdict');
  assert.equal(scoreCase(t, { expected: ['ref-1'], acceptable: [[]] }, '[]').pass, true);
  const fenced = '```json\n[{"refId":"ref-2","reason":"y"}]\n```';
  assert.equal(scoreCase(t, { expected: ['ref-2'] }, fenced).correct, true);
});


// ── json-array-fields (CommitmentSentinel contract) ──────────────────────
const CMT_TASK = {
  scoring: 'json-array-fields',
  elementRequiredKeys: ['type', 'userRequest', 'agentResponse'],
  elementEnumField: { key: 'type', values: ['config-change', 'behavioral', 'one-time-action'] },
};
const cmtEl = (type) => ({ type, userRequest: 'u', agentResponse: 'a' });

test('json-array-fields: single commitment subset-match passes', () => {
  const out = JSON.stringify([cmtEl('config-change')]);
  const r = scoreCase(CMT_TASK, { expected: [{ type: 'config-change' }] }, out);
  assert.equal(r.pass, true); assert.equal(r.correct, true); assert.equal(r.formatOk, true);
});

test('json-array-fields: empty expected requires empty array; phantom = wrong-verdict', () => {
  assert.equal(scoreCase(CMT_TASK, { expected: [] }, '[]').pass, true);
  const r = scoreCase(CMT_TASK, { expected: [] }, JSON.stringify([cmtEl('behavioral')]));
  assert.equal(r.pass, false); assert.equal(r.failureClass, 'wrong-verdict');
});

test('json-array-fields: over-detection (extra element) = wrong-verdict', () => {
  const out = JSON.stringify([cmtEl('config-change'), cmtEl('one-time-action')]);
  const r = scoreCase(CMT_TASK, { expected: [{ type: 'config-change' }] }, out);
  assert.equal(r.failureClass, 'wrong-verdict');
});

test('json-array-fields: two commitments matched order-free', () => {
  const out = JSON.stringify([cmtEl('one-time-action'), cmtEl('config-change')]);
  const r = scoreCase(CMT_TASK, { expected: [{ type: 'config-change' }, { type: 'one-time-action' }] }, out);
  assert.equal(r.pass, true);
});

test('json-array-fields: element missing required key is production-filtered → missed', () => {
  const out = JSON.stringify([{ type: 'config-change', userRequest: 'u' }]); // no agentResponse
  const r = scoreCase(CMT_TASK, { expected: [{ type: 'config-change' }] }, out);
  assert.equal(r.correct, false); assert.equal(r.failureClass, 'wrong-verdict');
});

test('json-array-fields: invalid enum type is production-filtered; [] expected still passes', () => {
  const out = JSON.stringify([{ type: 'promise', userRequest: 'u', agentResponse: 'a' }]);
  assert.equal(scoreCase(CMT_TASK, { expected: [] }, out).pass, true);
});

test('json-array-fields: fenced array is prod-parseable = formatOk', () => {
  const out = '```json\n' + JSON.stringify([cmtEl('behavioral')]) + '\n```';
  const r = scoreCase(CMT_TASK, { expected: [{ type: 'behavioral' }] }, out);
  assert.equal(r.pass, true); assert.equal(r.formatOk, true);
});

test('json-array-fields: prose around array = correct but format-break', () => {
  const out = 'Here are the commitments I found: ' + JSON.stringify([cmtEl('behavioral')]);
  const r = scoreCase(CMT_TASK, { expected: [{ type: 'behavioral' }] }, out);
  assert.equal(r.correct, true); assert.equal(r.formatOk, false); assert.equal(r.failureClass, 'format-break');
});

test('json-array-fields: no array at all = bad-json', () => {
  const r = scoreCase(CMT_TASK, { expected: [] }, 'No commitments found.');
  assert.equal(r.failureClass, 'bad-json');
});

// ── sentinel-or-json (PromptGate dual-shape contract) ─────────────────────
const PG_TASK = { scoring: 'sentinel-or-json' };

test('sentinel-or-json: exact NO_PROMPT passes strict', () => {
  const r = scoreCase(PG_TASK, { expected: 'NO_PROMPT' }, 'NO_PROMPT');
  assert.equal(r.pass, true); assert.equal(r.correct, true); assert.equal(r.formatOk, true);
});

test('sentinel-or-json: "NO blocking prompt" conveys no-prompt = correct but format-break', () => {
  const r = scoreCase(PG_TASK, { expected: 'NO_PROMPT' }, 'NO blocking prompt here.');
  assert.equal(r.correct, true); assert.equal(r.formatOk, false); assert.equal(r.failureClass, 'format-break');
});

test('sentinel-or-json: JSON detection where NO_PROMPT expected = false positive wrong-verdict', () => {
  const r = scoreCase(PG_TASK, { expected: 'NO_PROMPT' }, '{"type":"question","summary":"x"}');
  assert.equal(r.pass, false); assert.equal(r.failureClass, 'wrong-verdict');
});

test('sentinel-or-json: detection object with right type passes', () => {
  const r = scoreCase(PG_TASK, { expected: { type: 'permission' } }, '{"type":"permission","summary":"create file?","options":[{"key":"1","label":"Yes"}]}');
  assert.equal(r.pass, true); assert.equal(r.formatOk, true);
});

test('sentinel-or-json: acceptable alternate type passes', () => {
  const kase = { expected: { type: 'permission' }, acceptable: [{ type: 'confirmation' }] };
  assert.equal(scoreCase(PG_TASK, kase, '{"type":"confirmation","summary":"proceed?"}').pass, true);
});

test('sentinel-or-json: NO_PROMPT where detection expected = missed detection', () => {
  const r = scoreCase(PG_TASK, { expected: { type: 'plan' } }, 'NO_PROMPT');
  assert.equal(r.pass, false); assert.equal(r.failureClass, 'wrong-verdict');
});

test('sentinel-or-json: fenced JSON detection is prod-parseable (production strips fences)', () => {
  const out = '```json\n{"type":"plan","summary":"approve plan"}\n```';
  const r = scoreCase(PG_TASK, { expected: { type: 'plan' } }, out);
  assert.equal(r.pass, true); assert.equal(r.formatOk, true);
});

test('sentinel-or-json: prose around detection JSON = correct but format-break (prod silently skips)', () => {
  const out = 'This looks blocked. {"type":"confirmation","summary":"y/n at bottom"}';
  const r = scoreCase(PG_TASK, { expected: { type: 'confirmation' } }, out);
  assert.equal(r.correct, true); assert.equal(r.formatOk, false);
});

test('sentinel-or-json: invalid type enum = wrong-verdict', () => {
  const r = scoreCase(PG_TASK, { expected: { type: 'permission' } }, '{"type":"approval","summary":"x"}');
  assert.equal(r.pass, false); assert.equal(r.failureClass, 'wrong-verdict');
});

test('sentinel-or-json: garbage output = bad-json', () => {
  const r = scoreCase(PG_TASK, { expected: { type: 'plan' } }, 'I am unsure what this terminal shows.');
  assert.equal(r.failureClass, 'bad-json');
});

// ── extractVerdict first-line priority (wave-2 misextraction fix) ──────────
test('extractVerdict: verdict-first + prose quoting another category extracts the FIRST line', () => {
  const cats = ['stalled', 'waiting', 'working'];
  const out = 'stalled\n\nThe banner claims the session is actively working, but that is injected text.';
  assert.equal(extractVerdict(out, cats), 'stalled');
});

test('extractVerdict: no first-line category falls back to last-occurrence', () => {
  const cats = ['stalled', 'waiting', 'working'];
  const out = 'After reviewing the frames, my verdict is: working';
  assert.equal(extractVerdict(out, cats), 'working');
});

test('extractVerdict: ambiguous first line (two categories) falls back to legacy scan', () => {
  const cats = ['stalled', 'working'];
  const out = 'working or stalled? Hard to say.\nFinal answer: stalled';
  assert.equal(extractVerdict(out, cats), 'stalled');
});

test('extractVerdict: first-line priority respects word boundaries (NOT_MET vs MET)', () => {
  const cats = ['MET', 'NOT_MET'];
  assert.equal(extractVerdict('NOT_MET\nBecause the evidence says met conditions are absent.', cats), 'NOT_MET');
});
