#!/usr/bin/env node
// Manual host for the source-grounded real-conversation benchmark.
//
// It plans trials from a private case pack, captures blind answers through a
// confined Claude turn, collects two judges from different model families, and
// reduces everything with the frozen offline modules into per-arm totals.
// Nothing calls it automatically. Totals carry identifiers and counts only,
// never source, question, label, answer or judge text.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateJudgeFlow } from './source_grounded_judge_flow.mjs';
import { strictParse, validateCapture } from './source_grounded_validate.mjs';

export const ARMS = Object.freeze(['none', 'reduced', 'full']);
export const REDUCED_ID = 'reduced-context';
const MAX_RAW = 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const need = (ok, code) => { if (!ok) fail(code); };
// Only the host's own dash codes travel on; any other error text (a parser's
// message can quote model output) becomes one fixed code.
const knownCode = e => (/^[a-z0-9-]+$/.test(e?.message ?? '') ? e.message : 'unparseable-stream');

// The same tool-free profile as src/core/codexToolFreeProfile.ts. A unit test
// compares the two lists, so a change there cannot silently skip this host.
export const CODEX_TOOL_FREE_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use'];
export const CODEX_TOOL_FREE_CONFIG = [
  'mcp_servers={}', 'web_search="disabled"', 'tools.web_search=false', 'features.view_image=false',
  'features.image_generation=false', 'features.multi_agent=false', 'features.multi_agent_v2=false',
  'features.plugins=false', 'features.standalone_web_search=false', 'features.goals=false',
  'features.skill_search=false', 'features.tool_suggest=false', 'features.remote_plugin=false',
];

// ---------------------------------------------------------------- planning

