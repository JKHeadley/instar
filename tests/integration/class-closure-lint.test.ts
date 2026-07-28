// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdirs.
/**
 * Integration (Tier 2) — drive scripts/class-closure-lint.mjs as a CHILD PROCESS
 * over temp fixture repos (docs/specs/class-closure-gate.md → Rollout step 1).
 *
 * Runs the REAL shipped lint (not a copy), scope-blind (no BASE_SHA/HEAD_SHA, so
 * no git repo is needed — the lint still grades every committed declaration, the
 * counting host). Covers BOTH sides of each decision boundary:
 *   (a) a good `guard` declaration → exit 0, cites a live guard;
 *   (b) a `guard` citation to a spec-only / nonexistent path → downgrade logged,
 *       STILL exit 0 in report-only (dryRun);
 *   (c) enabled + !dryRun + a malformed registry → exit NONZERO;
 *   (d) a novel class with full semantics → accepted (exit 0); one without →
 *       flagged (logged in report-only, exit NONZERO when enforcing);
 *   + repo-gate: no registry → skip, exit 0.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(process.cwd(), 'scripts', 'class-closure-lint.mjs');
const VALID_REGISTRY = path.join(process.cwd(), 'tests', 'fixtures', 'class-closure', 'registry-valid.json');
const MALFORMED_REGISTRY = path.join(process.cwd(), 'tests', 'fixtures', 'class-closure', 'registry-malformed.json');

const created: string[] = [];

afterEach(() => {
  while (created.length) {
    const d = created.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

interface RepoSpec {
  registry?: string | null; // fixture path to copy into docs/defect-classes.json, or null to omit
  config?: Record<string, unknown> | null;
  decisions?: Array<Record<string, unknown>>;
  files?: Record<string, string>; // relPath → content (cited guard files, etc.)
}

function makeRepo(spec: RepoSpec): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lint-'));
  created.push(root);
  if (spec.registry !== null && spec.registry !== undefined) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.copyFileSync(spec.registry, path.join(root, 'docs', 'defect-classes.json'));
  }
  if (spec.config) {
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(root, '.instar', 'config.json'), JSON.stringify(spec.config, null, 2));
  }
  if (spec.decisions && spec.decisions.length) {
    const dir = path.join(root, '.instar', 'instar-dev-decisions');
    fs.mkdirSync(dir, { recursive: true });
    spec.decisions.forEach((entry, i) => {
      const ts = entry.ts ?? `2026-07-03T00-00-0${i}-000Z`;
      fs.writeFileSync(path.join(dir, `${ts}-fixture-${i}.json`), JSON.stringify(entry, null, 2));
    });
  }
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function runLint(root: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('node', [SCRIPT], {
    cwd: root,
    env: { ...process.env, CLASS_CLOSURE_REPO_ROOT: root },
    encoding: 'utf-8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('class-closure-lint (child process)', () => {
  it('(a) a good guard declaration passes with exit 0', () => {
    const root = makeRepo({
      registry: VALID_REGISTRY,
      config: { prGate: { classClosure: { enabled: true, dryRun: true } } },
      files: { 'tests/live-guard.test.ts': 'export const guard = 1;\n' },
      decisions: [
        {
          ts: '2026-07-03T00-00-00-000Z',
          verdict: 'pass',
          classClosure: {
            defectClass: 'fixture-normal-class',
            closure: 'guard',
            guardEvidence: { enforcementType: 'ratchet', citation: 'tests/live-guard.test.ts', howCaught: 'the ratchet pins the baseline this defect regressed' },
            prNumber: 100,
            component: 'CompA',
          },
        },
      ],
    });
    const { status, stdout } = runLint(root);
    expect(status).toBe(0);
    expect(stdout).toContain('guard citation resolves (ratchet)');
    expect(stdout).toContain('OK (report-only');
  });

  it('(b) a guard citation to a spec-only / nonexistent path logs a downgrade but STILL exits 0 in dryRun', () => {
    const root = makeRepo({
      registry: VALID_REGISTRY,
      config: { prGate: { classClosure: { enabled: true, dryRun: true } } },
      files: { 'docs/specs/some-spec.md': '# spec\n' },
      decisions: [
        {
          ts: '2026-07-03T00-00-00-000Z',
          classClosure: {
            defectClass: 'fixture-normal-class',
            closure: 'guard',
            guardEvidence: { enforcementType: 'spec-only', citation: 'docs/specs/some-spec.md', howCaught: 'the spec describes the fix' },
            prNumber: 101,
            component: 'CompA',
          },
        },
        {
          ts: '2026-07-03T00-00-01-000Z',
          classClosure: {
            defectClass: 'fixture-normal-class',
            closure: 'guard',
            guardEvidence: { enforcementType: 'lint', citation: 'scripts/nonexistent.mjs', howCaught: 'a lint that is not on disk' },
            prNumber: 102,
            component: 'CompB',
          },
        },
      ],
    });
    const { status, stdout } = runLint(root);
    expect(status).toBe(0);
    expect(stdout).toContain('DOWNGRADE guard→gap');
    expect(stdout).toContain('does not resolve'); // the nonexistent path
    expect(stdout).toContain('not a live enforcing guard'); // the spec-only path
  });

  it('(c) enabled + !dryRun + a malformed registry exits nonzero', () => {
    const root = makeRepo({
      registry: MALFORMED_REGISTRY,
      config: { prGate: { classClosure: { enabled: true, dryRun: false } } },
      decisions: [],
    });
    const { status, stdout, stderr } = runLint(root);
    expect(status).not.toBe(0);
    expect(stdout).toContain('malformed registry');
    expect(stderr).toContain('FAIL');
  });

  it('(c-report-only) the SAME malformed registry in report-only mode still exits 0', () => {
    const root = makeRepo({
      registry: MALFORMED_REGISTRY,
      config: { prGate: { classClosure: { enabled: false, dryRun: true } } },
      decisions: [],
    });
    const { status, stdout } = runLint(root);
    expect(status).toBe(0);
    expect(stdout).toContain('malformed registry'); // still LOGGED, just not fatal
  });

  it('(d) a novel class with full semantics is accepted (exit 0)', () => {
    const root = makeRepo({
      registry: VALID_REGISTRY,
      config: { prGate: { classClosure: { enabled: true, dryRun: false } } },
      decisions: [
        {
          ts: '2026-07-03T00-00-00-000Z',
          classClosure: {
            defectClass: 'novel',
            closure: 'gap',
            gapItem: 'ACT-9001',
            prNumber: 200,
            component: 'CompNew',
            novelClass: {
              nearestExistingClass: 'fixture-normal-class',
              includes: ['a new inclusion criterion'],
              excludes: ['a new exclusion criterion'],
              severity: 'normal',
            },
          },
        },
      ],
    });
    const { status } = runLint(root);
    expect(status).toBe(0);
  });

  it('(d) a novel class WITHOUT semantics is flagged (nonzero when enforcing)', () => {
    const decisions = [
      {
        ts: '2026-07-03T00-00-00-000Z',
        classClosure: {
          defectClass: 'novel',
          closure: 'gap',
          gapItem: 'ACT-9002',
          prNumber: 201,
          component: 'CompNew',
          // novelClass omitted → no semantics
        },
      },
    ];
    // Enforcing → nonzero.
    const enforcing = makeRepo({ registry: VALID_REGISTRY, config: { prGate: { classClosure: { enabled: true, dryRun: false } } }, decisions });
    const rEnf = runLint(enforcing);
    expect(rEnf.status).not.toBe(0);
    expect(rEnf.stdout).toContain('novel class with no semantics');

    // Report-only → flagged in output but exit 0 (the other side of the boundary).
    const reportOnly = makeRepo({ registry: VALID_REGISTRY, config: { prGate: { classClosure: { enabled: false, dryRun: true } } }, decisions });
    const rRep = runLint(reportOnly);
    expect(rRep.status).toBe(0);
    expect(rRep.stdout).toContain('novel class with no semantics');
  });

  it('repo-gate: a checkout without docs/defect-classes.json skips + exits 0', () => {
    const root = makeRepo({ registry: null });
    const { status, stdout } = runLint(root);
    expect(status).toBe(0);
    expect(stdout).toContain('not an instar class-closure repo');
  });
});
