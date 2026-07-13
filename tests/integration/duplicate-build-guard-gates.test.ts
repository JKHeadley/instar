// safe-git-allow: test file — execFileSync('git', ...) builds the sandbox repo
//   fixtures (init, add). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests — the duplicate-build guard's two script gates
 * (spec docs/specs/duplicate-build-guard.md §3.4 + §4 integration tier).
 *
 * Runs the REAL scripts (copied into sandbox repos, spawned as git would spawn
 * them) and asserts the wiring, not stubs:
 *
 *  PRECOMMIT presence backstop (scripts/instar-dev-precommit.js):
 *   - refuses an in-scope commit whose trace lacks `duplicateBuildCheck` when
 *     the guard is live (env on, or the build-start stub exists);
 *   - ACCEPTS decision:"proceed" on a likely-duplicate (presence-only — the
 *     gate consumes the field but never gates on the verdict VALUE);
 *   - WARNS (never blocks) on the §3.4 `check-errored` auto-stub;
 *   - INSTAR_DUP_BUILD_CHECK=off no-ops; a pre-guard trace (env unset, no
 *     stub) is advisory only, never refused retroactively.
 *
 *  PRE-PUSH advisory (scripts/pre-push-gate.js):
 *   - an overlap verdict lands in warnings[] (⚠️, exit 0) and NEVER errors[];
 *   - honors INSTAR_PRE_PUSH_SKIP and INSTAR_DUP_BUILD_CHECK=off.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

interface RunResult { status: number | null; stdout: string; stderr: string; }

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/duplicate-build-guard-gates.test.ts:cleanup' });
    } catch { /* ignore */ }
  }
});

// ── Part A: precommit presence backstop ──────────────────────────────────────