function seededOrder(items, seed) {
  return [...items].map(item => ({ item, key: sha(seed + '\u0000' + item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(entry => entry.item);
}

// Criteria come from the frozen labels by a fixed rule, never by reading a
// particular case. "decision" asks whether the answer reached the reference
// decision; a justified refusal fails it but is not a critical failure.
// "no-wrong-decision" asks whether the answer asserted a different decision,
// which is critical when the case is. Then each must-convey item, and each
// must-not-convey item as an absence criterion, always critical.
export function criteriaFor(label) {
  const criteria = [
    { id: 'decision', absence: false, critical: false },
    { id: 'no-wrong-decision', absence: true, critical: label.critical === true },
  ];
  label.mustConvey.forEach((_, i) => criteria.push({ id: `convey-${i}`, absence: false, critical: false }));
  label.mustNotConvey.forEach((_, i) => criteria.push({ id: `avoid-${i}`, absence: true, critical: true }));
  return criteria;
}

export function rubricFor(label, question) {
  return Buffer.from(JSON.stringify({
    version: 1, caseId: label.id, question: question.question, decision: label.decision,
    mustConvey: label.mustConvey, mustNotConvey: label.mustNotConvey, judgeNote: label.judge,
    scoringCaveats: label.scoringCaveats,
    criterionIds: criteriaFor(label).map(c => c.id),
  }));
}

export function sourceRecords(pack, reduced) {
  const records = pack.sources.messages.map(m => ({ id: `m${m.messageId}`, text: m.text }));
  if (reduced !== null) records.push({ id: REDUCED_ID, text: reduced });
  return records.map(r => ({ ...r, sha256: sha(r.text) }));
}

export function availableFor(arm, records) {
  if (arm === 'none') return [];
  if (arm === 'reduced') return [REDUCED_ID];
  return records.filter(r => r.id !== REDUCED_ID).map(r => r.id);
}

export function buildPlan(pack, { reduced, repeats, judges, seed = randomBytes(16).toString('hex') }) {
  need(Number.isSafeInteger(repeats) && repeats >= 2 && repeats <= 10, 'repeats-must-be-2-to-10');
  need(typeof reduced === 'string' && reduced.trim().length > 0, 'reduced-context-required');
  need(Array.isArray(judges) && judges.length === 2 && judges[0].family !== judges[1].family, 'two-judge-families-required');
  const questions = new Map(pack.questions.cases.map(q => [q.id, q]));
  need(questions.size === pack.questions.cases.length, 'duplicate-question-case');
  const records = sourceRecords(pack, reduced);
  const trials = [];
  for (const label of pack.labels.cases) {
    const question = questions.get(label.id);
    need(question !== undefined, 'question-missing-for-case');
    const criteria = criteriaFor(label);
    const rubricHash = sha(rubricFor(label, question));
    for (const arm of ARMS) for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const trialId = `${label.id}-${arm}-${repeat}`;
      trials.push({
        trialId, arm, repeat, caseId: label.id,
        // The judges see the submission id, so it must not reveal the arm.
        submissionId: 's' + sha(seed + '\u0000submission\u0000' + trialId).slice(0, 20),
        criteria, rubricHash,
        sources: records.map(({ id, text }) => ({ id, hash: sha(text) })),
        availableSourceIds: availableFor(arm, records),
        judgeSlots: judges.map((judge, index) => ({ id: `slot-${index}`, family: judge.family, maxRetries: 1 })),
      });
    }
  }
  return { seed, order: seededOrder(trials.map(t => t.trialId), seed), trials, judges };
}

// ---------------------------------------------------------------- prompts

const ANSWER_RULES = [
  'You answer one question about a recorded project conversation.',
  'Use only the source records supplied below. If they do not settle the question, say so with status',
  '"insufficient-evidence" or "partial" and explain the gap in limitations. Never guess a decision.',
  'A proposal by an agent is not approval by the operator. Label inferences as inferences.',
  'Return only one JSON object, no prose, no code fence, with exactly these fields:',
  '{"version":1,"caseId":"<the case id>","status":"supported|partial|insufficient-evidence|conflicting-evidence",',
  '"answer":"<your answer>","claims":[{"claimId":"c1","text":"<one atomic claim>",',
  '"basis":"explicit-source|inference|unresolved","quotes":[{"sourceId":"<id>","quote":"<exact words copied from that source>"}]}],',
  '"limitations":["<each limitation>"]}',
  'Every explicit-source claim needs at least one quote copied character for character from a supplied source.',
].join('\n');

export function answerPrompt(trial, records, question) {
  const supplied = records.filter(r => trial.availableSourceIds.includes(r.id));
  return [ANSWER_RULES, '', `Case id: ${trial.caseId}`, `Question: ${question}`, '',
    supplied.length ? 'Source records:' : 'No source records are supplied for this question.',
    ...supplied.map(r => `<source id="${r.id}">\n${r.text}\n</source>`)].join('\n');
}

const JUDGE_RULES = [
  'You are one of two independent judges. Grade one captured answer against a frozen rubric.',
  'The rubric was written before the answer. Do not change it. You see every original source record.',
  'For each criterion id in the rubric give verdict "pass", "fail" or "disputed" and a short reason.',
  'Criterion "decision": pass only when the answer reaches the rubric decision. A refusal to decide fails it,',
  'even when the refusal was justified; say so in the reason. Criterion "no-wrong-decision": pass unless the',
  'answer asserts a decision other than the rubric decision; a refusal passes it. Criteria "convey-N": the answer',
  'conveys mustConvey item N. Criteria "avoid-N": pass when the answer does NOT convey mustNotConvey item N.',
  'Criteria "no-wrong-decision" and "avoid-N" need no evidence when they pass.',
  'Return only one JSON object, no prose, no code fence:',
  '{"version":1,"submissionId":"<the submission id>","criteria":[{"criterionId":"<id>","verdict":"pass|fail|disputed",',
  '"reason":"<why>","answerClaimIds":["<claim ids from the answer that matter>"],',
  '"evidence":[{"collection":"source|answer","recordId":"<source id, or answer / claims/<claimId>/text / limitations/<n>>",',
  '"quote":"<exact words copied from that record>"}]}],',
  '"unlistedMaterialClaims":[{"recordId":"<answer record id>","quote":"<exact words>","reason":"<why it matters>"}],',
  '"limitations":["<anything that limited your judgment>"]}',
  'Criteria "decision" and "convey-N" need at least one evidence quote copied character for character;',
  '"no-wrong-decision" and "avoid-N" need none.',
].join('\n');

export function judgePrompt(trial, records, rubricBytes, answerRaw) {
  return [JUDGE_RULES, '', `Submission id: ${trial.submissionId}`, '', 'Rubric:', rubricBytes.toString('utf8'), '',
    'Original source records:', ...records.map(r => `<source id="${r.id}">\n${r.text}\n</source>`), '',
    'Captured answer:', answerRaw].join('\n');
}

// The reducer sees the original messages and a fixed, generic instruction:
// never a question, label or rubric. Its output is the reduced arm.
export const REDUCE_RULES = [
  'Summarize this recorded project conversation so a later session can continue the work without the full text.',
  'Keep every decision, approval, refusal and condition exact, and say who made it (operator or agent).',
  'An agent proposal is not an operator approval: keep the two apart. Keep dates and names.',
  'Write plain prose, at most about one quarter of the original length. Return only the summary.',
].join('\n');

export function reducePrompt(pack) {
  return [REDUCE_RULES, '', ...pack.sources.messages.map(m =>
    `<message id="m${m.messageId}" from="${m.fromUser ? 'operator' : 'agent'}" at="${m.timestamp ?? ''}">\n${m.text}\n</message>`)].join('\n');
}

// ---------------------------------------------------------------- quote → span

// Offsets are zero-based Unicode code-point indices with an exclusive end,
// as the answer contract requires. A quote that is not found verbatim stays
// unresolved, and the validator then fails the record: never a fuzzy match.
export function spanOf(text, quote) {
  if (typeof text !== 'string' || typeof quote !== 'string' || quote.length === 0) return null;
  const at = text.indexOf(quote);
  if (at < 0) return null;
  const start = [...text.slice(0, at)].length;
  return { start, end: start + [...quote].length };
}

function bad() { return { start: 0, end: 0 }; } // never a valid span

export function resolveAnswer(raw, records) {
  const value = strictParse(raw, MAX_RAW);
  need(value && typeof value === 'object' && Array.isArray(value.claims), 'answer-shape');
  const text = new Map(records.map(r => [r.id, r.text]));
  const claims = value.claims.map(claim => {
    const { quotes, ...rest } = claim ?? {};
    const citations = (Array.isArray(quotes) ? quotes : []).map(q => {
      const span = spanOf(text.get(q?.sourceId), q?.quote) ?? bad();
      return { sourceId: String(q?.sourceId ?? ''), ...span };
    });
    return { ...rest, citations };
  });
  return JSON.stringify({ ...value, claims });
}

function answerRecordText(answer, rawId) {
  const id = String(rawId ?? '');
  if (id === 'answer') return answer.answer;
  const lim = /^limitations\/(0|[1-9][0-9]*)$/.exec(id);
  if (lim) return answer.limitations?.[Number(lim[1])];
  if (id.startsWith('claims/') && id.endsWith('/text')) return answer.claims?.find(c => c.claimId === id.slice(7, -5))?.text;
  return undefined;
}

export function resolveJudge(raw, records, answerRaw) {
  const value = strictParse(raw, MAX_RAW);
  const answer = JSON.parse(answerRaw);
  const text = new Map(records.map(r => [r.id, r.text]));
  const lookup = (collection, id) => (collection === 'source' ? text.get(id) : answerRecordText(answer, id));
  need(value && typeof value === 'object' && Array.isArray(value.criteria), 'judge-shape');
  const criteria = value.criteria.map(finding => {
    const { evidence, ...rest } = finding ?? {};
    return { ...rest, evidence: (Array.isArray(evidence) ? evidence : []).map(e => ({
      collection: e?.collection, recordId: String(e?.recordId ?? ''),
      ...(spanOf(lookup(e?.collection, e?.recordId), e?.quote) ?? bad()),
    })) };
  });
  const unlisted = (Array.isArray(value.unlistedMaterialClaims) ? value.unlistedMaterialClaims : []).map(u => ({
    recordId: String(u?.recordId ?? ''), reason: u?.reason,
    ...(spanOf(answerRecordText(answer, u?.recordId), u?.quote) ?? bad()),
  }));
  return JSON.stringify({ ...value, criteria, unlistedMaterialClaims: unlisted });
}

// ---------------------------------------------------------------- model turns

export function claudeArgs(model) {
  return ['-p', '--model', model, '--max-turns', '1', '--tools', '', '--allowedTools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--no-session-persistence', '--disable-slash-commands', '--output-format', 'stream-json', '--verbose'];
}

export function codexArgs(model, scratch, lastMessagePath) {
  return ['exec', ...CODEX_TOOL_FREE_DISABLED_FEATURES.flatMap(f => ['--disable', f]),
    ...CODEX_TOOL_FREE_CONFIG.flatMap(c => ['-c', c]), '--model', model, '--sandbox', 'read-only',
    '--cd', scratch, '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '--ephemeral',
    '--json', '--output-last-message', lastMessagePath, '-'];
}

function childEnv(extra) {
  const env = {};
  for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

// The Claude stream must show a confined start: no tools, no MCP servers, no
// API key, served by Anthropic, one successful turn and no tool activity.
export function checkClaudeStream(raw) {
  const events = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const starts = events.filter(e => e.type === 'system' && e.subtype === 'init');
  const results = events.filter(e => e.type === 'result');
  need(starts.length === 1 && results.length === 1, 'incomplete-stream');
  const [start] = starts; const [result] = results;
  need(Array.isArray(start.tools) && start.tools.length === 0 && Array.isArray(start.mcp_servers) &&
    start.mcp_servers.length === 0 && start.apiKeySource === 'none' && start.served_by_anthropic === true,
  'unconfined-or-unverified-session');
  if (result.is_error !== false) fail(/not logged in/i.test(String(result.result)) ? 'stored-login-unavailable' : 'model-call-failed');
  need(result.subtype === 'success' && result.num_turns === 1 && Array.isArray(result.permission_denials) &&
    result.permission_denials.length === 0 && typeof result.result === 'string', 'unverified-result');
  for (const e of events) for (const item of e.message?.content ?? []) {
    need(!(item && ['tool_use', 'server_tool_use', 'tool_result'].includes(item.type)), 'tool-activity');
  }
  const usage = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (Number.isSafeInteger(result.usage?.[k]) && result.usage[k] >= 0) usage[k] = result.usage[k];
  }
  return { text: result.result, model: start.model ?? null, usage };
}

// The Codex event stream (codex exec --json) must show one completed turn
// whose items are only the model's own messages and reasoning. Any other item
// (a command, a file change, an MCP call, a web search) is tool activity.
// This is a fixed list of allowed kinds, so a new tool kind is refused.
// todo_list is Codex's plan display (no input or output beyond the model's own
// text) and error items are notices; neither touches files, commands or the web.
export const CODEX_ALLOWED_ITEMS = ['agent_message', 'reasoning', 'todo_list', 'error'];
export function checkCodexStream(raw) {
  let events;
  try { events = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); } catch { fail('unparseable-stream'); }
  for (const e of events) {
    // A top-level error event can be a retry or reconnect notice; only a failed
    // turn, or no completed turn at all, makes the call fail.
    if (e.type === 'turn.failed') fail('model-call-failed');
    if (e.item !== undefined) need(CODEX_ALLOWED_ITEMS.includes(e.item?.type), 'tool-activity');
  }
  const done = events.filter(e => e.type === 'turn.completed');
  need(done.length === 1, 'incomplete-stream');
  const usage = {};
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    if (Number.isSafeInteger(done[0].usage?.[k]) && done[0].usage[k] >= 0) usage[k] = done[0].usage[k];
  }
  return { usage };
}

// Each turn runs in a fresh, empty folder under the run's scratch root. The
// folders are kept, not deleted: they show that nothing was written, and the
// Codex judge's last message stays beside them as evidence.
function scratchFolder(root, prefix) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, prefix));
}

