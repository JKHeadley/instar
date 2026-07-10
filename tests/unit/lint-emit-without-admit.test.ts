/**
 * Tier-3 — the emit-without-admit usage-scan lint (companion §9; spec
 * SEC5-1/ADV5-8, SEC6-4/ADV6-4, SEC8-1/ADV8-3, SEC9-1, INT9-2).
 *
 * Drives the exported pure evaluator over fixture file sets: helper-file
 * import of an exempt handle; marker-less admit; duplicate marker; a second
 * file declaring an existing marker id; raw-string admit; dynamic controller
 * id; principal API outside the enumerated allowlist; handle exported /
 * passed as a value; raw inline target expressions. Also asserts the REAL
 * repo passes clean (the shipped retrofit sites satisfy every rule).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateEmitWithoutAdmit,
  loadRegistryBindings,
  SELF_SCOPE_ALLOWLIST,
  PRINCIPAL_SURFACE_ALLOWLIST,
  CONTROLLER_FILE_ALLOWLIST,
  // eslint-disable-next-line import/no-relative-packages
} from '../../scripts/lint-emit-without-admit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTRY_FIXTURE = `
  const a = {
    id: 'age-kill-backoff',
    modelsPath: 'src/core/SessionManager.ts',
  };
  const b = {
    id: 'external-hog-kill-breaker',
    modelsPath: 'src/monitoring/ExternalHogSentinel.ts',
  };
`;

function run(files: Record<string, string>, over: Record<string, unknown> = {}) {
  return evaluateEmitWithoutAdmit({
    files: Object.keys(files),
    registrySource: REGISTRY_FIXTURE,
    readFile: (rel: string) => files[rel] ?? null,
    ...over,
  });
}

const GOOD_MINT = `
import { governor, consumeAdmissionToken } from '../monitoring/selfaction/governor.js';
/* @self-action-controller: age-kill-backoff */
const gov = governor.for('age-kill-backoff');
export function deriveTargetKey(id: string) { return { key: id, classId: 'session', keyIsVolatile: false }; }
export function fire(id: string) {
  const t = deriveTargetKey(id);
  const a = gov.admitSync(t);
  return a;
}
`;

describe('lint-emit-without-admit — fixture rules', () => {
  it('a licensed marker file minting + admitting via deriveTargetKey passes', () => {
    const { violations } = run({ 'src/core/SessionManager.ts': GOOD_MINT });
    expect(violations).toEqual([]);
  });

  it('governor.for() in a file with NO matching marker fails (mint-without-marker)', () => {
    const { violations } = run({
      'src/core/SessionManager.ts': GOOD_MINT.replace('/* @self-action-controller: age-kill-backoff */', ''),
    });
    expect(violations.some((v) => v.rule === 'mint-without-marker')).toBe(true);
  });

  it('a COPY-PASTED second file declaring an existing marker id fails (unlicensed)', () => {
    const { violations } = run({
      'src/core/SessionManager.ts': GOOD_MINT,
      'src/core/RogueCopy.ts': GOOD_MINT,
    });
    expect(violations.some((v) => v.file === 'src/core/RogueCopy.ts' && v.rule === 'unlicensed-marker')).toBe(true);
    expect(violations.some((v) => v.file === 'src/core/RogueCopy.ts' && v.rule === 'unlicensed-mint')).toBe(true);
  });

  it('the same marker id declared twice in ONE file fails (duplicate-marker)', () => {
    const { violations } = run({
      'src/core/SessionManager.ts':
        '/* @self-action-controller: age-kill-backoff */\n' + GOOD_MINT,
    });
    expect(violations.some((v) => v.rule === 'duplicate-marker')).toBe(true);
  });

  it('a DYNAMIC controller id at governor.for() fails (the id is bound at registration, never caller-chosen)', () => {
    const { violations } = run({
      'src/core/SessionManager.ts': GOOD_MINT.replace("governor.for('age-kill-backoff')", 'governor.for(someVariable)'),
    });
    expect(violations.some((v) => v.rule === 'dynamic-controller-id')).toBe(true);
  });

  it('raw string-keyed governor.admit() at an emit site fails', () => {
    const { violations } = run({
      'src/core/SessionManager.ts': GOOD_MINT + "\nconst x = governor.admitSync({ key: 'k', classId: 'c', keyIsVolatile: false });\n",
    });
    expect(violations.some((v) => v.rule === 'raw-string-admit')).toBe(true);
  });

  it('a rogue HELPER FILE importing the governor handle surface with no marker fails (SEC8-1/ADV8-3)', () => {
    const { violations } = run({
      'src/core/SessionManager.ts': GOOD_MINT,
      'src/helpers/sneaky.ts': "import { governor } from '../monitoring/selfaction/governor.js';\nexport const g = governor;\n",
    });
    expect(violations.some((v) => v.file === 'src/helpers/sneaky.ts' && v.rule === 'handle-import-without-marker')).toBe(true);
  });

  it('EXPORTING a minted handle (or passing it as a value) fails (SEC9-1 widening)', () => {
    const leaky = GOOD_MINT + '\nexport const leaked = gov;\n';
    const { violations } = run({ 'src/core/SessionManager.ts': leaky });
    expect(violations.some((v) => v.rule === 'handle-leak')).toBe(true);

    const passed = GOOD_MINT + '\nsomeSink(gov);\n';
    const { violations: v2 } = run({ 'src/core/SessionManager.ts': passed });
    expect(v2.some((v) => v.rule === 'handle-leak')).toBe(true);
  });

  it('an admit whose target is a RAW INLINE expression (not deriveTargetKey) fails the granularity binding', () => {
    const raw = `
