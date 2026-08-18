import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  absolute,
  checksResult,
  commentAll,
  includesChecks,
  read,
  replaceOnce,
  replaceThroughMarker,
  structuredRelevance,
  write,
  writeVitestConfig,
} from './acceptance-fixtures.mjs';

const GUARD_TEST = 'tests/unit/self-action-convergence.test.ts';
const FORCING_LINT = 'scripts/lint-no-unregistered-self-action.js';
const REGISTRY = 'src/testing/selfActionRegistry.ts';
const HIDDEN_CONTROLLER = 'src/phaseB/B0FourHiddenSelfActionMonitor.ts';

const testCommand = {
  argv: ['node_modules/.bin/vitest', 'run', GUARD_TEST, '--config=.b0-fix-verifier.vitest.config.mjs', '--reporter=verbose'],
  observeAny: ['self-action convergence ratchet', 'Test Files', 'No test files found', 'AssertionError'],
  timeoutMs: 180_000,
};

const lintCommand = {
  argv: ['node', FORCING_LINT, '--staged'],
  observeAny: ['lint-no-unregistered-self-action:'],
  timeoutMs: 60_000,
};

const pipelineTestCommand = {
  argv: ['npm', 'run', 'test:push', '--', GUARD_TEST, '--reporter=verbose'],
  observeAny: ['self-action convergence ratchet', 'Test Files'],
  timeoutMs: 180_000,
};

const pipelineLintCommand = {
  argv: ['npm', 'run', 'lint'],
  observeAny: ['lint-no-unregistered-self-action:', 'lint-framework-list-completeness'],
  timeoutMs: 600_000,
};

export const pipelineCommands = [pipelineTestCommand, pipelineLintCommand];
export const guardCommands = [testCommand, lintCommand];

export function prepareWorkspace(root) {
  writeVitestConfig(root);
}