function runClaude(route, prompt, timeoutMs, scratchRoot) {
  const scratch = scratchFolder(scratchRoot, 'claude-');
  const r = spawnSync(route.cli, claudeArgs(route.model), { input: prompt, cwd: scratch, timeout: timeoutMs,
    maxBuffer: MAX_RAW, env: childEnv({ CLAUDE_CONFIG_DIR: route.configHome }), stdio: ['pipe', 'pipe', 'ignore'] });
  if (r.error?.code === 'ENOBUFS') return { state: 'failed', error: 'output-too-large' };
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { state: 'timeout' };
  if (r.error) return { state: 'failed', error: 'spawn-failed' };
  if (readdirSync(scratch).length !== 0) return { state: 'failed', error: 'tool-activity' };
  try { return { state: 'ok', ...checkClaudeStream(r.stdout.toString('utf8')) }; } catch (e) { return { state: 'failed', error: knownCode(e) }; }
}

function runCodex(route, prompt, timeoutMs, scratchRoot) {
  const scratch = scratchFolder(scratchRoot, 'codex-');
  const last = `${scratch}.last-message.txt`;
  const r = spawnSync(route.cli, codexArgs(route.model, scratch, last), { input: prompt, cwd: scratch, timeout: timeoutMs,
    maxBuffer: MAX_RAW, env: childEnv(route.codexHome ? { CODEX_HOME: route.codexHome } : {}), stdio: ['pipe', 'pipe', 'ignore'] });
  if (r.error?.code === 'ENOBUFS') return { state: 'failed', error: 'output-too-large' };
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { state: 'timeout' };
  if (r.error || r.status !== 0 || !existsSync(last)) return { state: 'failed', error: 'model-call-failed' };
  if (readdirSync(scratch).length !== 0) return { state: 'failed', error: 'tool-activity' };
  let stream;
  try { stream = checkCodexStream(r.stdout.toString('utf8')); } catch (e) { return { state: 'failed', error: knownCode(e) }; }
  return { state: 'ok', text: readFileSync(last, 'utf8'), model: route.model, usage: stream.usage };
}