import { governor } from '../monitoring/selfaction/governor.js';
/* @self-action-controller: age-kill-backoff */
const gov = governor.for('age-kill-backoff');
export function fire(pid: number) {
  return gov.admitSync({ key: 'pid:' + pid, classId: 'session', keyIsVolatile: false });
}
`;
    const { violations } = run({ 'src/core/SessionManager.ts': raw });
    expect(violations.some((v) => v.rule === 'raw-target-expression')).toBe(true);
  });

  it('principalAdmit / the origin:\'principal\' literal outside the enumerated surfaces fails (FD13)', () => {
    const { violations } = run({
      'src/core/Sneaky.ts': "import { governor } from '../monitoring/selfaction/governor.js';\n/* @self-action-controller: age-kill-backoff */\nconst x = () => governor.principalAdmit('dashboard-pin-session', { actionVerb: 'kill' });\n",
    });
    expect(violations.some((v) => v.rule === 'principal-outside-allowlist')).toBe(true);

    const { violations: v2 } = run({
      'src/core/Sneaky2.ts': "const opts = { origin: 'principal' };\n",
    });
    expect(v2.some((v) => v.rule === 'principal-outside-allowlist')).toBe(true);
  });

  it('a controller with NO registry modelsPath binding and no allowlist fails (unbound-controller)', () => {
    const unbound = GOOD_MINT.replaceAll('age-kill-backoff', 'never-registered-controller');
    const { violations } = run({ 'src/core/SessionManager.ts': unbound });
    expect(violations.some((v) => v.rule === 'unbound-controller')).toBe(true);
  });

  it('a legitimately MULTI-FILE controller passes via the per-controller file allowlist', () => {
    const scanTick = GOOD_MINT
      .replaceAll('age-kill-backoff', 'external-hog-kill-breaker');
    const { violations } = run({ 'src/monitoring/ExternalHogScanTick.ts': scanTick });
    expect(violations).toEqual([]);
  });
});

describe('lint-emit-without-admit — registry bindings + the REAL repo', () => {
  it('loadRegistryBindings parses id ↔ modelsPath pairs from the real registry', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'testing', 'selfActionRegistry.ts'), 'utf-8');
    const bindings = loadRegistryBindings(src);
    expect(bindings.get('age-kill-backoff')).toBe('src/core/SessionManager.ts');
    expect(bindings.get('proactive-swap-monitor')).toBe('src/core/ProactiveSwapMonitor.ts');
    expect(bindings.get('promise-beacon-notify')).toBe('src/monitoring/PromiseBeacon.ts');
    expect(bindings.get('liveness-heartbeat')).toBe('src/monitoring/PromiseBeacon.ts');
    expect(bindings.get('external-hog-kill-breaker')).toBe('src/monitoring/ExternalHogSentinel.ts');
  });

  it('the REAL src/ tree passes the lint clean (every retrofit site satisfies every rule)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) files.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    const registrySource = fs.readFileSync(path.join(ROOT, 'src', 'testing', 'selfActionRegistry.ts'), 'utf-8');
    const { violations, considered } = evaluateEmitWithoutAdmit({
      files,
      registrySource,
      readFile: (rel: string) => {
        try {
          return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
        } catch {
          return null;
        }
      },
    });
    expect(considered).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });

  it('the self-scope + principal allowlists are the enumerated sets the companion pins (INT9-2)', () => {
    expect(SELF_SCOPE_ALLOWLIST.has('src/monitoring/selfaction/governor.ts')).toBe(true);
    expect(SELF_SCOPE_ALLOWLIST.has('src/testing/selfActionRegistry.ts')).toBe(true);
    expect(PRINCIPAL_SURFACE_ALLOWLIST.has('src/server/routes.ts')).toBe(true);
    expect(CONTROLLER_FILE_ALLOWLIST['external-hog-kill-breaker']).toContain('src/monitoring/ExternalHogScanTick.ts');
  });
});