function replaceProactiveMethod(root, replacement) {
  replaceThroughMarker(
    root,
    REGISTRY,
    '  makeUnderPressure(f, sink) {',
    '\n  },\n};',
    replacement,
    'const proactiveSwapMonitor: SelfActionController = {',
  );
}

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);
  const routed = changedPaths.some((rel) => declared.has(rel));
  const checks = [];
  let mode = 'declared-load-bearing-input';

  if (mutation.id === 'p4b-hidden-real-violation') {
    mode = 'outside-enumeration';
    const text = fs.existsSync(absolute(root, HIDDEN_CONTROLLER)) ? read(root, HIDDEN_CONTROLLER) : '';
    const liveLint = spawnSync('node', [FORCING_LINT, '--staged'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    checks.push(
      { check: 'hidden controller is outside SELF_ACTION_CONTROLLERS registry source', passed: changedPaths.includes(HIDDEN_CONTROLLER) && !declared.has(HIDDEN_CONTROLLER) },
      { check: 'hidden source is controller-shaped and contains an executable self-action emit', passed: /SelfActionMonitor\.ts$/.test(HIDDEN_CONTROLLER) && /pool\.swap\(/.test(text) },
      { check: 'hidden controller has no registration marker', passed: !/@self-action-controller:/.test(text) },
      { check: 'pinned live lint sees the violation but remains report-only and exits zero', passed: liveLint.status === 0 && /report-only/.test(liveLint.stdout) && /1 unregistered/.test(liveLint.stdout) },
    );
    return {
      status: 'proven',
      mode,
      checks,
      reason: 'P4b relevance is proven: the real controller is detected by both live guards; their clean exits are the substantive not-proven result.',
      decidingOutput: {
        kind: 'live-report-only-path',
        lines: liveLint.stdout.split('\n').filter(Boolean),
        exitCode: liveLint.status,
      },
    };
  }

  checks.push({ check: 'changed path intersects the declared load-bearing guard/subject set', passed: routed });
  let semantic = false;
  if (mutation.id === 'p1-symbol-preserving-hollow') semantic = read(root, REGISTRY).includes('B0.4 inert proactive controller body');
  if (mutation.id === 'p2-subject-self-reports-clean') semantic = read(root, REGISTRY).includes('B0.4 false count testimony');
  if (mutation.id === 'p3a-delete') semantic = !fs.existsSync(absolute(root, GUARD_TEST));
  if (mutation.id === 'p3b-comment-out') semantic = fs.existsSync(absolute(root, GUARD_TEST)) && read(root, GUARD_TEST).split('\n').filter(Boolean).every((line) => line.startsWith('// '));
  if (mutation.id === 'p3c-superstring-rename') semantic = read(root, GUARD_TEST).includes('function driveControllerDisabled(') && !read(root, GUARD_TEST).includes('function driveController(');
  if (mutation.id === 'p3d-type-preserving-hollow') semantic = read(root, GUARD_TEST).includes('B0.4 type-preserving hollow driveController');
  if (mutation.id === 'p4a-empty-population') semantic = read(root, REGISTRY).includes('B0.4 empty controller population');
  if (mutation.id === 'p5-blind-input') semantic = fs.statSync(absolute(root, REGISTRY)).mode % 0o1000 === 0;
  checks.push({ check: `semantic mutation ${mutation.id} changed its load-bearing body/input`, passed: semantic });
  return structuredRelevance(mode, checks);
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-hollow', property: 'P1', violationClass: 'hollowing', label: 'SYMBOL-PRESERVING HOLLOW', paths: [REGISTRY],
    apply(root) {
      replaceProactiveMethod(root, `  makeUnderPressure(f, sink) {\n    // B0.4 inert proactive controller body: same id/API, no controller transition.\n    void f;\n    void sink;\n    return { tick() {} };`);
    },
    verify(root) {
      return includesChecks(root, REGISTRY, [
        "id: 'proactive-swap-monitor'",
        'makeUnderPressure(f, sink) {',
        'B0.4 inert proactive controller body',
        'return { tick() {} };',
      ]);
    },
  },
  {
    id: 'p2-subject-self-reports-clean', property: 'P2', violationClass: 'self-report / false testimony', label: 'SUBJECT SELF-REPORTS CLEAN', paths: [REGISTRY],
    apply(root) {
      replaceProactiveMethod(root, `  makeUnderPressure(f, sink) {\n    // B0.4 false count testimony: emit unboundedly, then lie through count.\n    void f;\n    return {\n      tick() {\n        sink.considered += 1;\n        sink.emit({ verb: 'account-swap', target: 'acct-A' });\n        sink.count = 0;\n      },\n    };`);
    },
    verify(root) {
      return includesChecks(root, REGISTRY, [
        'B0.4 false count testimony',
        "sink.emit({ verb: 'account-swap', target: 'acct-A' });",
        'sink.count = 0;',
      ]);
    },
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
    apply(root) { replaceOnce(root, GUARD_TEST, 'function driveController(', 'function driveControllerDisabled('); },
    verify(root) {
      const text = read(root, GUARD_TEST);
      return checksResult([
        { check: 'longer driveControllerDisabled declaration exists', passed: text.includes('function driveControllerDisabled(') },
        { check: 'original remains as a substring', passed: text.includes('driveController') },
        { check: 'original driveController declaration is absent while call sites remain', passed: !text.includes('function driveController(') && /\bdriveController\(/.test(text) },
      ]);
    },
  },
  {
    id: 'p3d-type-preserving-hollow', property: 'P3', violationClass: 'guard removal', label: 'TYPE-PRESERVING HOLLOW', paths: [GUARD_TEST],
    apply(root) {
      replaceThroughMarker(
        root,
        GUARD_TEST,
        'function driveController(',
        '\n\ndescribe(',
        `function driveController(\n  controller: (typeof SELF_ACTION_CONTROLLERS)[number],\n  ticks: number,\n): ReturnType<typeof makeActionSink> {\n  // B0.4 type-preserving hollow driveController: declaration/name/signature/return type retained.\n  void controller;\n  void ticks;\n  return { emit() {}, count: 0, perTarget: new Map(), considered: 0, emitTimesMs: [] };\n}`,
      );
    },
    verify(root) {
      return includesChecks(root, GUARD_TEST, [
        'function driveController(',
        '): ReturnType<typeof makeActionSink> {',
        'B0.4 type-preserving hollow driveController',
        'return { emit() {}, count: 0, perTarget: new Map(), considered: 0, emitTimesMs: [] };',
      ]);
    },
  },
  {
    id: 'p4a-empty-population', property: 'P4', violationClass: 'vacuous measurement', label: 'EMPTY THE POPULATION', paths: [REGISTRY],
    apply(root) {
      replaceThroughMarker(
        root,
        REGISTRY,
        'export const SELF_ACTION_CONTROLLERS: SelfActionController[] = [',
        '\n];',
        `export const SELF_ACTION_CONTROLLERS: SelfActionController[] = [\n  // B0.4 empty controller population.`,
      );
    },
    verify(root) {
      return includesChecks(root, REGISTRY, ['export const SELF_ACTION_CONTROLLERS: SelfActionController[] = [', 'B0.4 empty controller population']);
    },
  },
  {
    id: 'p4b-hidden-real-violation', property: 'P4', violationClass: 'population evasion', label: 'REAL UNREGISTERED CONTROLLER OUTSIDE THE REGISTRY', paths: [HIDDEN_CONTROLLER],
    apply(root) {
      write(root, HIDDEN_CONTROLLER, `export function startHiddenSelfActionMonitor(pool: { swap(id: string): void }): () => void {\n  const timer = setInterval(() => {\n    pool.swap('acct-A');\n  }, 1);\n  return () => clearInterval(timer);\n}\n`);
      const staged = spawnSync('git', ['add', '--', HIDDEN_CONTROLLER], { cwd: root, encoding: 'utf8' });
      if (staged.status !== 0) throw new Error(`git add hidden controller failed: ${staged.stderr || staged.stdout}`);
    },
    verify(root) {
      const content = includesChecks(root, HIDDEN_CONTROLLER, ['setInterval(', "pool.swap('acct-A')"], ['@self-action-controller:']);
      const staged = spawnSync('git', ['diff', '--cached', '--name-only', '--', HIDDEN_CONTROLLER], { cwd: root, encoding: 'utf8' });
      const checks = [...content.checks, { check: 'hidden controller is staged for --staged forcing lint', passed: staged.status === 0 && staged.stdout.trim() === HIDDEN_CONTROLLER }];
      return checksResult(checks);
    },
  },
  {
    id: 'p5-blind-input', property: 'P5', violationClass: 'blind input / fail-open', label: 'BLIND THE REGISTRY INPUT', paths: [REGISTRY],
    apply(root) { fs.chmodSync(absolute(root, REGISTRY), 0o000); },
    verify(root) {
      const mode = fs.statSync(absolute(root, REGISTRY)).mode % 0o1000;
      return checksResult([{ check: `${REGISTRY} mode is 000`, passed: mode === 0 }]);
    },
  },
];
