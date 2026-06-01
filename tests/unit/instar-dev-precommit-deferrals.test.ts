// safe-git-allow: test file — execFileSync('git', ...) builds the
//   sandbox repo fixture (init, add). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tests for the no-deferrals enforcement added to
 * scripts/instar-dev-precommit.js. The pre-commit hook scans the staged
 * spec for orphan deferral language and blocks the commit unless each
 * instance is linked to a tracked marker or the spec frontmatter waves
 * it through.
 *
 * Spec: docs/specs/auto-updater-lifeline-coordination.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'instar-dev-precommit.js');

interface RunResult { status: number | null; stdout: string; stderr: string; }

async function runHook(env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Run the SANDBOX copy of the hook so that __dirname resolves under the
    // sandbox (which has stubs + a fresh git repo). Running HOOK_SCRIPT
    // directly makes __dirname point at the worktree's real scripts/ dir
    // and the hook checks the worktree's staged files — which is a different
    // git repo from the sandbox we're testing.
    const sandboxHook = path.join(cwd, 'scripts', 'instar-dev-precommit.js');
    const proc = spawn('node', [sandboxHook], { env, cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', status => resolve({ status, stdout, stderr }));
    setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('hook timeout')); }, 15_000);
  });
}

describe('instar-dev pre-commit — orphan deferrals enforcement', () => {
  let sandbox: string;

  beforeEach(() => {
    // Sandbox is a tiny git repo with a copy of the hook + a fixture spec.
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'deferrals-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sandbox });
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'docs', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, '.instar', 'instar-dev-traces'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'skills', 'instar-dev', 'scripts'), { recursive: true });

    // Stub out the eli16 + promotion gate dependencies so we only exercise
    // the deferrals path. The eli16Path must be absolute and resolve under
    // the sandbox so the hook's "is-it-staged" check finds it.
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
      'export function verifyProposalDerivedRunbooks() { return { ok: true, reason: "no-proposal-derived-runbooks-or-all-verified" }; }\n',
    );

    // Copy the hook script under test + its new pure tier classifier dependency
    // (scripts/lib/classify-tier.mjs) into the sandbox.
    fs.mkdirSync(path.join(sandbox, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(path.dirname(HOOK_SCRIPT), 'lib', 'classify-tier.mjs'),
      path.join(sandbox, 'scripts', 'lib', 'classify-tier.mjs'),
    );
    fs.copyFileSync(HOOK_SCRIPT, path.join(sandbox, 'scripts', 'instar-dev-precommit.js'));
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: 'tests/unit/instar-dev-precommit-deferrals.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  function stageFixture(opts: {
    specFrontmatter: string;
    specBody: string;
    artifactBody?: string;
  }): { specPath: string; artifactPath: string; tracePath: string } {
    const specRel = path.join('docs', 'specs', 'fixture.md');
    const eli16Rel = path.join('docs', 'specs', 'fixture.eli16.md');
    const artifactRel = path.join('upgrades', 'side-effects', 'fixture.md');
    const traceRel = path.join('.instar', 'instar-dev-traces', `${Date.now()}-fixture.json`);

    fs.writeFileSync(
      path.join(sandbox, specRel),
      `---\n${opts.specFrontmatter}\n---\n\n${opts.specBody}\n`,
    );
    // ELI16 sibling — hook requires it to be staged with the spec.
    fs.writeFileSync(
      path.join(sandbox, eli16Rel),
      `# ELI16\n\n${'x'.repeat(400)}\n`,
    );

    const artifactBody = opts.artifactBody ??
      `# Side-effects review\n\n## Summary\n\n${'x'.repeat(400)}\n`;
    fs.writeFileSync(path.join(sandbox, artifactRel), artifactBody);

    const sha = crypto.createHash('sha256').update(artifactBody).digest('hex');

    // Add a benign staged file under src/ to satisfy the "in-scope" check.
    const srcRel = 'src/touched.ts';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');

    fs.writeFileSync(
      path.join(sandbox, traceRel),
      JSON.stringify({
        phase: 'complete',
        slug: 'fixture',
        coveredFiles: [srcRel],
        artifactPath: artifactRel,
        artifactSha256: sha,
        specPath: specRel,
        createdAt: new Date().toISOString(),
      }, null, 2),
    );

    execFileSync('git', ['add', srcRel, specRel, eli16Rel, artifactRel], { cwd: sandbox });
    return { specPath: specRel, artifactPath: artifactRel, tracePath: traceRel };
  }

  it('passes when spec contains no deferral language', async () => {
    stageFixture({
      specFrontmatter: 'title: Clean spec\napproved: true\nreview-convergence: tactical\neli16-overview: x.md',
      specBody: 'Everything is in scope and ships in this PR. Done.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
  });

  // ─── BACK-COMPAT REGRESSION GUARD (Step A — tier classifier) ──────────────
  // The named guard required by the spec's Testing section: an EXISTING-SHAPE
  // trace with NO `tier` field + an approved converged spec must pass EXACTLY
  // as before the tier classifier landed. The stageFixture() trace above writes
  // no `tier` field, so this is the canonical legacy shape; the gate must take
  // the full Tier-2 path (decideRequirementSet(null) → 'tier2-full') and the
  // additive Step-A change must NOT alter the outcome.
  it('BACK-COMPAT: a no-tier trace + approved converged spec passes the full Tier-2 path exactly as before', async () => {
    const { tracePath } = stageFixture({
      specFrontmatter: 'title: Legacy spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md',
      specBody: 'A normal, fully-in-scope change. No deferrals, no tier field.',
    });
    // Sanity-check the fixture really is the legacy shape (no tier declaration).
    const trace = JSON.parse(fs.readFileSync(path.join(sandbox, tracePath), 'utf-8'));
    expect(trace).not.toHaveProperty('tier');

    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
    // The pass message is the unchanged full-Tier-2 OK line (NOT the Tier-1 line).
    expect(result.stderr).toMatch(/OK — trace/);
    expect(result.stderr).not.toMatch(/OK \(Tier 1\)/);
    // And the converged + approved spec was actually checked (proves the full path ran).
    expect(result.stderr).toMatch(/converged \+ approved/);
  });

  // The audit JSON line must record riskFloor (the NUMBER), not just belowFloor,
  // so the decision record is self-contained for later review (convergence
  // Finding — audit field). The no-tier legacy fixture above touches only a
  // benign src/touched.ts, so riskFloor is 1.
  it('AUDIT: a commit appends one well-formed decisions.jsonl line including riskFloor (number)', async () => {
    stageFixture({
      specFrontmatter: 'title: Audit spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md',
      specBody: 'A normal change for audit-line shape verification.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);

    const auditPath = path.join(sandbox, '.instar', 'instar-dev-decisions.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toHaveProperty('riskFloor');
    expect(typeof entry.riskFloor).toBe('number');
    expect(entry.riskFloor).toBe(1); // benign src/touched.ts → no risk signals
    expect(entry).toHaveProperty('belowFloor');
    expect(entry.belowFloor).toBe(false); // no declared tier → never below floor
    expect(entry).toHaveProperty('suggestedTier');
    expect(Array.isArray(entry.riskFloorReasons)).toBe(true);
  });

  it('blocks when spec contains orphan "out of scope today"', async () => {
    stageFixture({
      specFrontmatter: 'title: Bad spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md',
      specBody: 'This is the plan. The other fix is out of scope today.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/orphan deferral/i);
    expect(result.stderr).toMatch(/out of scope today/i);
  });

  it('blocks on "deferred" without tracked marker', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: x.md',
      specBody: 'The runtime instrumentation is deferred for v2.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deferred/i);
  });

  it('allows "deferred" when followed by a tracked-marker comment within 200 chars', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: x.md',
      specBody:
        'The Remediator absorption is deferred until Tier-3 lands. ' +
        '<!-- tracked: topic-3079-v3-remediator -->',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
  });

  it('frontmatter "deferrals-tracked" is NO LONGER a wave-through (reviewer 2026-05-22 — loophole closed)', async () => {
    // Pre-fix: frontmatter `deferrals-tracked:` short-circuited the entire
    // body scan. A future author could write `deferrals-tracked: see below`
    // and ship orphan deferrals undetected. Post-fix: every body hit must
    // have its own inline tracker marker, regardless of frontmatter fields.
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md\ndeferrals-tracked: see below',
      specBody:
        'Everything in scope. The runtime instrumentation is deferred until Tier-3 lands.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deferred/i);
  });

  it('allows each body deferral that has its own inline tracker marker within 200 chars', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md',
      specBody:
        'Everything in scope. The runtime instrumentation is deferred until Tier-3 lands. <!-- tracked: topic-3079-v3-remediator --> ' +
        'A second follow-up exists. <!-- tracked: topic-3079-v3-remediator -->',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
  });

  it('honors INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1 override and logs the override', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: x.md',
      specBody: 'This bit is out of scope today.',
    });
    const env = { ...process.env, INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS: '1' };
    const result = await runHook(env, sandbox);
    expect(result.status).toBe(0);

    const logPath = path.join(sandbox, '.instar', 'instar-dev-traces', 'orphan-deferral-overrides.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/out of scope today/);
  });

  it('catches "not in this PR"', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: x.md',
      specBody: 'The full architecture work is NOT in this PR.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not in this pr/i);
  });

  it('catches "preemptive fix" without tracker', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: x.md',
      specBody: 'The preemptive fix lives elsewhere.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/preemptive fix/i);
  });

  it('does NOT false-alarm on "no deferrals" / "non-deferred" phrasing', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md',
      specBody:
        'This PR ships with no deferrals. All work is non-deferred and complete.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
  });

  it('blocks plural "deferrals" without tracker (reviewer broadening)', async () => {
    stageFixture({
      specFrontmatter: 'title: spec\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md',
      specBody:
        'Several deferrals exist in this scope.',
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deferrals/i);
  });
});
