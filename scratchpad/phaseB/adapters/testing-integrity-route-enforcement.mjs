import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GUARD = 'scripts/lint-testing-integrity.mjs';
const HELPER = 'tests/helpers/testingIntegrity.ts';
const UNIT = 'tests/unit/scripts/testing-integrity-enforcement.test.ts';
const INTEGRATION = 'tests/integration/testing-integrity-pipeline.test.ts';
const E2E = 'tests/e2e/testing-integrity-guard-lifecycle.test.ts';
const PING_ROUTES = 'src/server/routes.ts';

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
function replaceOnce(root, rel, before, after) {
  const content = read(root, rel);
  const first = content.indexOf(before);
  if (first === -1 || first !== content.lastIndexOf(before)) throw new Error(`${rel}: replacement target missing or ambiguous`);
  write(root, rel, `${content.slice(0, first)}${after}${content.slice(first + before.length)}`);
}
function replaceThroughMarker(root, rel, signature, endMarker, replacement) {
  const content = read(root, rel);
  const start = content.indexOf(signature);
  if (start === -1 || content.indexOf(signature, start + signature.length) !== -1) throw new Error(`${rel}: function signature missing or ambiguous`);
  const end = content.indexOf(endMarker, start);
  if (end === -1) throw new Error(`${rel}: end marker missing`);
  write(root, rel, `${content.slice(0, start)}${replacement}${content.slice(end)}`);
}
function verifyIncludes(root, rel, included, excluded = []) {
  const content = read(root, rel);
  const checks = [
    ...included.map(value => ({ check: `${rel} includes ${JSON.stringify(value)}`, passed: content.includes(value) })),
    ...excluded.map(value => ({ check: `${rel} excludes ${JSON.stringify(value)}`, passed: !content.includes(value) })),
  ];
  return { ok: checks.every(item => item.passed), checks };
}

function relevance(mode, checks, extra = {}) {
  return {
    status: checks.every(item => item.passed) ? 'proven' : 'unknown',
    mode,
    checks,
    ...extra,
  };
}

