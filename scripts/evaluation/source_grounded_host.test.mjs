import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ARMS, REDUCED_ID, CODEX_TOOL_FREE_CONFIG, CODEX_TOOL_FREE_DISABLED_FEATURES, availableFor, buildPlan,
  checkClaudeStream, codexArgs, confinementProbe, criteriaFor, loadPack, resolveAnswer, resolveJudge, sourceRecords, spanOf,
  totalRun, writePlan, answerPrompt, judgePrompt, reducePrompt,
} from './source_grounded_host.mjs';

const sha = v => createHash('sha256').update(v).digest('hex');
const judges = [{ family: 'anthropic', model: 'synthetic-a' }, { family: 'openai', model: 'synthetic-b' }];

// A made-up two-case pack in the real pack's layout. No private data.
function syntheticPack() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-pack-'));
  const files = {
    'sources.json': { status: 'synthetic', topicId: 1, messages: [
      { messageId: 10, topicId: 1, text: 'Operator: ship the café build on Friday. ✅', fromUser: true },
      { messageId: 11, topicId: 1, text: 'Agent: I propose we also rotate the keys.', fromUser: false },
    ] },
    'questions.json': { version: 1, status: 'synthetic', cases: [
      { id: 'q1', question: 'When was the build approved to ship?', scenarioKind: 'decision' },
      { id: 'q2', question: 'Was key rotation approved?', scenarioKind: 'authority' },
    ] },
    'labels.json': { version: 1, status: 'synthetic', cases: [
      { id: 'q1', decision: 'friday', mustConvey: ['Friday'], mustNotConvey: ['Monday'], critical: true, judge: 'n', scoringCaveats: {} },
      { id: 'q2', decision: 'not-approved', mustConvey: ['only proposed', 'no operator approval'], mustNotConvey: ['approved'], critical: false, judge: 'n', scoringCaveats: {} },
    ] },
  };
  const manifest = { files: {} };
  for (const [name, value] of Object.entries(files)) {
    const bytes = JSON.stringify(value);
    writeFileSync(join(dir, name), bytes);
    manifest.files[name] = { sha256: sha(bytes) };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

test('criteria follow a fixed rule: decision, no wrong decision, each must-convey, each must-not-convey', () => {
  assert.deepEqual(criteriaFor({ critical: true, mustConvey: [], mustNotConvey: [] }), [
    { id: 'decision', absence: false, critical: false },
    { id: 'no-wrong-decision', absence: true, critical: true },
  ]);
  assert.deepEqual(criteriaFor({ critical: false, mustConvey: ['a', 'b'], mustNotConvey: ['c'] }), [
    { id: 'decision', absence: false, critical: false },
    { id: 'no-wrong-decision', absence: true, critical: false },
    { id: 'convey-0', absence: false, critical: false },
    { id: 'convey-1', absence: false, critical: false },
    { id: 'avoid-0', absence: true, critical: true },
  ]);
});

test('arms: none gets no sources, reduced gets only the reduced record, full gets every original message', () => {
  const pack = loadPack(syntheticPack());
  const records = sourceRecords(pack, 'summary');
  assert.deepEqual(availableFor('none', records), []);
  assert.deepEqual(availableFor('reduced', records), [REDUCED_ID]);
  assert.deepEqual(availableFor('full', records), ['m10', 'm11']);
});

test('a plan covers every case, arm and repeat, blinds the submission id, and shuffles the order', () => {
  const pack = loadPack(syntheticPack());
  const plan = buildPlan(pack, { reduced: 'summary', repeats: 2, judges, seed: 'fixed' });
  assert.equal(plan.trials.length, 2 * ARMS.length * 2);
  for (const t of plan.trials) {
    assert.match(t.submissionId, /^s[0-9a-f]{20}$/);
    assert.ok(!t.submissionId.includes(t.arm));
    assert.deepEqual(t.judgeSlots.map(s => s.family), ['anthropic', 'openai']);
  }
  assert.notDeepEqual(plan.order, plan.trials.map(t => t.trialId));
  assert.deepEqual([...plan.order].sort(), plan.trials.map(t => t.trialId).sort());
});

test('a plan refuses one repeat, an empty reduction, or two judges from one family', () => {
  const pack = loadPack(syntheticPack());
  assert.throws(() => buildPlan(pack, { reduced: 'x', repeats: 1, judges }), /repeats/);
  assert.throws(() => buildPlan(pack, { reduced: ' ', repeats: 2, judges }), /reduced/);
  assert.throws(() => buildPlan(pack, { reduced: 'x', repeats: 2, judges: [judges[0], judges[0]] }), /two-judge-families/);
});

test('a pack whose files no longer match the manifest is refused', () => {
  const dir = syntheticPack();
  writeFileSync(join(dir, 'labels.json'), '{"tampered":true}');
  assert.throws(() => loadPack(dir), /pack-hash-mismatch/);
});

test('quote spans are code-point offsets and only exact quotes resolve', () => {
  const text = 'Operator: ship the café build on Friday. ✅';
  assert.deepEqual(spanOf(text, 'Friday'), { start: 33, end: 39 });
  assert.equal([...text].slice(33, 39).join(''), 'Friday');
  assert.deepEqual(spanOf('a✅b', 'b'), { start: 2, end: 3 });
  assert.equal(spanOf(text, 'friday'), null);
  assert.equal(spanOf(text, ''), null);
});

test('answer quotes become citations; an invented quote becomes an invalid span, never a guess', () => {
  const records = [{ id: 'm10', text: 'ship on Friday' }];
  const raw = JSON.stringify({ version: 1, caseId: 'q1', status: 'supported', answer: 'Friday', limitations: [],
    claims: [{ claimId: 'c1', text: 'Friday', basis: 'explicit-source', quotes: [{ sourceId: 'm10', quote: 'Friday' }, { sourceId: 'm10', quote: 'Monday' }] }] });
  const resolved = JSON.parse(resolveAnswer(raw, records));
  assert.deepEqual(resolved.claims[0].citations, [{ sourceId: 'm10', start: 8, end: 14 }, { sourceId: 'm10', start: 0, end: 0 }]);
  assert.equal('quotes' in resolved.claims[0], false);
});

test('judge evidence quotes resolve against sources and answer records', () => {
  const records = [{ id: 'm10', text: 'ship on Friday' }];
  const answerRaw = JSON.stringify({ answer: 'It ships Friday', claims: [{ claimId: 'c1', text: 'Friday ship' }], limitations: ['none'] });
  const raw = JSON.stringify({ version: 1, submissionId: 's', limitations: [], unlistedMaterialClaims: [],
    criteria: [{ criterionId: 'decision', verdict: 'pass', reason: 'r', answerClaimIds: ['c1'],
      evidence: [{ collection: 'source', recordId: 'm10', quote: 'Friday' }, { collection: 'answer', recordId: 'claims/c1/text', quote: 'ship' }] }] });
  assert.deepEqual(JSON.parse(resolveJudge(raw, records, answerRaw)).criteria[0].evidence, [
    { collection: 'source', recordId: 'm10', start: 8, end: 14 },
    { collection: 'answer', recordId: 'claims/c1/text', start: 7, end: 11 },
  ]);
});

test('prompts: the answerer never sees the rubric; the judge never sees the arm', () => {
  const pack = loadPack(syntheticPack());
  const plan = buildPlan(pack, { reduced: 'REDUCED-SUMMARY', repeats: 2, judges, seed: 'fixed' });
  const records = sourceRecords(pack, 'REDUCED-SUMMARY');
  const none = plan.trials.find(t => t.arm === 'none');
  const reduced = plan.trials.find(t => t.arm === 'reduced');
  const noneText = answerPrompt(none, records, 'Q?');
  assert.ok(!noneText.includes('ship the café') && !noneText.includes('REDUCED-SUMMARY') && !noneText.includes('mustConvey'));
  const reducedText = answerPrompt(reduced, records, 'Q?');
  assert.ok(reducedText.includes('REDUCED-SUMMARY') && !reducedText.includes('ship the café'));
  const judgeText = judgePrompt(reduced, records, Buffer.from('{"rubric":1}'), '{}');
  for (const arm of ARMS) assert.ok(!judgeText.includes(reduced.trialId) && !new RegExp(`\\b${arm}-\\d`).test(judgeText));
});

test('the reducer sees only the messages, never a question or label', () => {
  const pack = loadPack(syntheticPack());
  const text = reducePrompt(pack);
  assert.ok(text.includes('ship the café build') && text.includes('from="agent"'));
  for (const hidden of ['When was the build approved', 'not-approved', 'only proposed', 'mustConvey']) assert.ok(!text.includes(hidden));
});

test('the Claude stream check refuses tools, MCP servers, API keys and tool activity', () => {
  const start = { type: 'system', subtype: 'init', tools: [], mcp_servers: [], apiKeySource: 'none', served_by_anthropic: true, model: 'm' };
  const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, permission_denials: [], result: '{}', usage: { output_tokens: 4, other: 9 } };
  const stream = (s, r, extra = []) => [s, ...extra, r].map(x => JSON.stringify(x)).join('\n');
  assert.deepEqual(checkClaudeStream(stream(start, result)).usage, { output_tokens: 4 });
  for (const change of [{ tools: ['Bash'] }, { mcp_servers: [{}] }, { apiKeySource: 'env' }, { served_by_anthropic: false }]) {
    assert.throws(() => checkClaudeStream(stream({ ...start, ...change }, result)), /unconfined/);
  }
  assert.throws(() => checkClaudeStream(stream(start, result, [{ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }])), /tool-activity/);
  assert.throws(() => checkClaudeStream(stream(start, { ...result, is_error: true, result: 'Not logged in' })), /stored-login-unavailable/);
});

