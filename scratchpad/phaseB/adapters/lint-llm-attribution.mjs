import fs from 'node:fs';
import {
  absolute,
  checksResult,
  commentAll,
  includesChecks,
  read,
  replaceOnce,
  replaceThroughMarker,
  run,
  structuredRelevance,
  write,
  writeVitestConfig,
} from './acceptance-fixtures.mjs';

const GUARD_TEST = 'tests/unit/llm-attribution-ratchet.test.ts';
const LINTER = 'scripts/lint-llm-attribution.js';
const DIRECT_INPUT = 'src/__b0_4_attribution_input.txt';
const HIDDEN_VIOLATION = 'src/core/B0FourUnattributedFunnel.ts';

const testCommand = {
  argv: ['node_modules/.bin/vitest', 'run', GUARD_TEST, '--config=.b0-fix-verifier.vitest.config.mjs', '--reporter=verbose'],
  observeAny: ['lint self-test', 'Test Files', 'No test files found', 'AssertionError'],
  timeoutMs: 120_000,
};

const directDriver = `import path from 'node:path'; import { runLint } from './scripts/lint-llm-attribution.js'; const result = runLint([path.resolve('${DIRECT_INPUT}')]); console.log('B0.4-attribution-direct real=' + result.real.length + ' stale=' + result.stale.length); if (result.real.length || result.stale.length) process.exit(1);`;
const directCommand = {
  argv: ['node', '--input-type=module', '-e', directDriver],
  observeAny: ['B0.4-attribution-direct'],
  timeoutMs: 30_000,
};

export const pipelineCommands = [testCommand, directCommand];
export const guardCommands = [testCommand, directCommand];

export function prepareWorkspace(root) {
  writeVitestConfig(root);
  write(root, DIRECT_INPUT, `await provider.evaluate(prompt, { attribution: { component: 'B0FourControl' } });\n`);
}

function verifySemanticViolation(root, rel) {
  const program = `import fs from 'node:fs'; import { checkFileText } from './${LINTER}'; const text = fs.readFileSync(${JSON.stringify(rel)}, 'utf8'); const hits = checkFileText(${JSON.stringify(rel)}, text); console.log('actualPath=' + ${JSON.stringify(rel)} + ' hits=' + hits.length); if (hits.length !== 1 || hits[0]?.file !== ${JSON.stringify(rel)}) process.exit(1);`;
  return run(root, ['node', '--input-type=module', '-e', program]);
}

function verifyRealEnumerationEscape(root) {
  const program = `import path from 'node:path'; import fs from 'node:fs'; import { FUNNEL_FILES, checkFileText, runLint } from './${LINTER}'; const rel = ${JSON.stringify(HIDDEN_VIOLATION)}; const text = fs.readFileSync(rel, 'utf8'); const raw = checkFileText(rel, text); const lint = runLint([path.resolve(rel)]); const exempt = FUNNEL_FILES.has(rel); console.log('actualPath=' + rel + ' rawHits=' + raw.length + ' real=' + lint.real.length + ' exempt=' + exempt); if (raw.length !== 1 || raw[0]?.file !== rel || lint.real.length !== 0 || !exempt) process.exit(1);`;
  return run(root, ['node', '--input-type=module', '-e', program]);
}