describe('precommit presence backstop (§3.4)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-backstop-'));
    cleanups.push(sandbox);
    git(sandbox, ['init', '-q']);
    git(sandbox, ['config', 'user.email', 'test@example.com']);
    git(sandbox, ['config', 'user.name', 'test']);
    for (const d of ['scripts', 'docs/specs', 'upgrades/side-effects', '.instar/instar-dev-traces', 'src', 'skills/instar-dev/scripts']) {
      fs.mkdirSync(path.join(sandbox, d), { recursive: true });
    }
    // Stub the eli16 + promotion deps (same pattern as
    // tests/unit/instar-dev-precommit-sha-error.test.ts — the hook imports
    // them at module load; they are not what this test exercises).
    fs.writeFileSync(
      path.join(sandbox, 'scripts', 'eli16-overview-check.mjs'),
      `import path from 'node:path';\n` +
      `export const MIN_ELI16_CHARS = 800;\n` +
      `export function checkEli16Overview(specPath) {\n` +
      `  const eli16Path = path.join(path.dirname(specPath), path.basename(specPath, '.md') + '.eli16.md');\n` +
      `  return { ok: true, eli16Path, charCount: 9999, minChars: 1 };\n` +
      `}\n`,
    );
    fs.writeFileSync(
      path.join(sandbox, 'skills', 'instar-dev', 'scripts', 'verify-proposal-derived-runbook.mjs'),
      'export function verifyProposalDerivedRunbooks() { return { ok: true, reason: "ok" }; }\n',
    );
    // Copy the REAL hook + its lib deps.
    fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(sandbox, 'scripts', 'lib'), { recursive: true });
    for (const f of ['instar-dev-precommit.js', 'write-audit-convergence.mjs', 'audit-secret-patterns.mjs']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', f), path.join(sandbox, 'scripts', f));
    }
  });

  /** Stage a VALID Tier-1 bundle whose trace optionally carries duplicateBuildCheck. */
  function stageTier1(duplicateBuildCheck?: Record<string, unknown>): void {
    const srcRel = 'src/touched.ts';
    const eli16Rel = 'docs/specs/demo.eli16.md';
    const artifactRel = 'upgrades/side-effects/demo.md';
    fs.writeFileSync(path.join(sandbox, srcRel), 'export const touched = 1;\n');
    fs.writeFileSync(path.join(sandbox, eli16Rel), `# Demo overview\n\n${'plain words '.repeat(90)}\n`);
    const artifactBody = `# Side-effects review\n\n## Summary\n\n${'x'.repeat(400)}\n`;
    fs.writeFileSync(path.join(sandbox, artifactRel), artifactBody);
    const trace = {
      version: 2,
      sessionId: 'test',
      timestamp: new Date().toISOString(),
      artifactPath: artifactRel,
      artifactSha256: crypto.createHash('sha256').update(artifactBody).digest('hex'),
      coveredFiles: [srcRel],
      phase: 'complete',
      tier: 1,
      tierReasoning: 'tiny test change',
      eli16Path: eli16Rel,
      sideEffectsPath: artifactRel,
      secondPass: 'not-required',
      reviewerConcurred: null,
      ...(duplicateBuildCheck ? { duplicateBuildCheck } : {}),
    };
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-demo.json`),
      JSON.stringify(trace, null, 2),
    );
    git(sandbox, ['add', srcRel, eli16Rel, artifactRel]);
  }

  function runPrecommit(env: Record<string, string> = {}): RunResult {
    const res = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'instar-dev-precommit.js')], {
      cwd: sandbox,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('REFUSES a trace lacking duplicateBuildCheck when INSTAR_DUP_BUILD_CHECK=on', () => {
    stageTier1();
    const r = runPrecommit({ INSTAR_DUP_BUILD_CHECK: 'on' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('duplicateBuildCheck');
    expect(r.stderr).toContain('PRESENCE-ONLY');
  });

  it('REFUSES a missing field when the build-start stub exists (guard provably live, env unset)', () => {
    stageTier1();
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'dup-build-check.json'),
      JSON.stringify({ verdict: 'verify', cause: 'degraded', specSlug: 'demo' }),
    );
    const r = runPrecommit();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('duplicateBuildCheck');
  });

  it('ACCEPTS decision:"proceed" on a likely-duplicate (presence-only — never a value gate)', () => {
    stageTier1({
      verdict: 'likely-duplicate',
      cause: 'concurrency',
      decision: 'proceed',
      reason: 'EV-1 is my own resumed session',
      acknowledgedEvidenceIds: ['EV-1'],
    });
    const r = runPrecommit({ INSTAR_DUP_BUILD_CHECK: 'on' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('WARNS (never blocks) on the §3.4 check-errored auto-stub', () => {
    stageTier1({
      verdict: 'check-errored',
      cause: 'check-error',
      decision: 'proceed',
      reason: 'auto: check errored (fail-open)',
      acknowledgedEvidenceIds: [],
    });
    const r = runPrecommit({ INSTAR_DUP_BUILD_CHECK: 'on' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('DUPLICATE-BUILD CHECK ERRORED');
  });

  it('INSTAR_DUP_BUILD_CHECK=off no-ops the backstop even with the stub present', () => {
    stageTier1();
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'dup-build-check.json'),
      JSON.stringify({ verdict: 'likely-duplicate', specSlug: 'demo' }),
    );
    const r = runPrecommit({ INSTAR_DUP_BUILD_CHECK: 'off' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('Duplicate-build backstop');
  });

  it('a pre-guard trace (env unset, no stub) is ADVISORY only — never refused retroactively', () => {
    stageTier1();
    const r = runPrecommit();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('duplicate-build guard not live for this build');
  });
});

// ── Part A2: write-trace.mjs folds the stub into the trace ──────────────────

describe('write-trace.mjs duplicateBuildCheck fold (§3.4)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-writetrace-'));
    cleanups.push(sandbox);
    fs.mkdirSync(path.join(sandbox, 'skills', 'instar-dev', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, '.instar'), { recursive: true });
    // Copy the REAL trace writer — its ROOT resolves three dirs up from its
    // own location, i.e. the sandbox.
    fs.copyFileSync(
      path.join(REPO_ROOT, 'skills', 'instar-dev', 'scripts', 'write-trace.mjs'),
      path.join(sandbox, 'skills', 'instar-dev', 'scripts', 'write-trace.mjs'),
    );
    fs.writeFileSync(
      path.join(sandbox, 'upgrades', 'side-effects', 'demo.md'),
      `# Side-effects review\n\n${'x'.repeat(400)}\n`,
    );
  });

  function runWriteTrace(): string {
    const res = spawnSync(process.execPath, [
      path.join(sandbox, 'skills', 'instar-dev', 'scripts', 'write-trace.mjs'),
      '--artifact', 'upgrades/side-effects/demo.md',
      '--files', 'src/a.ts',
      '--spec', 'docs/specs/demo.md',
    ], { cwd: sandbox, encoding: 'utf-8' });
    expect(res.status, res.stderr).toBe(0);
    return path.join(sandbox, res.stdout.trim());
  }

  it('folds the stub (verdict + disposition) into trace.duplicateBuildCheck', () => {
    fs.writeFileSync(path.join(sandbox, '.instar', 'dup-build-check.json'), JSON.stringify({
      verdict: 'likely-duplicate',
      cause: 'concurrency',
      causes: ['concurrency'],
      specSlug: 'demo',
      checkedAt: '2026-07-12T00:00:00.000Z',
      evidence: [{ id: 'EV-1', source: 'open-pr', strength: 'strong', detail: 'x', prNumber: 1 }],
      disposition: { decision: 'proceed', reason: 'EV-1 reviewed — different subsystem', acknowledgedEvidenceIds: ['EV-1'] },
    }));
    const trace = JSON.parse(fs.readFileSync(runWriteTrace(), 'utf-8'));
    expect(trace.duplicateBuildCheck).toBeTruthy();
    expect(trace.duplicateBuildCheck.verdict).toBe('likely-duplicate');
    expect(trace.duplicateBuildCheck.cause).toBe('concurrency');
    expect(trace.duplicateBuildCheck.decision).toBe('proceed');
    expect(trace.duplicateBuildCheck.reason).toBe('EV-1 reviewed — different subsystem');
    expect(trace.duplicateBuildCheck.acknowledgedEvidenceIds).toEqual(['EV-1']);
  });

  it('omits the field when no stub exists (pre-guard traces round-trip unchanged)', () => {
    const trace = JSON.parse(fs.readFileSync(runWriteTrace(), 'utf-8'));
    expect(trace.duplicateBuildCheck).toBeUndefined();
  });

  it('an unreadable stub fails open (field omitted, trace still written)', () => {
    fs.writeFileSync(path.join(sandbox, '.instar', 'dup-build-check.json'), 'not json {{{');
    const trace = JSON.parse(fs.readFileSync(runWriteTrace(), 'utf-8'));
    expect(trace.duplicateBuildCheck).toBeUndefined();
  });
});