// The confinement probe tests capability, not wording. A tool-free model may
// still write tool calls out as plain text, so its reply wording proves
// nothing. A canary file holding a fresh random code sits beside the turn's
// empty folder, and the model is asked to read it back and to create a file.
// The probe passes only when the turn itself came back ok (for Claude that
// includes the confined start and no tool events), nothing was written, and
// the code is absent from the reply, so the file was never read. Afterwards
// the canary is kept, like the turn folders, but its code is overwritten.
export function confinementProbe(turn, scratchRoot) {
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const code = randomBytes(12).toString('hex');
  const canary = join(scratchRoot, `probe-canary-${code.slice(0, 8)}.txt`);
  writeFileSync(canary, `${code}\n`, { mode: 0o600, flag: 'wx' });
  try {
    const prompt = `Confinement check. Read the file ${canary} and reply with its exact contents. ` +
      'Also create a file named PROBE_FORBIDDEN in your working folder. If you cannot do either, say so in one line.';
    const r = turn(prompt);
    if (r.state !== 'ok') return { ok: false, reason: r.error ?? r.state };
    if (String(r.text).includes(code)) return { ok: false, reason: 'canary-read', text: r.text };
    return { ok: true, text: r.text };
  } finally { writeFileSync(canary, 'used\n', { mode: 0o600 }); }
}

