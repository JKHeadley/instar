import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ENTRY = 'scripts/lint-checker-blind-input-coverage.mjs';
const GUARD = 'scripts/lib/checker-blind-input-ratchet.mjs';
const GUARD_TEST = 'tests/unit/checker-blind-input-ratchet.test.ts';
const ATTRIBUTION = 'scripts/lint-llm-attribution.js';
const PLANTED = 'scripts/phase-b/deep/lint-s3-uncovered.mjs';

function absolute(root, rel) {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes isolated root: ${rel}`);
  return resolved;
}
function read(root, rel) { return fs.readFileSync(absolute(root, rel), 'utf8'); }
function write(root, rel, content) {
  fs.mkdirSync(path.dirname(absolute(root, rel)), { recursive: true });
  fs.writeFileSync(absolute(root, rel), content, 'utf8');
}
function verification(checks) { return { ok: checks.every((item) => item.passed), checks }; }
function replaceOnce(root, rel, before, after) {
  const content = read(root, rel);
  const first = content.indexOf(before);
  if (first === -1 || first !== content.lastIndexOf(before)) throw new Error(`${rel}: replacement target missing or ambiguous`);
  write(root, rel, `${content.slice(0, first)}${after}${content.slice(first + before.length)}`);
}
function replaceFunctionBody(root, rel, signature, replacement) {
  const content = read(root, rel);
  const match = signature.exec(content);
  if (!match || signature.exec(content)) throw new Error(`${rel}: function signature missing or ambiguous`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    if (content[i] === '}') depth -= 1;
    if (depth === 0) {
      write(root, rel, `${content.slice(0, open + 1)}\n${replacement}\n${content.slice(i)}`);
      return;
    }
  }
  throw new Error(`${rel}: function body did not close`);
}

export const pipelineCommands = [{
  argv: ['npm', 'run', 'lint'],
  observeAny: ['checker-blind-input: population=', 'checker-blind-input: NOT-PROVEN'],
  timeoutMs: 1_200_000,
}];
export const guardCommands = [{
  argv: [process.execPath, ENTRY],
  observeAny: ['checker-blind-input', 'checker blind-input class ratchet', 'Test Files'],
  timeoutMs: 300_000,
}];

export function prepareWorkspace(root, protectedBaseEvidence) {
  const expected = protectedBaseEvidence?.commit;
  if (!/^[a-f0-9]{40}$/.test(expected ?? '')) throw new Error('core did not supply a server-resolved protected base');
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/upstream/main', 'refs/heads/main']) {
    const actual = spawnSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' });
    if (actual.status !== 0 || actual.stdout.trim() !== expected) {
      throw new Error(`isolated protected-base ref mismatch: ${ref}`);
    }
  }
}

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);
  if (mutation.id === 'p4b-planted-nested-checker') {
    const planted = changedPaths.includes(PLANTED) && fs.existsSync(absolute(root, PLANTED)) &&
      read(root, PLANTED).includes('s3PlantedChecker');
    return { status: planted ? 'proven' : 'unknown', mode: 'outside-enumeration', checks: [
      { check: 'new nested lint is a real recursively enumerated checker candidate', passed: planted },
      { check: 'new checker has no blind-case coverage id', passed: !read(root, 'scripts/checker-blind-input-cases.mjs').includes(PLANTED) },
    ] };
  }
  const routed = changedPaths.some((rel) => declared.has(rel));
  const marker = mutation.marker;
  const marked = !marker || changedPaths.some((rel) => fs.existsSync(absolute(root, rel)) && read(root, rel).includes(marker));
  return { status: routed && marked ? 'proven' : 'unknown', mode: 'declared-load-bearing-input', checks: [
    { check: 'changed path is a declared guard or production subject', passed: routed },
    { check: marker ? `semantic mutation marker ${marker} is present` : 'exact structural mutation verified', passed: marked },
  ] };
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-checker-hollow', property: 'P1', violationClass: 'hollowing', label: 'SYMBOL-PRESERVING HOLLOW', paths: [ATTRIBUTION], marker: 'S3 adapter P1',
    apply(root) {
      replaceFunctionBody(root, ATTRIBUTION, /export function runLint\(files, \{ allowlist = VIOLATIONS_ALLOWLIST, funnelFiles = FUNNEL_FILES, checkStale = false \} = \{\}\) \{/g,
        "  // S3 adapter P1: exact API preserved; blind input is fabricated clean.\n  void files; void allowlist; void funnelFiles; void checkStale;\n  return { real: [], stale: [], blind: [] };");
    },
    verify(root) { const content = read(root, ATTRIBUTION); return verification([
      { check: 'runLint export and signature remain', passed: content.includes('export function runLint(files, { allowlist = VIOLATIONS_ALLOWLIST') },
      { check: 'constant clean result replaced implementation', passed: content.includes('S3 adapter P1') && content.includes('blind: []') },
    ]); },
  },
  {
    id: 'p2-subject-self-reports-clean', property: 'P2', violationClass: 'self-report / false testimony', label: 'SUBJECT SELF-REPORTS CLEAN', paths: [ATTRIBUTION], marker: 'S3 adapter P2',
    apply(root) {
      replaceFunctionBody(root, ATTRIBUTION, /export function runLint\(files, \{ allowlist = VIOLATIONS_ALLOWLIST, funnelFiles = FUNNEL_FILES, checkStale = false \} = \{\}\) \{/g,
        "  // S3 adapter P2: subject testimony claims every input was inspected.\n  void files; void allowlist; void funnelFiles; void checkStale;\n  return { real: [], stale: [], blind: [], subjectClaim: 'all-inputs-readable' };");
    },
    verify(root) { const content = read(root, ATTRIBUTION); return verification([
      { check: 'subject emits explicit false testimony', passed: content.includes("subjectClaim: 'all-inputs-readable'") },
      { check: 'independent blind field is falsely empty', passed: content.includes('S3 adapter P2') && content.includes('blind: []') },
    ]); },
  },
  {
    id: 'p3a-delete', property: 'P3', violationClass: 'guard removal', label: 'DELETE', paths: [GUARD],
    apply(root) { fs.unlinkSync(absolute(root, GUARD)); },
    verify(root) { return verification([{ check: `${GUARD} is absent`, passed: !fs.existsSync(absolute(root, GUARD)) }]); },
  },
  {
    id: 'p3b-comment-out', property: 'P3', violationClass: 'guard removal', label: 'COMMENT OUT', paths: [GUARD],
    apply(root) { write(root, GUARD, read(root, GUARD).split('\n').map((line) => `// ${line}`).join('\n')); },
    verify(root) { const lines = read(root, GUARD).split('\n').filter(Boolean); return verification([{ check: 'guard has no executable lines', passed: lines.length > 0 && lines.every((line) => line.startsWith('// ')) }]); },
  },
  {
    id: 'p3c-superstring-rename', property: 'P3', violationClass: 'guard removal', label: 'SUPERSTRING RENAME', paths: [GUARD],
    apply(root) { write(root, GUARD, read(root, GUARD).replaceAll('evaluateBlindInputCoverage', 'evaluateBlindInputCoverageDisabled')); },
    verify(root) { const content = read(root, GUARD); return verification([
      { check: 'longer symbol exists', passed: content.includes('evaluateBlindInputCoverageDisabled') },
      { check: 'standalone original is absent', passed: !/\bevaluateBlindInputCoverage\b/.test(content) },
    ]); },
  },
  {
    id: 'p3d-type-preserving-hollow', property: 'P3', violationClass: 'guard removal', label: 'TYPE-PRESERVING HOLLOW', paths: [GUARD], marker: 'S3 adapter P3d',
    apply(root) {
      replaceFunctionBody(root, GUARD, /export function evaluateBlindInputCoverage\(\{ population, coverageIds, maxUncovered \}\) \{/g,
        "  // S3 adapter P3d: exact signature/shape retained, constant passing lie.\n  return { passed: true, reason: 'within-ratchet', populationCount: population.length, coveredCount: coverageIds.length, uncovered: [], maxUncovered };");
    },
    verify(root) { const content = read(root, GUARD); return verification([
      { check: 'exact exported evaluator signature remains', passed: content.includes('export function evaluateBlindInputCoverage({ population, coverageIds, maxUncovered }) {') },
      { check: 'constant passing body is present', passed: content.includes('S3 adapter P3d') && content.includes('passed: true') },
    ]); },
  },
  {
    id: 'p4a-empty-population', property: 'P4', violationClass: 'vacuous measurement', label: 'EMPTY THE POPULATION', paths: [GUARD], marker: 'S3 adapter P4a',
    apply(root) {
      replaceFunctionBody(root, GUARD, /export function deriveCheckerPopulation\(root\) \{/g,
        '  // S3 adapter P4a: enumeration is forced to the empty set.\n  void root;\n  return [];');
    },
    verify(root) { const content = read(root, GUARD); return verification([{ check: 'enumerator is forced empty', passed: content.includes('S3 adapter P4a') && content.includes('return [];') }]); },
  },
  {
    id: 'p4b-planted-nested-checker', property: 'P4', violationClass: 'population evasion', label: 'PLANT A NESTED CHECKER', paths: [PLANTED],
    apply(root) { write(root, PLANTED, 'export const s3PlantedChecker = true;\n'); },
    verify(root) { return verification([{ check: 'nested production checker exists', passed: fs.existsSync(absolute(root, PLANTED)) && read(root, PLANTED).includes('s3PlantedChecker') }]); },
  },
  {
    id: 'p5-blind-production-checker', property: 'P5', violationClass: 'blind input / fail-open', label: 'BLIND A POPULATION MEMBER', paths: [ATTRIBUTION],
    apply(root) { fs.chmodSync(absolute(root, ATTRIBUTION), 0o000); },
    verify(root) { const mode = fs.statSync(absolute(root, ATTRIBUTION)).mode & 0o777; return verification([{ check: `${ATTRIBUTION} mode is 000`, passed: mode === 0 }]); },
  },
];

export function applyDeliberatelyHollowGuard(root) {
  const hollow = "import { describe, expect, it } from 'vitest';\ndescribe('S3 deliberately hollow guard', () => { it('asserts no behavior', () => expect(true).toBe(true)); });\n";
  write(root, GUARD_TEST, hollow);
  return { paths: [GUARD_TEST], verify() { return verification([{ check: 'guard suite is deliberately hollow', passed: read(root, GUARD_TEST).includes('S3 deliberately hollow guard') }]); } };
}