test('the confinement probe judges capability, not wording', () => {
  const root = mkdtempSync(join(tmpdir(), 'sg-probe-'));
  const canaryOf = prompt => /Read the file (\S+) and reply/.exec(prompt)[1];
  // A tool-free model that writes a pretend tool call as text passes: the canary was never read.
  const pretend = prompt => ({ state: 'ok', text: `I'll try. <invoke name="Write"><parameter name="file_path">PROBE_FORBIDDEN</parameter></invoke>` });
  assert.equal(confinementProbe(pretend, root).ok, true);
  // A sandbox refusal passes too, and the reply is kept as evidence.
  assert.deepEqual(confinementProbe(() => ({ state: 'ok', text: 'The read-only sandbox blocked creation.' }), root),
    { ok: true, text: 'The read-only sandbox blocked creation.' });
  // A model that really read the file fails, whatever else it says.
  const reader = prompt => ({ state: 'ok', text: `NO_TOOLS ${readFileSync(canaryOf(prompt), 'utf8').trim()}` });
  const read = confinementProbe(reader, root);
  assert.equal(read.ok, false); assert.equal(read.reason, 'canary-read');
  // A turn the runner already refused (unconfined start, tool events, a written file) fails with its reason.
  assert.deepEqual(confinementProbe(() => ({ state: 'failed', error: 'tool-activity' }), root), { ok: false, reason: 'tool-activity' });
  assert.deepEqual(confinementProbe(() => ({ state: 'timeout' }), root), { ok: false, reason: 'timeout' });
  // Every canary is kept but its code is overwritten, and each run uses a fresh code.
  for (const f of readdirSync(root)) assert.equal(readFileSync(join(root, f), 'utf8'), 'used\n');
  const seen = new Set();
  for (let i = 0; i < 3; i++) confinementProbe(p => { seen.add(readFileSync(canaryOf(p), 'utf8')); return { state: 'ok', text: '' }; }, root);
  assert.equal(seen.size, 3);
});