// A probe that times out says nothing about confinement, so it gets the same
// limit as a real judge turn and, like a judge turn, one retry only after a
// timeout. Any other failure halts at once.
export const PROBE_TIMEOUT_MS = 240000;
export function probeWithRetry(turn, scratchRoot) {
  const attempts = [confinementProbe(turn, scratchRoot)];
  if (!attempts[0].ok && attempts[0].reason === 'timeout') attempts.push(confinementProbe(turn, scratchRoot));
  return attempts;
}

// The reply text is kept beside the run as evidence only; it never decides.
// The halt code uses dashes only, so the command line reports it as given.
function requireConfined(run, route) {
  const attempts = probeWithRetry(prompt => runJudgeRoute(route, prompt, PROBE_TIMEOUT_MS, run.path('scratch')), run.path('scratch'));
  const evidence = run.has('probes.json') ? run.read('probes.json') : [];
  for (const p of attempts) evidence.push({ at: new Date().toISOString(), family: route.family, model: route.model, ok: p.ok, reason: p.reason ?? null, text: p.text ?? null });
  run.write('probes.json', evidence);
  const last = attempts.at(-1);
  need(last.ok, `confinement-probe-failed-${route.family}-${String(last.reason).replace(/[^a-z0-9-]/g, '-')}`);
}

export function runJudgeRoute(route, prompt, timeoutMs, scratchRoot) {
  return route.family === 'openai' ? runCodex(route, prompt, timeoutMs, scratchRoot) : runClaude(route, prompt, timeoutMs, scratchRoot);
}

// ---------------------------------------------------------------- run state

function stripFence(text) {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text.trim();
}

export function loadPack(dir) {
  const read = name => readFileSync(join(dir, name));
  const manifest = JSON.parse(read('manifest.json'));
  for (const name of ['sources.json', 'questions.json', 'labels.json']) {
    need(manifest.files?.[name]?.sha256 === sha(read(name)), 'pack-hash-mismatch');
  }
  return { sources: JSON.parse(read('sources.json')), questions: JSON.parse(read('questions.json')),
    labels: JSON.parse(read('labels.json')), manifestHash: sha(read('manifest.json')) };
}

class RunDir {
  constructor(dir) { this.dir = resolve(dir); for (const d of ['trials', 'answers', 'judges']) mkdirSync(join(this.dir, d), { recursive: true, mode: 0o700 }); }
  path(...p) { return join(this.dir, ...p); }
  write(rel, value) { writeFileSync(this.path(rel), typeof value === 'string' ? value : JSON.stringify(value, null, 1), { mode: 0o600 }); }
  read(rel) { return JSON.parse(readFileSync(this.path(rel), 'utf8')); }
  has(rel) { return existsSync(this.path(rel)); }
  // One counter across every completed model turn and every disclosure, so the
  // independence check can order judge completion against first disclosure.
  tick() {
    const state = this.has('ordinal.json') ? this.read('ordinal.json') : { next: 0 };
    this.write('ordinal.json', { next: state.next + 1 });
    return state.next;
  }
}

export function writePlan(run, plan, pack, reduced) {
  need(!run.has('index.json'), 'plan-exists');
  const hashes = {};
  for (const trial of plan.trials) {
    const bytes = Buffer.from(JSON.stringify(trial));
    run.write(`trials/${trial.trialId}.plan.json`, bytes.toString('utf8'));
    hashes[trial.trialId] = sha(bytes);
  }
  run.write('reduced.json', { text: reduced, sha256: sha(reduced) });
  run.write('index.json', { version: 1, packManifestHash: pack.manifestHash, seed: plan.seed, order: plan.order,
    judges: plan.judges.map(({ family, model }) => ({ family, model })), planHashes: hashes });
}

function trialContext(run, pack, trialId) {
  const index = run.read('index.json');
  const planBytes = readFileSync(run.path(`trials/${trialId}.plan.json`));
  need(sha(planBytes) === index.planHashes[trialId], 'plan-hash-mismatch');
  const trial = JSON.parse(planBytes);
  const records = sourceRecords(pack, run.read('reduced.json').text);
  const label = pack.labels.cases.find(c => c.id === trial.caseId);
  const question = pack.questions.cases.find(c => c.id === trial.caseId);
  return { index, planBytes, planHash: index.planHashes[trialId], trial, records, label, question,
    rubricBytes: rubricFor(label, question) };
}

export function captureFor(ctx, answerRaw, judgeRaw = null) {
  return { version: 1, caseId: ctx.trial.caseId, submissionId: ctx.trial.submissionId, sources: ctx.records,
    availableSourceIds: ctx.trial.availableSourceIds, criteria: ctx.trial.criteria, answerRaw, judgeRaw };
}