function inspectUnreadableViolation(root) {
  const target = absolute(root, DIRECT_INPUT);
  const mode = fs.statSync(target).mode % 0o1000;
  try {
    fs.chmodSync(target, 0o600);
    return verifySemanticViolation(root, DIRECT_INPUT);
  } finally {
    fs.chmodSync(target, mode);
  }
}

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);
  if (mutation.id === 'p4b-hidden-real-violation') {
    const semantic = fs.existsSync(absolute(root, HIDDEN_VIOLATION))
      ? verifyRealEnumerationEscape(root)
      : { exitCode: null, stdout: '', stderr: 'missing' };
    const relevance = structuredRelevance('outside-enumeration', [
      { check: 'violation is an actual in-src TypeScript path', passed: changedPaths.includes(HIDDEN_VIOLATION) && HIDDEN_VIOLATION.startsWith('src/') && !declared.has(HIDDEN_VIOLATION) },
      { check: 'real exemption surface changed in the declared linter subject', passed: changedPaths.includes(LINTER) && declared.has(LINTER) && read(root, LINTER).includes(`'${HIDDEN_VIOLATION}'`) },
      { check: 'the real checker classifies the actual path as one violation and runLint hides that same path through FUNNEL_FILES', passed: semantic.exitCode === 0 && semantic.stdout.includes(`actualPath=${HIDDEN_VIOLATION} rawHits=1 real=0 exempt=true`) },
    ]);
    return {
      ...relevance,
      decidingOutput: {
        kind: 'actual-path-enumeration-proof',
        lines: semantic.stdout.split('\n').filter(Boolean),
        exitCode: semantic.exitCode,
      },
    };
  }

  const routed = changedPaths.some((rel) => declared.has(rel)) || mutation.id === 'p5-blind-input';
  let semantic = false;
  if (mutation.id === 'p1-symbol-preserving-hollow') semantic = read(root, LINTER).includes('B0.4 hollow checkFileText');
  if (mutation.id === 'p2-subject-self-reports-clean') semantic = read(root, LINTER).includes('B0.4 forced clean lint testimony');
  if (mutation.id === 'p3a-delete') semantic = !fs.existsSync(absolute(root, GUARD_TEST));
  if (mutation.id === 'p3b-comment-out') semantic = read(root, GUARD_TEST).split('\n').filter(Boolean).every((line) => line.startsWith('// '));
  if (mutation.id === 'p3c-superstring-rename') semantic = read(root, GUARD_TEST).includes('const flagDisabled =') && !read(root, GUARD_TEST).includes('const flag =');
  if (mutation.id === 'p3d-type-preserving-hollow') semantic = read(root, GUARD_TEST).includes('B0.4 type-preserving hollow flag');
  if (mutation.id === 'p4a-empty-population') semantic = read(root, GUARD_TEST).includes('B0.4 empty source population');
  if (mutation.id === 'p5-blind-input') {
    const mode = fs.statSync(absolute(root, DIRECT_INPUT)).mode % 0o1000;
    const semanticViolation = inspectUnreadableViolation(root);
    const childRead = run(root, ['node', '-e', `require('node:fs').readFileSync(${JSON.stringify(DIRECT_INPUT)}, 'utf8')`]);
    semantic = changedPaths.includes(DIRECT_INPUT) && mode === 0 && semanticViolation.exitCode === 0 && semanticViolation.stdout.includes('hits=1') && childRead.exitCode !== 0 && /EACCES|permission denied/i.test(`${childRead.stderr}${childRead.stdout}`);
  }
  return structuredRelevance('declared-load-bearing-input', [
    { check: 'mutation routes to the declared guard/subject or the explicitly scanned generated input', passed: routed },
    { check: `semantic mutation ${mutation.id} changes the load-bearing body/input`, passed: semantic },
  ]);
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-hollow', property: 'P1', violationClass: 'hollowing', label: 'SYMBOL-PRESERVING HOLLOW', paths: [LINTER],
    apply(root) {
      replaceThroughMarker(
        root,
        LINTER,
        'export function checkFileText(rel, rawText) {',
        '\n\nfunction walk(',
        `export function checkFileText(rel, rawText) {\n  // B0.4 hollow checkFileText: same export/name/signature; no inspection.\n  void rel;\n  void rawText;\n  return [];\n}`,
      );
    },
    verify(root) { return includesChecks(root, LINTER, ['export function checkFileText(rel, rawText) {', 'B0.4 hollow checkFileText', 'return [];']); },
  },
  {
    id: 'p2-subject-self-reports-clean', property: 'P2', violationClass: 'self-report / false testimony', label: 'SUBJECT SELF-REPORTS CLEAN', paths: [LINTER],
    apply(root) {
      replaceThroughMarker(
        root,
        LINTER,
        'export function runLint(files, { allowlist = VIOLATIONS_ALLOWLIST, funnelFiles = FUNNEL_FILES, checkStale = false } = {}) {',
        '\n\nfunction main()',
        `export function runLint(files, { allowlist = VIOLATIONS_ALLOWLIST, funnelFiles = FUNNEL_FILES, checkStale = false } = {}) {\n  // B0.4 forced clean lint testimony: inputs are ignored and the subject claims zero findings.\n  void files;\n  void allowlist;\n  void funnelFiles;\n  void checkStale;\n  return { real: [], allowlisted: [], stale: [] };\n}`,
      );
    },
    verify(root) { return includesChecks(root, LINTER, ['B0.4 forced clean lint testimony', 'return { real: [], allowlisted: [], stale: [] };']); },
  },
  {
    id: 'p3a-delete', property: 'P3', violationClass: 'guard removal', label: 'DELETE', paths: [GUARD_TEST],
    apply(root) { fs.unlinkSync(absolute(root, GUARD_TEST)); },
    verify(root) { return checksResult([{ check: `${GUARD_TEST} is absent`, passed: !fs.existsSync(absolute(root, GUARD_TEST)) }]); },
  },
  {
    id: 'p3b-comment-out', property: 'P3', violationClass: 'guard removal', label: 'COMMENT OUT', paths: [GUARD_TEST],
    apply(root) { commentAll(root, GUARD_TEST); },
    verify(root) {
      const lines = read(root, GUARD_TEST).split('\n').filter(Boolean);
      return checksResult([{ check: `${GUARD_TEST} has no executable non-comment line`, passed: lines.length > 0 && lines.every((line) => line.startsWith('// ')) }]);
    },
  },
  {
    id: 'p3c-superstring-rename', property: 'P3', violationClass: 'guard removal', label: 'SUPERSTRING RENAME', paths: [GUARD_TEST],
    apply(root) { replaceOnce(root, GUARD_TEST, '  const flag = (text: string)', '  const flagDisabled = (text: string)'); },
    verify(root) {
      const text = read(root, GUARD_TEST);
      return checksResult([
        { check: 'longer flagDisabled declaration exists', passed: text.includes('const flagDisabled =') },
        { check: 'original flag remains a substring', passed: text.includes('flag') },
        { check: 'standalone flag declaration is absent while call sites remain', passed: !text.includes('const flag =') && /\bflag\(/.test(text) },
      ]);
    },
  },
  {
    id: 'p3d-type-preserving-hollow', property: 'P3', violationClass: 'guard removal', label: 'TYPE-PRESERVING HOLLOW', paths: [GUARD_TEST],
    apply(root) {
      replaceOnce(
        root,
        GUARD_TEST,
        "  const flag = (text: string) => checkFileText('src/fixture.ts', text);",
        "  const flag = (text: string) => { void text; /* B0.4 type-preserving hollow flag */ return [] as ReturnType<typeof checkFileText>; };",
      );
    },
    verify(root) { return includesChecks(root, GUARD_TEST, ['const flag = (text: string)', 'B0.4 type-preserving hollow flag', 'return [] as ReturnType<typeof checkFileText>;']); },
  },
  {
    id: 'p4a-empty-population', property: 'P4', violationClass: 'vacuous measurement', label: 'EMPTY THE POPULATION', paths: [GUARD_TEST],
    apply(root) {
      replaceThroughMarker(
        root,
        GUARD_TEST,
        'function walkSrc(): string[] {',
        '\n\ndescribe(',
        `function walkSrc(): string[] {\n  // B0.4 empty source population.\n  return [];\n}`,
      );
    },
    verify(root) { return includesChecks(root, GUARD_TEST, ['function walkSrc(): string[] {', 'B0.4 empty source population', 'return [];']); },
  },
  {
    id: 'p4b-hidden-real-violation', property: 'P4', violationClass: 'population evasion', label: 'REAL in-src VIOLATION HIDDEN BY FUNNEL_FILES EXEMPTION', paths: [HIDDEN_VIOLATION, LINTER],
    apply(root) {
      write(root, HIDDEN_VIOLATION, `export async function hiddenSpend(provider: { evaluate(prompt: string, options: { model: string }): Promise<unknown> }, prompt: string) {\n  return provider.evaluate(prompt, { model: 'fast' });\n}\n`);
      replaceOnce(
        root,
        LINTER,
        "  'src/core/TopicIntentCapture.ts',\n]);",
        `  'src/core/TopicIntentCapture.ts',\n  '${HIDDEN_VIOLATION}',\n]);`,
      );
    },
    verify(root) {
      const semantic = verifyRealEnumerationEscape(root);
      return checksResult([
        { check: `${HIDDEN_VIOLATION} is an actual in-src TypeScript file`, passed: HIDDEN_VIOLATION.startsWith('src/') && fs.existsSync(absolute(root, HIDDEN_VIOLATION)) },
        { check: `${HIDDEN_VIOLATION} is added to the real FUNNEL_FILES exemption`, passed: read(root, LINTER).includes(`'${HIDDEN_VIOLATION}'`) },
        { check: 'actual-path semantic proof shows rawHits=1 and real=0 through the exemption', passed: semantic.exitCode === 0 && semantic.stdout.includes(`actualPath=${HIDDEN_VIOLATION} rawHits=1 real=0 exempt=true`) },
      ]);
    },
  },
  {
    id: 'p5-blind-input', property: 'P5', violationClass: 'blind input / fail-open', label: 'UNREADABLE VIOLATING SCANNED INPUT', paths: [DIRECT_INPUT],
    apply(root) {
      write(root, DIRECT_INPUT, `await provider.evaluate(prompt, { model: 'fast' });\n`);
      const semantic = verifySemanticViolation(root, DIRECT_INPUT);
      if (semantic.exitCode !== 0 || !semantic.stdout.includes('hits=1')) throw new Error(`prepared input is not a real violation: ${semantic.stderr || semantic.stdout}`);
      fs.chmodSync(absolute(root, DIRECT_INPUT), 0o000);
    },
    verify(root) {
      const mode = fs.statSync(absolute(root, DIRECT_INPUT)).mode % 0o1000;
      const semanticViolation = inspectUnreadableViolation(root);
      const childRead = run(root, ['node', '-e', `require('node:fs').readFileSync(${JSON.stringify(DIRECT_INPUT)}, 'utf8')`]);
      return checksResult([
        { check: `${DIRECT_INPUT} mode is 000`, passed: mode === 0 },
        { check: 'temporarily readable bytes are classified as exactly one real attribution violation', passed: semanticViolation.exitCode === 0 && semanticViolation.stdout.includes('hits=1') },
        { check: 'independent child cannot read the scanned input', passed: childRead.exitCode !== 0 && /EACCES|permission denied/i.test(`${childRead.stderr}${childRead.stdout}`) },
      ]);
    },
  },
];
