// safe-fs-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdirs.
/**
 * Integration (Tier 2) — the class-closure CI lint's self-action scope arm +
 * convergence-addressed check (docs/specs/self-action-convergence.md → E2/E6).
 * Drives the REAL exported runClassClosureLint over synthetic self-action diffs,
 * covering BOTH sides of each decision boundary:
 *   (a) a self-action controller diff + a good unbounded-self-action guard
 *       declaration (howCaught addresses convergence, citation resolves) → clean;
 *   (b) a self-action controller diff + NO declaration → hard violation
 *       (report-only exit 0; enforcing exit 1);
 *   (c) a self-action declaration whose howCaught is per-tick-cap-only → the
 *       convergence-addressed check flags a hard violation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClassClosureLint } from '../../scripts/class-closure-lint.mjs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const created: string[] = [];

afterEach(() => {
  while (created.length) {
    const d = created.pop()!;
    try {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/class-closure-lint-self-action.test.ts:afterEach' });
    } catch { /* best effort */ }
  }
});

interface FixtureSpec {
  decisions?: Array<Record<string, unknown>>;
  files?: Record<string, string>;
}

function makeRepo(spec: FixtureSpec): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sa-'));
  created.push(root);
  // Copy the REAL registry (carries the unbounded-self-action class).
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'docs', 'defect-classes.json'),
    path.join(root, 'docs', 'defect-classes.json'),
  );
  // The scripts/lib/defect-class-registry.mjs mirror is loaded from the running
  // process, not the fixture — no copy needed.
  if (spec.decisions?.length) {
    const dir = path.join(root, '.instar', 'instar-dev-decisions');
    fs.mkdirSync(dir, { recursive: true });
    spec.decisions.forEach((entry, i) => {
      fs.writeFileSync(path.join(dir, `2026-07-04T00-00-0${i}-000Z-fx-${i}.json`), JSON.stringify(entry, null, 2));
    });
  }
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const CONTROLLER_FILE = 'src/monitoring/DemoSwapMonitor.ts';
const REPORT_ONLY = { enabled: true, dryRun: true, escalatorDrafting: false };
const ENFORCING = { enabled: true, dryRun: false, escalatorDrafting: false };

function goodGuardDecl() {
  return {
    ts: '2026-07-04T00:00:00.000Z',
    slug: 'demo',
    classClosure: {
      defectClass: 'unbounded-self-action',
      closure: 'guard',
      prNumber: 9999,
      guardEvidence: {
        enforcementType: 'ratchet',
        citation: 'tests/unit/self-action-convergence.test.ts',
        howCaught: 'the ratchet drives the controller under sustained pressure and asserts the action count settles to a small bound (steady-state convergence via the all-hot brake), horizon-independent',
      },
    },
  };
}

describe('class-closure lint — self-action scope arm (E2/E6)', () => {
  it('(a) self-action controller diff + a good guard declaration → in scope, no hard violation', () => {
    const root = makeRepo({
      decisions: [goodGuardDecl()],
      files: { 'tests/unit/self-action-convergence.test.ts': '// the ratchet' },
    });
    const res = runClassClosureLint({ repoRoot: root, changedFiles: [CONTROLLER_FILE], config: REPORT_ONLY });
    expect(res.inScope).toBe(true);
    expect(res.hardViolations).toHaveLength(0);
    expect(res.exitCode).toBe(0);
  });

  it('(b) self-action controller diff + NO declaration → hard violation; report-only exit 0, enforcing exit 1', () => {
    const rootReport = makeRepo({ decisions: [] });
    const report = runClassClosureLint({ repoRoot: rootReport, changedFiles: [CONTROLLER_FILE], config: REPORT_ONLY });
    expect(report.inScope).toBe(true);
    expect(report.hardViolations.some((h) => /no unbounded-self-action/.test(h))).toBe(true);
    expect(report.exitCode).toBe(0); // report-only never fails the build

    const rootEnforce = makeRepo({ decisions: [] });
    const enforce = runClassClosureLint({ repoRoot: rootEnforce, changedFiles: [CONTROLLER_FILE], config: ENFORCING });
    expect(enforce.exitCode).toBe(1); // enforcing fails on the hard violation
  });

  it('(c) a per-tick-cap-only howCaught fails the convergence-addressed check', () => {
    const decl = goodGuardDecl();
    (decl.classClosure.guardEvidence as Record<string, unknown>).howCaught =
      'a per-tick cap limits how many run in a single pass';
    const root = makeRepo({
      decisions: [decl],
      files: { 'tests/unit/self-action-convergence.test.ts': '// the ratchet' },
    });
    const res = runClassClosureLint({ repoRoot: root, changedFiles: [CONTROLLER_FILE], config: ENFORCING });
    expect(res.hardViolations.some((h) => /convergence-addressed/.test(h))).toBe(true);
    expect(res.exitCode).toBe(1);
  });

  it('a NON-self-action agent-authored diff is unaffected by the new arm', () => {
    const root = makeRepo({ decisions: [] });
    // docs/STANDARDS-REGISTRY.md is agent-authored but not a self-action file.
    const res = runClassClosureLint({ repoRoot: root, changedFiles: ['docs/STANDARDS-REGISTRY.md'], config: ENFORCING });
    expect(res.inScope).toBe(true);
    // no self-action file → no unbounded-self-action hard violation
    expect(res.hardViolations.some((h) => /unbounded-self-action/.test(h))).toBe(false);
  });
});