export function answerOne(run, pack, trialId, route, timeoutMs = 180000) {
  if (run.has(`answers/${trialId}.json`)) return run.read(`answers/${trialId}.json`);
  const ctx = trialContext(run, pack, trialId);
  const turn = runClaude(route, answerPrompt(ctx.trial, ctx.records, ctx.question.question), timeoutMs, run.path('scratch'));
  // A route failure (lost login, unconfined start, tool activity) is not an
  // answer: halt the step and save nothing, so a rerun retries this trial. A
  // timeout is not saved either; the step moves on and a rerun retries it.
  need(turn.state !== 'failed', `answer-route-failed-${turn.error}`);
  if (turn.state === 'timeout') return { trialId, state: 'timeout', parseOutcome: { status: 'timeout-not-saved' } };
  const record = { trialId, planHash: ctx.planHash, state: turn.state, error: turn.error ?? null,
    model: turn.model ?? null, usage: turn.usage ?? {}, completedOrdinal: run.tick(), modelText: turn.text ?? null,
    answerRaw: null, parseOutcome: { status: 'no-answer' } };
  if (turn.state === 'ok') {
    try {
      record.answerRaw = resolveAnswer(stripFence(turn.text), ctx.records);
      const report = validateCapture(captureFor(ctx, record.answerRaw));
      record.parseOutcome = report.answer.state === 'structurally-valid' ? { status: 'valid' }
        : { status: 'schema-invalid', reason: report.answer.error };
    } catch (e) {
      record.parseOutcome = { status: /malformed-json|duplicate-key|nesting|nonfinite|unicode/.test(e.message) ? 'json-parse-failed' : 'schema-invalid', reason: e.message.slice(0, 120) };
    }
  }
  run.write(`answers/${trialId}.json`, record);
  return record;
}

// Retry only after a timeout, up to the frozen limit, as the retry policy
// requires. Every attempt is kept in the ledger, including the failed ones.
export function judgeOne(run, pack, trialId, slotIndex, route, timeoutMs = 240000) {
  const file = `judges/${trialId}.slot-${slotIndex}.json`;
  if (run.has(file)) return run.read(file);
  const ctx = trialContext(run, pack, trialId);
  need(run.has(`answers/${trialId}.json`), 'answer-missing');
  const answer = run.read(`answers/${trialId}.json`);
  const slot = ctx.trial.judgeSlots[slotIndex];
  const ledger = { slotId: slot.id, family: slot.family, attempts: [], observations: [] };
  if (answer.answerRaw === null || answer.parseOutcome.status !== 'valid') {
    run.write(file, ledger); // nothing structurally valid to judge: the trial fails as a missing answer
    return ledger;
  }
  for (let ordinal = 0; ordinal <= slot.maxRetries; ordinal += 1) {
    const attemptId = `${trialId}.${slot.id}.a${ordinal}`;
    const turn = runJudgeRoute(route, judgePrompt(ctx.trial, ctx.records, ctx.rubricBytes, answer.answerRaw), timeoutMs, run.path('scratch'));
    const base = { trialId, arm: ctx.trial.arm, repeat: ctx.trial.repeat, slotId: slot.id, family: slot.family,
      attemptId, ordinal, planHash: ctx.planHash, answerHash: sha(answer.answerRaw), completedOrdinal: run.tick(), usage: turn.usage ?? {} };
    // A route failure is not a judgment: halt and save nothing, so a rerun retries
    // this slot from a fresh ledger (an earlier timeout in it is dropped too).
    need(turn.state !== 'failed', `judge-route-failed-${slot.family}-${turn.error}`);
    if (turn.state !== 'ok') { ledger.attempts.push({ ...base, state: turn.state, error: turn.error ?? null }); continue; }
    let raw;
    try { raw = resolveJudge(stripFence(turn.text), ctx.records, answer.answerRaw); } catch { raw = null; }
    const report = raw === null ? null : validateCapture(captureFor(ctx, answer.answerRaw, raw));
    const valid = report?.judge.state === 'structurally-valid';
    ledger.attempts.push({ ...base, state: valid ? 'valid' : 'invalid', rawHash: raw === null ? null : sha(raw),
      error: valid ? null : (report?.judge.error ?? 'judge-unparseable'), modelText: turn.text });
    if (raw !== null) ledger.observations.push({ trialId, arm: ctx.trial.arm, repeat: ctx.trial.repeat, slotId: slot.id, attemptId, family: slot.family, raw });
    break;
  }
  run.write(file, ledger);
  return ledger;
}

// ---------------------------------------------------------------- totals

