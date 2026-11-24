#!/usr/bin/env node
/** Data-only offline validation. No semantic judgment, model, network or tools. */
import { openSync, readSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const CAPTURE_BYTES = 4 * 1024 * 1024;
const ANSWER_BYTES = 128 * 1024;
const JUDGE_BYTES = 256 * 1024;
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };
const sha = text => createHash('sha256').update(text).digest('hex');
const exact = (v, keys) => requireValue(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), 'invalid-fields');
const identifier = v => requireValue(typeof v === 'string' && v.length > 0 && [...v].length <= 128, 'invalid-identifier');
function unique(values) {
  values.forEach(identifier);
  requireValue(new Set(values).size === values.length, 'duplicate-identifier');
}

export function strictParse(raw, maxBytes) {
  requireValue(typeof raw === 'string', 'raw-json-required');
  requireValue(raw.isWellFormed(), 'invalid-unicode-string');
  requireValue(Buffer.byteLength(raw) <= maxBytes, 'payload-too-large');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('malformed-json'); }
  // JSON.parse already checked grammar. Track only container punctuation and
  // strings to detect duplicate decoded object keys, including escaped keys.
  const stack = [];
  for (const token of raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
    const t = token[0]; const top = stack.at(-1);
    if (t === '{' || t === '[') {
      stack.push({ object: t === '{', key: true, keys: new Set() });
      requireValue(stack.length <= 100, 'nesting-too-deep');
    } else if (t === '}' || t === ']') stack.pop();
    else if (t === ':') { if (top) top.key = false; }
    else if (t === ',') { if (top?.object) top.key = true; }
    else if (top?.object && top.key) {
      const key = JSON.parse(t);
      requireValue(!top.keys.has(key), 'duplicate-key'); top.keys.add(key);
    }
  }
  function finite(v) {
    if (typeof v === 'number') requireValue(Number.isFinite(v), 'nonfinite-number');
    else if (typeof v === 'string') requireValue(v.isWellFormed(), 'invalid-unicode-string');
    else if (v && typeof v === 'object') { Object.keys(v).forEach(finite); Object.values(v).forEach(finite); }
  }
  finite(value);
  return value;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const compiled = {};
const schemaHashes = {};
for (const kind of ['answer', 'judge']) {
  const bytes = readFileSync(new URL(`../../docs/evaluation/context-budget/source-grounded-answer/${kind}.schema.json`, import.meta.url));
  schemaHashes[kind] = sha(bytes);
  compiled[kind] = ajv.compile(strictParse(bytes.toString('utf8'), CAPTURE_BYTES));
}
Object.freeze(schemaHashes);
function shaped(kind, raw, limit) {
  const v = strictParse(raw, limit);
  requireValue(compiled[kind](v), `${kind}-schema-invalid`);
  return v;
}
function span(text, start, end) {
  requireValue(typeof text === 'string' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && 0 <= start && start < end && end <= [...text].length, 'invalid-span');
}
function answerRecord(answer, id) {
  if (id === 'answer') return answer.answer;
  const limitation = /^limitations\/(0|[1-9][0-9]*)$/.exec(id);
  if (limitation) return answer.limitations[Number(limitation[1])];
  if (id.startsWith('claims/') && id.endsWith('/text')) {
    const claimId = id.slice(7, -5);
    return answer.claims.find(c => c.claimId === claimId)?.text;
  }
  return undefined;
}
function validateManifest(c) {
  exact(c, ['version', 'caseId', 'submissionId', 'sources', 'availableSourceIds', 'criteria', 'answerRaw', 'judgeRaw']);
  requireValue(c.version === 1, 'unsupported-version'); identifier(c.caseId); identifier(c.submissionId);
  requireValue(Array.isArray(c.sources) && c.sources.length <= 1000, 'invalid-source-manifest');
  c.sources.forEach(s => {
    exact(s, ['id', 'text', 'sha256']); identifier(s.id);
    requireValue(typeof s.text === 'string' && typeof s.sha256 === 'string' && sha(s.text) === s.sha256, 'source-hash-mismatch');
  });
  unique(c.sources.map(s => s.id));
  requireValue(Array.isArray(c.availableSourceIds), 'invalid-available-manifest'); unique(c.availableSourceIds);
  const sources = new Map(c.sources.map(s => [s.id, s.text]));
  c.availableSourceIds.forEach(id => requireValue(sources.has(id), 'unknown-available-source'));
  requireValue(Array.isArray(c.criteria) && c.criteria.length > 0 && c.criteria.length <= 128, 'invalid-criteria-manifest');
  c.criteria.forEach(r => {
    exact(r, ['id', 'absence', 'critical']); identifier(r.id);
    requireValue(typeof r.absence === 'boolean' && typeof r.critical === 'boolean', 'invalid-criterion-flags');
  });
  unique(c.criteria.map(r => r.id));
  requireValue(c.answerRaw === null || typeof c.answerRaw === 'string', 'invalid-answer-raw');
  requireValue(c.judgeRaw === null || typeof c.judgeRaw === 'string', 'invalid-judge-raw');
  return sources;
}