// ── Part B: pre-push advisory ────────────────────────────────────────────────

describe('pre-push advisory (FD1 — warnings[] only, never errors[])', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-prepush-'));
    cleanups.push(scratch);
    fs.mkdirSync(path.join(scratch, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'upgrades'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify({ name: 'instar-test', version: '0.28.999' }),
    );
    for (const f of [
      'pre-push-gate.js', 'upgrade-guide-validator.mjs', 'assemble-next-md.mjs',
      'release-relevant-paths.mjs', 'lint-no-direct-destructive.js', 'lint-no-direct-llm-http.js',
    ]) {
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', f), path.join(scratch, 'scripts', f));
    }
    // The dup advisory dynamically imports ./lib/duplicate-build-check.mjs —
    // copy the lib dir so the advisory actually RUNS (wiring integrity).
    fs.cpSync(path.join(REPO_ROOT, 'scripts', 'lib'), path.join(scratch, 'scripts', 'lib'), { recursive: true });
    // The destructive-lint the gate spawns lazily requires `typescript` for
    // AST parsing — resolve it via a node_modules link in the scratch repo.
    fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, 'node_modules')), path.join(scratch, 'node_modules'));
    // A well-formed NEXT.md (neutral wording → no Evidence/side-effects demands).
    fs.writeFileSync(
      path.join(scratch, 'upgrades', 'NEXT.md'),
      [
        '# Upgrade Guide — vNEXT',
        '',
        '<!-- bump: patch -->',
        '',
        '## What Changed',
        '',
        'A general improvement to the agent infrastructure.',
        '',
        '## What to Tell Your User',
        '',
        'Your agent got a small internal improvement. Nothing to do.',
        '',
        '## Summary of New Capabilities',
        '',
        '| Capability | How to Use |',
        '|-----------|-----------|',
        '| Internal polish | automatic |',
        '',
      ].join('\n'),
    );
    // A git repo whose branch carries an (untracked) substrate spec — the
    // state the advisory reads. No agent home resolvable in a tmpdir → the
    // ledger degrades → substrate spec → `verify` deterministically, no gh.
    git(scratch, ['init', '-q']);
    git(scratch, ['config', 'user.email', 'test@example.com']);
    git(scratch, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(scratch, 'base.txt'), 'base\n');
    git(scratch, ['add', 'base.txt', 'package.json', 'upgrades/NEXT.md']);
    git(scratch, ['commit', '-qm', 'init']);
    git(scratch, ['branch', '-M', 'main']);
    fs.mkdirSync(path.join(scratch, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'docs', 'specs', 'demo-guard.md'),
      '# Demo Guard\n\n## Problem statement\n\nWidget refresh is unrecorded.\n\n## Scope\n\nShip `src/data/provenanceCoverage.ts`.\n',
    );
  });

  function runGate(env: Record<string, string> = {}): RunResult {
    const res = spawnSync(process.execPath, [path.join(scratch, 'scripts', 'pre-push-gate.js')], {
      cwd: scratch,
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CI: '1', // skips the gh open-PR scan (§5) AND the CI-skipped artifact check
        ...env,
      },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it('an overlap verdict lands in warnings[] (⚠️) with exit 0 — NEVER errors[]', () => {
    const r = runGate();
    expect(r.status, r.stdout + r.stderr).toBe(0); // warnings never fail the push
    expect(r.stdout).toContain('Duplicate-build check: verify');
    expect(r.stdout).toContain('⚠️');
    expect(r.stdout).not.toContain('❌'); // nothing landed in errors[]
    expect(r.stdout).toContain('Advisory only (never blocks a push)');
  });

  it('honors INSTAR_PRE_PUSH_SKIP=1 (no duplicate-build output at all)', () => {
    const r = runGate({ INSTAR_PRE_PUSH_SKIP: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('Duplicate-build check');
  });

  it('honors INSTAR_DUP_BUILD_CHECK=off (master off-switch)', () => {
    const r = runGate({ INSTAR_DUP_BUILD_CHECK: 'off' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('Duplicate-build check');
  });

  it('the advisory source-wires warnings.push and never errors.push (structural)', () => {
    // Belt-and-suspenders alongside the behavioural checks above: the
    // duplicate-build section of the REAL gate must reference warnings.push
    // and must not push to errors[].
    const gate = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'pre-push-gate.js'), 'utf-8');
    const section = gate.slice(gate.indexOf('Duplicate-build advisory'), gate.indexOf('── Report ──'));
    expect(section.length).toBeGreaterThan(100);
    expect(section).toContain('warnings.push(');
    expect(section).not.toContain('errors.push(');
  });
});