function enumerateRoute(root, method, routePath, relativeFile) {
  const program = `
import { enumerateHttpRoutes } from './scripts/lint-testing-integrity.mjs';
const [root, method, routePath, relativeFile] = process.argv.slice(1);
const route = enumerateHttpRoutes({ root }).find((item) =>
  item.method === method && item.path === routePath && item.declarations.includes(relativeFile));
if (!route) process.exit(1);
process.stdout.write(JSON.stringify(route));
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', program, root, method, routePath, relativeFile], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function enumerateWhileBlind(root) {
  const program = `
import { enumerateHttpRoutes } from './scripts/lint-testing-integrity.mjs';
enumerateHttpRoutes({ root: process.argv[1] });
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', program, root], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

const guardDriver = `
const { spawnSync } = require('node:child_process');
const runs = [
  [process.execPath, ['scripts/lint-testing-integrity.mjs']],
  [process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/unit/scripts/testing-integrity-enforcement.test.ts',
    'tests/integration/testing-integrity-pipeline.test.ts',
    'tests/e2e/testing-integrity-guard-lifecycle.test.ts',
    '--config', 'vitest.push.config.ts', '--reporter=verbose']],
];
let failed = false;
for (const [command, args] of runs) {
  const run = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', env: process.env, timeout: 600000 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.error || run.status !== 0) failed = true;
}
console.log('[testing-integrity-adapter-driver] completed; failed=' + failed);
process.exitCode = failed ? 1 : 0;
`;

export const pipelineCommands = [{ argv: ['npm', 'run', 'lint'], observeAny: ['[testing-integrity]'], timeoutMs: 600_000 }];
export const guardCommands = [{ argv: [process.execPath, '-e', guardDriver], observeAny: ['testing-integrity'], timeoutMs: 1_200_000 }];

export function prepareWorkspace(root) {
  void root;
}

const alivePing = `  router.get('/ping', (_req, res) => {\n    res.json({ status: 'ok' });\n  });`;
const deadPing = `  router.get('/ping', (_req, res) => {\n    // B1.2 adapter: same route symbol and shape, behavior hollowed to dead-on-arrival.\n    res.status(503).json({ status: 'ok' });\n  });`;

export const mutations = [
  {
    id: 'p1-symbol-preserving-route-hollow', property: 'P1', violationClass: 'hollowing', label: 'SYMBOL-PRESERVING HOLLOW', paths: [PING_ROUTES],
    apply(root) { replaceOnce(root, PING_ROUTES, alivePing, deadPing); },
    verify(root) { return verifyIncludes(root, PING_ROUTES, ["router.get('/ping'", 'B1.2 adapter:', 'res.status(503)']); },
  },
  {
    id: 'p2-route-self-reports-clean', property: 'P2', violationClass: 'self-report / false testimony', label: 'SUBJECT SELF-REPORTS CLEAN', paths: [PING_ROUTES],
    apply(root) {
      replaceOnce(root, PING_ROUTES, alivePing, deadPing);
    },
    verify(root) {
      const route = verifyIncludes(root, PING_ROUTES, ['res.status(503)']);
      const helper = verifyIncludes(root, HELPER, [
        'expect(response.status).toBe(evidence.expectedStatus);',
        'expect(response.status).not.toBe(503);',
        'status: response.status,',
      ], ['subject suppresses the real status oracle']);
      return { ok: route.ok && helper.ok, checks: [...route.checks, ...helper.checks] };
    },
  },
  {
    id: 'p3a-delete', property: 'P3', violationClass: 'guard removal', label: 'DELETE', paths: [GUARD],
    apply(root) { fs.unlinkSync(absolute(root, GUARD)); },
    verify(root) { const passed = !fs.existsSync(absolute(root, GUARD)); return { ok: passed, checks: [{ check: `${GUARD} is absent`, passed }] }; },
  },
  {
    id: 'p3b-comment-out', property: 'P3', violationClass: 'guard removal', label: 'COMMENT OUT', paths: [GUARD],
    apply(root) { write(root, GUARD, read(root, GUARD).split('\n').map(line => `// ${line}`).join('\n')); },
    verify(root) { const lines = read(root, GUARD).split('\n').filter(Boolean); const passed = lines.length > 0 && lines.every(line => line.startsWith('// ')); return { ok: passed, checks: [{ check: `${GUARD} has no executable line`, passed }] }; },
  },
  {
    id: 'p3c-superstring-rename', property: 'P3', violationClass: 'guard removal', label: 'SUPERSTRING RENAME', paths: [GUARD],
    apply(root) { const content = read(root, GUARD); if (!/\benforceTestingIntegrity\b/.test(content)) throw new Error('key guard symbol missing'); write(root, GUARD, content.replaceAll('enforceTestingIntegrity', 'enforceTestingIntegrityDisabled')); },
    verify(root) { const content = read(root, GUARD); const checks = [{ check: 'longer symbol exists', passed: content.includes('enforceTestingIntegrityDisabled') }, { check: 'standalone original is absent', passed: !/\benforceTestingIntegrity\b/.test(content) }]; return { ok: checks.every(item => item.passed), checks }; },
  },
  {
    id: 'p3d-type-preserving-hollow', property: 'P3', violationClass: 'guard removal', label: 'TYPE-PRESERVING HOLLOW', paths: [GUARD],
    apply(root) { replaceThroughMarker(root, GUARD, 'export async function enforceTestingIntegrity(options = {}) {', '\nasync function main() {', `export async function enforceTestingIntegrity(options = {}) {\n  // B1.2 type-preserving hollow: same export/signature, constant passing verdict.\n  void options;\n  return { passed: true, populationCount: 1, changedRoutes: [], errors: [] };\n}\n`); },
    verify(root) { return verifyIncludes(root, GUARD, ['export async function enforceTestingIntegrity(options = {}) {', 'B1.2 type-preserving hollow', 'passed: true']); },
  },
  {
    id: 'p4a-empty-route-population', property: 'P4', violationClass: 'vacuous measurement', label: 'EMPTY THE POPULATION', paths: [GUARD],
    apply(root) { replaceOnce(root, GUARD, 'export function enumerateHttpRoutes({ root }) {\n  const sourceRoot', 'export function enumerateHttpRoutes({ root }) {\n  // B1.2 adapter: forced empty denominator.\n  void root;\n  return [];\n  const sourceRoot'); },
    verify(root) { return verifyIncludes(root, GUARD, ['B1.2 adapter: forced empty denominator', 'return [];']); },
  },
  {
    id: 'p4b-nested-route-evasion', property: 'P4', violationClass: 'population evasion', label: 'HIDE A REAL VIOLATION AT A NESTED SOURCE PATH', paths: ['src/phase-b/deep/nested/untested-route.ts'],
    apply(root) { write(root, this.paths[0], "import { Router } from 'express';\nconst router = Router();\nrouter.get('/phase-b-hidden', (_req, res) => res.status(200).end());\n"); },
    verify(root) { return verifyIncludes(root, this.paths[0], ["router.get('/phase-b-hidden'"]); },
  },
  {
    id: 'p5-blind-route-source', property: 'P5', violationClass: 'blind input / fail-open', label: 'BLIND THE GUARD', paths: [PING_ROUTES],
    apply(root) { fs.chmodSync(absolute(root, PING_ROUTES), 0o000); },
    verify(root) { const mode = fs.statSync(absolute(root, PING_ROUTES)).mode & 0o777; return { ok: mode === 0, checks: [{ check: `${PING_ROUTES} mode is 000`, passed: mode === 0 }] }; },
  },
];

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const guards = new Set(guardFiles);
  const subjects = new Set(subjectFiles);
  const declared = new Set([...guards, ...subjects]);

  if (mutation.id === 'p4b-nested-route-evasion') {
    const planted = mutation.paths[0];
    const routeProbe = enumerateRoute(root, 'GET', '/phase-b-hidden', planted);
    return relevance('outside-enumeration', [
      { check: 'planted route is outside the manifest-declared guard and subject paths', passed: changedPaths.includes(planted) && !declared.has(planted) },
      { check: 'planted source contains a real Express route declaration', passed: fs.existsSync(absolute(root, planted)) && read(root, planted).includes("router.get('/phase-b-hidden'") },
      { check: 'the live recursive production enumerator sees the exact planted route and source', passed: routeProbe.status === 0 && routeProbe.stdout.includes('"path":"/phase-b-hidden"') && routeProbe.stdout.includes(planted) },
    ], {
      decidingOutput: { kind: 'live-route-enumeration', exitCode: routeProbe.status, stdout: routeProbe.stdout, stderr: routeProbe.stderr },
    });
  }

  const checks = [];
  let semantic = false;

  if (mutation.id === 'p1-symbol-preserving-route-hollow') {
    const routeProbe = enumerateRoute(root, 'GET', '/ping', PING_ROUTES);
    checks.push(
      { check: 'only the real production route subject is mutated', passed: changedPaths.length === 1 && changedPaths[0] === PING_ROUTES && subjects.has(PING_ROUTES) },
      { check: 'the route symbol and response shape remain while behavior is dead', passed: read(root, PING_ROUTES).includes("router.get('/ping'") && read(root, PING_ROUTES).includes('res.status(503)') },
      { check: 'the live production enumerator still identifies GET /ping from the mutated subject', passed: routeProbe.status === 0 && routeProbe.stdout.includes('"path":"/ping"') && routeProbe.stdout.includes(PING_ROUTES) },
    );
    semantic = true;
  }

  if (mutation.id === 'p2-route-self-reports-clean') {
    const routeProbe = enumerateRoute(root, 'GET', '/ping', PING_ROUTES);
    checks.push(
      { check: 'P2 mutates only the production subject and never the external oracle', passed: changedPaths.length === 1 && changedPaths[0] === PING_ROUTES && subjects.has(PING_ROUTES) && !changedPaths.includes(HELPER) },
      { check: 'the evidence helper is guard-owned rather than subject-owned', passed: guards.has(HELPER) && !subjects.has(HELPER) },
      { check: 'subject falsely reports an ok body while returning dead status 503', passed: read(root, PING_ROUTES).includes("res.status(503).json({ status: 'ok' })") },
      { check: 'external oracle still asserts the observed response status and rejects 503', passed: read(root, HELPER).includes('expect(response.status).toBe(evidence.expectedStatus);') && read(root, HELPER).includes('expect(response.status).not.toBe(503);') && read(root, HELPER).includes('status: response.status,') },
      { check: 'the live production enumerator still identifies the self-reporting GET /ping subject', passed: routeProbe.status === 0 && routeProbe.stdout.includes('"path":"/ping"') && routeProbe.stdout.includes(PING_ROUTES) },
    );
    semantic = true;
  }

  if (mutation.id === 'p3a-delete') {
    checks.push({ check: 'declared guard entry point is deleted', passed: changedPaths.includes(GUARD) && guards.has(GUARD) && !fs.existsSync(absolute(root, GUARD)) });
    semantic = true;
  }
  if (mutation.id === 'p3b-comment-out') {
    const lines = read(root, GUARD).split('\n').filter(Boolean);
    checks.push({ check: 'declared guard entry point has no executable line', passed: changedPaths.includes(GUARD) && guards.has(GUARD) && lines.length > 0 && lines.every(line => line.startsWith('// ')) });
    semantic = true;
  }
  if (mutation.id === 'p3c-superstring-rename') {
    const content = read(root, GUARD);
    checks.push({ check: 'declared guard symbol is superstring-renamed away', passed: changedPaths.includes(GUARD) && guards.has(GUARD) && content.includes('enforceTestingIntegrityDisabled') && !/\benforceTestingIntegrity\b/.test(content) });
    semantic = true;
  }
  if (mutation.id === 'p3d-type-preserving-hollow') {
    const content = read(root, GUARD);
    checks.push({ check: 'declared guard keeps its export/signature but returns a constant passing verdict', passed: changedPaths.includes(GUARD) && guards.has(GUARD) && content.includes('export async function enforceTestingIntegrity(options = {}) {') && content.includes('B1.2 type-preserving hollow') && content.includes('passed: true') });
    semantic = true;
  }
  if (mutation.id === 'p4a-empty-route-population') {
    const content = read(root, GUARD);
    checks.push({ check: 'live route denominator is forced empty in the declared guard enumerator', passed: changedPaths.includes(GUARD) && guards.has(GUARD) && content.includes('B1.2 adapter: forced empty denominator') && content.includes('return [];') });
    semantic = true;
  }
  if (mutation.id === 'p5-blind-route-source') {
    const target = absolute(root, PING_ROUTES);
    const blindedMode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, 0o600);
    let routeProbe;
    try {
      routeProbe = enumerateRoute(root, 'GET', '/ping', PING_ROUTES);
    } finally {
      fs.chmodSync(target, blindedMode);
    }
    const blindProbe = enumerateWhileBlind(root);
    checks.push(
      { check: 'real production route subject is the blinded input', passed: changedPaths.includes(PING_ROUTES) && subjects.has(PING_ROUTES) && blindedMode === 0 },
      { check: 'the readable control proves this file supplies GET /ping to the live enumerator', passed: routeProbe.status === 0 && routeProbe.stdout.includes('"path":"/ping"') && routeProbe.stdout.includes(PING_ROUTES) },
      { check: 'the live enumerator cannot inspect the restored mode-000 source', passed: blindProbe.status !== 0 && /could not read[\s\S]*src\/server\/routes\.ts/i.test(`${blindProbe.stderr}${blindProbe.stdout}`) },
    );
    semantic = true;
  }

  if (!semantic) {
    checks.push({ check: `adapter recognizes mutation ${mutation.id}`, passed: false });
  }
  return relevance('declared-load-bearing-input', checks);
}

export function applyDeliberatelyHollowGuard(root) {
  const hollow = `import { describe, expect, it } from 'vitest';\ndescribe('deliberately hollow Testing Integrity guard', () => { it('asserts nothing about behavior', () => expect(true).toBe(true)); });\n`;
  for (const rel of [UNIT, INTEGRATION, E2E]) write(root, rel, hollow);
  return { paths: [UNIT, INTEGRATION, E2E], verify() { const checks = [UNIT, INTEGRATION, E2E].map(rel => ({ check: `${rel} is deliberately hollow`, passed: read(root, rel).includes('deliberately hollow Testing Integrity guard') })); return { ok: checks.every(item => item.passed), checks }; } };
}