export function validateCapture(capture) {
  // Also bound object callers; command callers pass through strictParse first.
  capture = strictParse(JSON.stringify(capture), CAPTURE_BYTES);
  const sources = validateManifest(capture);
  const report = { version: 1, schemaHashes, parsedCaptureHash: sha(JSON.stringify(capture)),
    answer: { state: 'failed-answer', error: 'missing-answer' },
    judge: { state: 'judge-error', error: 'missing-judge' },
    semanticJudgmentPerformed: false, qualificationAuthorized: false };
  let answer;
  if (capture.answerRaw !== null) {
    try {
      answer = shaped('answer', capture.answerRaw, ANSWER_BYTES);
      requireValue(answer.caseId === capture.caseId, 'case-identity-mismatch');
      unique(answer.claims.map(c => c.claimId));
      for (const claim of answer.claims) for (const cite of claim.citations) {
        requireValue(capture.availableSourceIds.includes(cite.sourceId), 'unknown-or-withheld-answer-source');
        span(sources.get(cite.sourceId), cite.start, cite.end);
      }
      report.answer = { state: 'structurally-valid', rawHash: sha(capture.answerRaw) };
    } catch (e) {
      answer = undefined;
      report.answer = { state: 'failed-answer', error: e.message, rawHash: sha(capture.answerRaw) };
    }
  }
  if (capture.judgeRaw !== null) {
    try {
      const judge = shaped('judge', capture.judgeRaw, JUDGE_BYTES);
      requireValue(judge.submissionId === capture.submissionId, 'submission-identity-mismatch');
      requireValue(answer !== undefined, 'answer-unavailable-for-judge-validation');
      unique(judge.criteria.map(r => r.criterionId));
      const expected = new Map(capture.criteria.map(r => [r.id, r]));
      requireValue(judge.criteria.length === expected.size, 'incomplete-criteria');
      for (const finding of judge.criteria) {
        const criterion = expected.get(finding.criterionId);
        requireValue(criterion !== undefined, 'unknown-criterion');
        requireValue(criterion.absence || finding.evidence.length > 0, 'evidence-required');
        finding.answerClaimIds.forEach(id => requireValue(answer.claims.some(c => c.claimId === id), 'unknown-answer-claim'));
        for (const cite of finding.evidence) {
          const text = cite.collection === 'source' ? sources.get(cite.recordId) : answerRecord(answer, cite.recordId);
          span(text, cite.start, cite.end);
        }
      }
      for (const omitted of judge.unlistedMaterialClaims) span(answerRecord(answer, omitted.recordId), omitted.start, omitted.end);
      // Do not turn a semantic judge's verdicts into scores or eligibility here.
      report.judge = { state: 'structurally-valid', rawHash: sha(capture.judgeRaw) };
    } catch (e) { report.judge = { state: 'judge-error', error: e.message, rawHash: sha(capture.judgeRaw) }; }
  }
  return report;
}

function readBounded(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    requireValue(fstatSync(fd).isFile(), 'regular-file-required');
    const bytes = Buffer.alloc(CAPTURE_BYTES + 1); let used = 0; let count;
    do { count = readSync(fd, bytes, used, bytes.length - used, null); used += count; } while (count && used < bytes.length);
    requireValue(used <= CAPTURE_BYTES, 'payload-too-large');
    try { return { raw: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)), rawHash: sha(bytes.subarray(0, used)) }; }
    catch { throw new Error('invalid-utf8'); }
  } finally { closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireValue(process.argv.length === 3, 'usage: source_grounded_validate.mjs CAPTURE.json');
    const { raw, rawHash } = readBounded(process.argv[2]);
    const report = { ...validateCapture(strictParse(raw, CAPTURE_BYTES)), captureRawHash: rawHash };
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.answer.state !== 'structurally-valid' || report.judge.state !== 'structurally-valid') process.exitCode = 1;
  } catch (e) {
    // Never echo source paths, private data or arbitrary parser error text.
    const known = /^(payload-too-large|regular-file-required|invalid-utf8|invalid-unicode-string|malformed-json|duplicate-key|nesting-too-deep|nonfinite-number|invalid-fields|unsupported-version|invalid-identifier|duplicate-identifier|invalid-source-manifest|source-hash-mismatch|invalid-available-manifest|unknown-available-source|invalid-criteria-manifest|invalid-criterion-flags|invalid-answer-raw|invalid-judge-raw|usage: source_grounded_validate.mjs CAPTURE.json)$/;
    process.stdout.write(JSON.stringify({ version: 1, state: 'capture-error', error: known.test(e.message) ? e.message : 'capture-read-or-validation-error', qualificationAuthorized: false }) + '\n');
    process.exitCode = 2;
  }
}