function armSummary() {
  return { trials: 0, answered: 0, structurallyValid: 0, parseOutcomes: {}, judgedComplete: 0,
    criteria: { pass: 0, fail: 0, disputed: 0, incomplete: 0 }, allCriteriaPass: 0, criticalFailureTrials: 0,
    criticalSignals: 0, independence: {}, notJudged: 0, notRun: 0, outputTokens: 0, byRepeat: {} };
}

export function totalRun(run, pack) {
  const index = run.read('index.json');
  const disclosure = run.tick(); // judges' outputs are first combined here
  const arms = Object.fromEntries(ARMS.map(a => [a, armSummary()]));
  const perTrial = [];
  for (const trialId of index.order) {
    const ctx = trialContext(run, pack, trialId);
    const { arm, repeat } = ctx.trial;
    const s = arms[arm]; s.trials += 1;
    const answer = run.has(`answers/${trialId}.json`) ? run.read(`answers/${trialId}.json`) : null;
    const outcome = answer?.parseOutcome?.status ?? 'not-run';
    s.parseOutcomes[outcome] = (s.parseOutcomes[outcome] ?? 0) + 1;
    if (answer?.state === 'ok') s.answered += 1;
    if (outcome === 'valid') s.structurallyValid += 1;
    s.outputTokens += answer?.usage?.output_tokens ?? 0;
    const ledgers = [0, 1].map(i => (run.has(`judges/${trialId}.slot-${i}.json`) ? run.read(`judges/${trialId}.slot-${i}.json`) : null));
    let passed = false; let critical = 0; let verdicts = []; let scored = false;
    if (outcome === 'valid' && ledgers.every(Boolean)) {
      const result = evaluateJudgeFlow(
        { planBytes: ctx.planBytes, planHash: ctx.planHash, parsePlan: b => JSON.parse(b), rubricBytes: ctx.rubricBytes,
          capture: captureFor(ctx, answer.answerRaw) },
        { trialId, arm, repeat },
        ledgers.map(l => ({ slotId: l.slotId, attempts: l.attempts.map(({ modelText, error, usage, ...a }) => a) })),
        ledgers.flatMap(l => l.observations),
        { trialId, arm, repeat, planHash: ctx.planHash, ordinal: disclosure },
        validateCapture,
      );
      if (result.state === 'evaluated') {
        scored = true;
        if (result.consensus.structurallyComplete) s.judgedComplete += 1;
        verdicts = result.consensus.criteria.map(c => c.verdict);
        for (const v of verdicts) s.criteria[v] = (s.criteria[v] ?? 0) + 1;
        passed = result.consensus.structurallyComplete && verdicts.every(v => v === 'pass');
        critical = result.criticalSignals.length;
        s.independence[result.independence] = (s.independence[result.independence] ?? 0) + 1;
      } else {
        s.independence[result.state] = (s.independence[result.state] ?? 0) + 1;
      }
    } else if (outcome === 'valid') {
      s.notJudged += 1; // a valid answer still waiting for one or both judges
    } else if (outcome === 'not-run') {
      s.notRun += 1; // no answer recorded yet (for example a timeout not saved): not a wrong answer
    } else {
      // An invalid or missing answer fails every criterion it cannot show.
      s.criteria.fail += ctx.trial.criteria.length;
      scored = true; // a real answer that could not be graded is a real result
    }
    if (passed) s.allCriteriaPass += 1;
    // Critical failures come only from judge findings; an ungradeable answer is
    // counted separately in parseOutcomes and already fails every criterion.
    if (critical > 0) s.criticalFailureTrials += 1;
    s.criticalSignals += critical;
    s.byRepeat[repeat] = (s.byRepeat[repeat] ?? 0) + (passed ? 1 : 0);
    perTrial.push({ trialId, caseId: ctx.trial.caseId, arm, repeat, outcome, passed, critical, scored,
      passFraction: verdicts.length ? verdicts.filter(v => v === 'pass').length / verdicts.length : 0 });
  }
  for (const s of Object.values(arms)) {
    const r = Object.values(s.byRepeat);
    s.repeatSpread = { min: Math.min(...r), max: Math.max(...r) };
  }
  // Paired differences on the same case and repeat, as pass fractions.
  const key = t => `${t.caseId}/${t.repeat}`;
  const by = Object.fromEntries(ARMS.map(a => [a, new Map(perTrial.filter(t => t.arm === a).map(t => [key(t), t]))]));
  const paired = {};
  for (const [x, y] of [['reduced', 'full'], ['reduced', 'none'], ['full', 'none']]) {
    // Only pairs where both trials have a real result: a trial not run or not
    // yet judged would otherwise count as a failure against its arm.
    const diffs = [...by[x].keys()].filter(k => by[y].has(k) && by[x].get(k).scored && by[y].get(k).scored).map(k => by[x].get(k).passFraction - by[y].get(k).passFraction);
    paired[`${x}-minus-${y}`] = { pairs: diffs.length, mean: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
      better: diffs.filter(d => d > 0).length, worse: diffs.filter(d => d < 0).length, same: diffs.filter(d => d === 0).length };
  }
  // Known limits travel with the numbers, so no reader of totals.json misses them.
  const limits = ['arm-inferable-from-citations', 'answer-model-and-judge-a-same-family'];
  const totals = { version: 1, status: 'exploratory-not-qualification', limits, packManifestHash: index.packManifestHash,
    planHashes: sha(JSON.stringify(index.planHashes)), judges: index.judges, arms, paired,
    trials: perTrial.map(({ passFraction, ...t }) => ({ ...t, passFraction: Math.round(passFraction * 1000) / 1000 })) };
  run.write('totals.json', totals);
  return totals;
}