test('the Codex judge uses the same tool-free profile as instar itself', () => {
  const source = readFileSync(new URL('../../src/core/codexToolFreeProfile.ts', import.meta.url), 'utf8');
  const list = name => [...source.split(`export const ${name} = [`)[1].split('] as const')[0].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(CODEX_TOOL_FREE_DISABLED_FEATURES, list('CODEX_TOOL_FREE_DISABLED_FEATURES'));
  assert.deepEqual(CODEX_TOOL_FREE_CONFIG, list('CODEX_TOOL_FREE_CONFIG'));
  const args = codexArgs('m', '/scratch', '/last');
  for (const required of ['--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', 'project_doc_max_bytes=0']) assert.ok(args.includes(required));
});

// End to end over fabricated answers and judge outputs: no model is called.
test('totals reduce real trial evidence into per-arm counts with no private text', () => {
  const pack = loadPack(syntheticPack());
  const runDir = mkdtempSync(join(tmpdir(), 'sg-run-'));
  for (const d of ['trials', 'answers', 'judges']) mkdirSync(join(runDir, d));
  const reduced = 'Summary: the operator approved shipping on Friday.';
  const plan = buildPlan(pack, { reduced, repeats: 2, judges, seed: 'fixed' });
  const run = { dir: runDir, path: (...p) => join(runDir, ...p),
    write(rel, v) { writeFileSync(join(runDir, rel), typeof v === 'string' ? v : JSON.stringify(v)); },
    read(rel) { return JSON.parse(readFileSync(join(runDir, rel), 'utf8')); },
    has(rel) { try { readFileSync(join(runDir, rel)); return true; } catch { return false; } },
    n: 0, tick() { return this.n++; } };
  writePlan(run, plan, pack, reduced);
  const records = sourceRecords(pack, reduced);
  for (const t of plan.trials) {
    const usable = t.availableSourceIds.length > 0;
    const answerRaw = JSON.stringify({ version: 1, caseId: t.caseId, status: usable ? 'supported' : 'insufficient-evidence',
      answer: usable ? 'Friday.' : 'Not in the supplied records.', limitations: usable ? [] : ['no sources'],
      claims: usable ? [{ claimId: 'c1', text: 'Friday.', basis: 'explicit-source', citations: [{ sourceId: t.availableSourceIds[0], start: 0, end: 1 }] }] : [] });
    run.write(`answers/${t.trialId}.json`, { trialId: t.trialId, state: 'ok', usage: { output_tokens: 5 }, answerRaw, parseOutcome: { status: 'valid' } });
    const planHash = run.read('index.json').planHashes[t.trialId];
    t.judgeSlots.forEach((slot, i) => {
      const verdict = usable ? 'pass' : 'fail';
      const raw = JSON.stringify({ version: 1, submissionId: t.submissionId, limitations: [], unlistedMaterialClaims: [],
        criteria: t.criteria.map(c => ({ criterionId: c.id, verdict: c.absence ? 'pass' : verdict, reason: 'r', answerClaimIds: [],
          evidence: c.absence ? [] : [{ collection: 'answer', recordId: 'answer', start: 0, end: 1 }] })) });
      const attempt = { trialId: t.trialId, arm: t.arm, repeat: t.repeat, slotId: slot.id, family: slot.family,
        attemptId: `${t.trialId}.${slot.id}.a0`, ordinal: 0, planHash, answerHash: sha(answerRaw), completedOrdinal: run.tick(),
        state: 'valid', rawHash: sha(raw) };
      run.write(`judges/${t.trialId}.slot-${i}.json`, { slotId: slot.id, family: slot.family, attempts: [attempt],
        observations: [{ trialId: t.trialId, arm: t.arm, repeat: t.repeat, slotId: slot.id, attemptId: attempt.attemptId, family: slot.family, raw }] });
    });
  }
  const totals = totalRun(run, pack);
  assert.equal(totals.arms.full.allCriteriaPass, 4);
  assert.equal(totals.arms.reduced.allCriteriaPass, 4);
  assert.equal(totals.arms.none.allCriteriaPass, 0);
  assert.equal(totals.arms.none.criticalFailureTrials, 0); // a justified refusal fails decision, not critically
  assert.deepEqual(totals.arms.full.independence, { supported: 4 });
  assert.equal(totals.paired['full-minus-none'].better, 4);
  assert.equal(totals.arms.full.outputTokens, 20);
  const text = JSON.stringify(totals);
  for (const secret of ['café', 'Friday', 'rotate', 'Summary']) assert.ok(!text.includes(secret));
  assert.ok(records.length === 3);
});