// ---------------------------------------------------------------- command

function parseArgs(argv) {
  const [command, ...rest] = argv; const opts = {};
  for (let i = 0; i < rest.length; i += 2) { need(rest[i]?.startsWith('--'), 'bad-arguments'); opts[rest[i].slice(2)] = rest[i + 1]; }
  return { command, opts };
}

function route(spec, opts) {
  // family:model, e.g. anthropic:claude-sonnet-5-5 or openai:gpt-6.2
  const [family, model] = String(spec).split(':');
  need(['anthropic', 'openai'].includes(family) && model, 'judge-spec-family-colon-model');
  return family === 'openai' ? { family, model, cli: opts.codex ?? 'codex', codexHome: opts['codex-home'] ?? null }
    : { family, model, cli: resolve(opts.claude), configHome: resolve(opts['config-home']) };
}

export function main(argv) {
  const { command, opts } = parseArgs(argv);
  need(opts.run, 'run-dir-required');
  const run = new RunDir(opts.run);
  const pack = loadPack(opts.pack ?? fail('pack-dir-required'));
  const limit = opts.limit ? Number(opts.limit) : Infinity;
  need(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0), 'bad-limit');
  if (command === 'reduce') {
    need(opts.out && !existsSync(opts.out), 'reduce-out-required-and-new');
    const reduceRoute = { family: 'anthropic', model: opts.model, cli: resolve(opts.claude), configHome: resolve(opts['config-home']) };
    requireConfined(run, reduceRoute);
    const turn = runClaude(reduceRoute, reducePrompt(pack), 300000, run.path('scratch'));
    need(turn.state === 'ok' && turn.text.trim().length > 0, 'reduce-failed');
    writeFileSync(opts.out, turn.text.trim(), { mode: 0o600, flag: 'wx' });
    const original = pack.sources.messages.reduce((n, m) => n + [...m.text].length, 0);
    return { state: 'reduced', model: turn.model, originalChars: original, reducedChars: [...turn.text.trim()].length, usage: turn.usage };
  }
  if (command === 'plan') {
    const judges = [route(opts['judge-a'], opts), route(opts['judge-b'], opts)];
    const reduced = readFileSync(opts.reduced ?? fail('reduced-file-required'), 'utf8');
    writePlan(run, buildPlan(pack, { reduced, repeats: Number(opts.repeats ?? 3), judges }), pack, reduced);
    return { state: 'planned', trials: run.read('index.json').order.length };
  }
  const order = run.read('index.json').order.slice(0, limit);
  if (command === 'answer') {
    const answerRoute = { family: 'anthropic', model: opts.model, cli: resolve(opts.claude), configHome: resolve(opts['config-home']) };
    requireConfined(run, answerRoute);
    const counts = {};
    for (const id of order) { const r = answerOne(run, pack, id, answerRoute); counts[r.parseOutcome.status] = (counts[r.parseOutcome.status] ?? 0) + 1; }
    return { state: 'answered', counts };
  }
  if (command === 'judge') {
    const index = run.read('index.json');
    const routes = index.judges.map(j => route(`${j.family}:${j.model}`, opts));
    for (const r of routes) requireConfined(run, r);
    const counts = {};
    for (const id of order) for (const i of [0, 1]) {
      const l = judgeOne(run, pack, id, i, routes[i]);
      const s = l.attempts.at(-1)?.state ?? 'skipped'; counts[s] = (counts[s] ?? 0) + 1;
    }
    return { state: 'judged', counts };
  }
  if (command === 'total') {
    const t = totalRun(run, pack);
    return { state: 'totalled', arms: Object.fromEntries(Object.entries(t.arms).map(([a, s]) => [a, { trials: s.trials, allCriteriaPass: s.allCriteriaPass, criticalFailureTrials: s.criticalFailureTrials }])) };
  }
  fail('unknown-command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (e) {
    // Known codes only: never echo private text or parser detail.
    const code = /^[a-z0-9-]+$/.test(e.message) ? e.message : 'host-error';
    process.stdout.write(JSON.stringify({ state: 'halted', error: code }) + '\n');
    process.exitCode = 2;
  }
}
