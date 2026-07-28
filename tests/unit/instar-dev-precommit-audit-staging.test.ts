// safe-git-allow: test file — execFileSync('git', ...) builds the sandbox repo
//   fixture (init, add, diff). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Decision-audit self-commit (task #62) + per-entry files (task #80).
 *
 * writeDecisionAudit runs inside the PRE-COMMIT hook, so its write always
 * landed AFTER staging — the audit record sat uncommitted in the building
 * worktree. One-PR worktrees never committed it; worktree reclaim deleted
 * it; the audit trail silently leaked ("the decision-audit didn't fire" —
 * it DID fire, the record just evaporated with the worktree). Fix #1 (#814):
 * stage the record right after writing so it rides the very commit it
 * describes.
 *
 * Fix #1 created a SECOND failure: because every gated PR then appended one
 * line to the SAME .instar/instar-dev-decisions.jsonl, any two PRs in
 * flight both modified that file's tail and CONFLICTED at the merge point
 * (live hit: PR #824 went CI-green, then failed admin-merge on exactly this
 * file). Fix #2 (this shape): each decision is its OWN file under
 * .instar/instar-dev-decisions/<ts>-<slug>.json — distinct paths per PR can
 * never conflict, including in GitHub's server-side merge. The legacy JSONL
 * is frozen history.
 *
 * These tests pin: (1) the audit ENTRY FILE is WRITTEN and STAGED for an
 * in-scope commit even when the gate then BLOCKS (the staged entry rides
 * the retry commit); (2) the staged content carries the evaluated slug;
 * (3) two sequential evaluations produce two DISTINCT files (the conflict
 * immunity property); (4) the frozen legacy JSONL is not appended to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'instar-dev-precommit.js');

interface RunResult { status: number | null; stdout: string; stderr: string; }

async function runHook(env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
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

describe('instar-dev pre-commit — decision-audit line rides the commit (self-staging)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-staging-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sandbox });
    fs.mkdirSync(path.join(sandbox, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'docs', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, '.instar', 'instar-dev-traces'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'skills', 'instar-dev', 'scripts'), { recursive: true });

    // Stub the eli16 + promotion deps (imported at module load).
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
    // Copy the whole scripts/lib dir so all of the hook's pure lib imports
    // (classify-tier.mjs, convergence-recognition.mjs, …) resolve in the sandbox.
    fs.cpSync(
      path.join(path.dirname(HOOK_SCRIPT), 'lib'),
      path.join(sandbox, 'scripts', 'lib'),
      { recursive: true },
    );
    fs.copyFileSync(HOOK_SCRIPT, path.join(sandbox, 'scripts', 'instar-dev-precommit.js'));
    // audit-convergence-enforcement §2: the hook now imports these two sibling
    // scripts — copy them so the sandbox hook resolves its imports.
    fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), 'write-audit-convergence.mjs'), path.join(sandbox, 'scripts', 'write-audit-convergence.mjs'));
    fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), 'audit-secret-patterns.mjs'), path.join(sandbox, 'scripts', 'audit-secret-patterns.mjs'));
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: 'tests/unit/instar-dev-precommit-audit-staging.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  function listEntryFiles(): string[] {
    const dir = path.join(sandbox, '.instar', 'instar-dev-decisions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  }

  it('stages the decision entry file even when the gate BLOCKS the commit (entry rides the retry)', async () => {
    // An in-scope file + a Tier-1 trace that is INCOMPLETE (no eli16Path) →
    // the audit write at Step 4.5 happens, then enforceTier1 blocks.
    const srcRel = 'src/touched.ts';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-audit-fixture.json`),
      JSON.stringify({
        phase: 'complete',
        slug: 'audit-fixture',
        tier: 1,
        coveredFiles: [srcRel],
        createdAt: new Date().toISOString(),
      }, null, 2),
    );
    execFileSync('git', ['add', srcRel], { cwd: sandbox });

    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0); // gate blocked (incomplete Tier-1 bundle)

    // Fix #1: the decision entry exists AND is staged — not an orphaned
    // working-tree file that evaporates with the worktree.
    const entries = listEntryFiles();
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain('audit-fixture');
    const entryRel = path.join('.instar', 'instar-dev-decisions', entries[0]);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, entryRel), 'utf8')).slug).toBe('audit-fixture');

    const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: sandbox, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    expect(stagedFiles).toContain(entryRel);

    // And the STAGED copy (not just the working tree) carries the slug.
    const stagedContent = execFileSync('git', ['show', `:${entryRel}`], { cwd: sandbox, encoding: 'utf8' });
    expect(stagedContent).toContain('"audit-fixture"');

    // Fix #2: the frozen legacy JSONL is NOT appended to.
    expect(fs.existsSync(path.join(sandbox, '.instar', 'instar-dev-decisions.jsonl'))).toBe(false);
  });

  it('two evaluations produce two DISTINCT entry files (conflict immunity)', async () => {
    // The parallel-PR conflict existed because both PRs appended to ONE file.
    // Per-entry files: each evaluation creates its own path — even with the
    // same slug in the same millisecond, the writer suffixes a counter.
    const srcRel = 'src/touched.ts';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-audit-fixture.json`),
      JSON.stringify({
        phase: 'complete',
        slug: 'audit-fixture',
        tier: 1,
        coveredFiles: [srcRel],
        createdAt: new Date().toISOString(),
      }, null, 2),
    );
    execFileSync('git', ['add', srcRel], { cwd: sandbox });

    await runHook(process.env, sandbox); // evaluation 1 (blocks)
    await runHook(process.env, sandbox); // evaluation 2 (the retry — blocks again)

    const entries = listEntryFiles();
    expect(entries.length).toBe(2);
    expect(new Set(entries).size).toBe(2); // distinct paths — the property that kills the conflict class
    for (const e of entries) {
      expect(JSON.parse(fs.readFileSync(path.join(sandbox, '.instar', 'instar-dev-decisions', e), 'utf8')).slug).toBe('audit-fixture');
    }
  });

  // ── Verdict finalization (the mislabeled rode-along entry, 2026-06-05) ──
  // Riding-the-retry is deliberate: a blocked evaluation's entry rides the
  // next successful commit. But without a verdict, an entry written under a
  // stale/unresolved trace slug READS as a real shipped decision for that
  // slug — both echo (#836) and codey (#842) shipped mislabeled
  // "unknown"/foreign-slug entries in one day. The exit handler finalizes
  // every entry with 'pass' or 'blocked' so each is self-describing.

  it('a BLOCKED evaluation finalizes its entry with verdict "blocked" (staged copy included)', async () => {
    const srcRel = 'src/touched.ts';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-audit-fixture.json`),
      JSON.stringify({
        phase: 'complete',
        slug: 'audit-fixture',
        tier: 1,
        coveredFiles: [srcRel],
        createdAt: new Date().toISOString(),
      }, null, 2),
    );
    execFileSync('git', ['add', srcRel], { cwd: sandbox });

    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);

    const entries = listEntryFiles();
    expect(entries.length).toBe(1);
    const entryRel = path.join('.instar', 'instar-dev-decisions', entries[0]);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, entryRel), 'utf8')).verdict).toBe('blocked');
    // The STAGED copy carries the finalized verdict too (the exit handler
    // re-stages after the rewrite) — the rode-along record is truthful.
    const staged = execFileSync('git', ['show', `:${entryRel}`], { cwd: sandbox, encoding: 'utf8' });
    expect(JSON.parse(staged).verdict).toBe('blocked');
  });

  it('a PASSING Tier-1 evaluation finalizes its entry with verdict "pass"', async () => {
    const srcRel = 'src/touched.ts';
    const eli16Rel = 'upgrades/pass-fixture.eli16.md';
    const seRel = 'upgrades/side-effects/pass-fixture.md';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(path.join(sandbox, eli16Rel), 'E'.repeat(900)); // ≥ MIN_ELI16_CHARS
    // ≥ 200 chars — the Tier-1 side-effects artifact length floor.
    fs.writeFileSync(path.join(sandbox, seRel), `# Side-Effects Review — pass fixture\n\n${'S'.repeat(250)}\n`);
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-pass-fixture.json`),
      JSON.stringify({
        phase: 'complete',
        slug: 'pass-fixture',
        tier: 1,
        coveredFiles: [srcRel, eli16Rel, seRel],
        eli16Path: eli16Rel,
        sideEffectsPath: seRel,
        createdAt: new Date().toISOString(),
      }, null, 2),
    );
    execFileSync('git', ['add', srcRel, eli16Rel, seRel], { cwd: sandbox });

    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0); // complete Tier-1 bundle passes

    const entries = listEntryFiles();
    expect(entries.length).toBe(1);
    const entry = JSON.parse(
      fs.readFileSync(path.join(sandbox, '.instar', 'instar-dev-decisions', entries[0]), 'utf8'),
    );
    expect(entry.verdict).toBe('pass');
    expect(entry.slug).toBe('pass-fixture');
  });

  it('binds the decision audit to the newest trace that covers the staged change', async () => {
    const srcRel = 'src/touched.ts';
    const eli16Rel = 'upgrades/pass-fixture.eli16.md';
    const seRel = 'upgrades/side-effects/pass-fixture.md';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(path.join(sandbox, eli16Rel), 'E'.repeat(900));
    fs.writeFileSync(path.join(sandbox, seRel), `# Side-Effects Review\n\n${'S'.repeat(250)}\n`);

    const matching = path.join(sandbox, '.instar', 'instar-dev-traces', 'matching.json');
    fs.writeFileSync(matching, JSON.stringify({
      phase: 'complete', slug: 'right-work-item', tier: 1,
      coveredFiles: [srcRel, eli16Rel, seRel], eli16Path: eli16Rel, sideEffectsPath: seRel,
    }));
    const foreign = path.join(sandbox, '.instar', 'instar-dev-traces', 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({
      phase: 'complete', slug: 'unknown', tier: 1, coveredFiles: ['src/other.ts'],
    }));
    const now = Date.now();
    fs.utimesSync(matching, new Date(now - 1_000), new Date(now - 1_000));
    fs.utimesSync(foreign, new Date(now), new Date(now));
    execFileSync('git', ['add', srcRel, eli16Rel, seRel], { cwd: sandbox });

    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
    const entries = listEntryFiles();
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(sandbox, '.instar', 'instar-dev-decisions', entries[0]), 'utf8'));
    expect(entry.slug).toBe('right-work-item');
    expect(entries[0]).toContain('right-work-item');
  });

  it('derives stable identity from artifactPath for legacy generated traces without slug', async () => {
    const srcRel = 'src/touched.ts';
    const eli16Rel = 'upgrades/legacy-fixture.eli16.md';
    const seRel = 'upgrades/side-effects/legacy-fixture.md';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(path.join(sandbox, eli16Rel), 'E'.repeat(900));
    fs.writeFileSync(path.join(sandbox, seRel), `# Side-Effects Review\n\n${'S'.repeat(250)}\n`);
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', 'legacy.json'),
      JSON.stringify({
        phase: 'complete', tier: 1, artifactPath: seRel,
        coveredFiles: [srcRel, eli16Rel, seRel], eli16Path: eli16Rel, sideEffectsPath: seRel,
      }),
    );
    execFileSync('git', ['add', srcRel, eli16Rel, seRel], { cwd: sandbox });

    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
    const entries = listEntryFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('legacy-fixture');
  });
});

// ── Causal autopsy (directive 2026-06-05) ─────────────────────────────────
// Low-ceremony lanes ship without an independent reviewer; the compensating
// control is a durable causal record per fix: what caused the issue — a
// prior PR, an environment shift, new code, a latent bug, or unknown. The
// field rides the decision audit so meta-analysis (convergence vs
// whack-a-mole) is a query over entries. Slice 1 contract pinned here:
// present+valid → recorded verbatim; present+malformed → BLOCKED (a corrupt
// record is worse than none) with the attempt recorded; absent → never
// blocks, advisory warning only on fix-class signals.

describe('instar-dev pre-commit — causalAutopsy (advisory slice)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-autopsy-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sandbox });
    fs.mkdirSync(path.join(sandbox, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'docs', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'next'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, '.instar', 'instar-dev-traces'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'skills', 'instar-dev', 'scripts'), { recursive: true });
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
    // Copy the whole scripts/lib dir so all of the hook's pure lib imports
    // (classify-tier.mjs, convergence-recognition.mjs, …) resolve in the sandbox.
    fs.cpSync(
      path.join(path.dirname(HOOK_SCRIPT), 'lib'),
      path.join(sandbox, 'scripts', 'lib'),
      { recursive: true },
    );
    fs.copyFileSync(HOOK_SCRIPT, path.join(sandbox, 'scripts', 'instar-dev-precommit.js'));
    // audit-convergence-enforcement §2: the hook now imports these two sibling
    // scripts — copy them so the sandbox hook resolves its imports.
    fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), 'write-audit-convergence.mjs'), path.join(sandbox, 'scripts', 'write-audit-convergence.mjs'));
    fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), 'audit-secret-patterns.mjs'), path.join(sandbox, 'scripts', 'audit-secret-patterns.mjs'));
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: 'tests/unit/instar-dev-precommit-audit-staging.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  function entryFiles(): string[] {
    const dir = path.join(sandbox, '.instar', 'instar-dev-decisions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  }

  function writePassingTier1Fixture(extraTrace: Record<string, unknown> = {}): void {
    const srcRel = 'src/touched.ts';
    const eli16Rel = 'upgrades/autopsy-fixture.eli16.md';
    const seRel = 'upgrades/side-effects/autopsy-fixture.md';
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');
    fs.writeFileSync(path.join(sandbox, eli16Rel), 'E'.repeat(900));
    fs.writeFileSync(path.join(sandbox, seRel), `# Side-Effects Review — autopsy fixture\n\n${'S'.repeat(250)}\n`);
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-autopsy-fixture.json`),
      JSON.stringify({
        phase: 'complete',
        slug: 'autopsy-fixture',
        tier: 1,
        coveredFiles: [srcRel, eli16Rel, seRel],
        eli16Path: eli16Rel,
        sideEffectsPath: seRel,
        createdAt: new Date().toISOString(),
        ...extraTrace,
      }, null, 2),
    );
    execFileSync('git', ['add', srcRel, eli16Rel, seRel], { cwd: sandbox });
  }

  it('a valid causalAutopsy is recorded VERBATIM in the decision entry', async () => {
    writePassingTier1Fixture({
      causalAutopsy: {
        origin: 'prior-pr',
        relatedPrs: [839, 840],
        notes: 'release-cadence shift invalidated retry budgets tuned for rare restarts',
      },
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);

    const entries = entryFiles();
    expect(entries.length).toBe(1);
    const entry = JSON.parse(
      fs.readFileSync(path.join(sandbox, '.instar', 'instar-dev-decisions', entries[0]), 'utf8'),
    );
    expect(entry.causalAutopsy).toEqual({
      origin: 'prior-pr',
      relatedPrs: [839, 840],
      notes: 'release-cadence shift invalidated retry budgets tuned for rare restarts',
    });
    expect(entry.verdict).toBe('pass');
  });

  it('a MALFORMED causalAutopsy blocks the commit and the attempt is recorded as blocked', async () => {
    writePassingTier1Fixture({
      causalAutopsy: { origin: 'because-reasons' }, // invalid origin enum
    });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/causalAutopsy\.origin must be one of/);

    const entries = entryFiles();
    expect(entries.length).toBe(1);
    const entry = JSON.parse(
      fs.readFileSync(path.join(sandbox, '.instar', 'instar-dev-decisions', entries[0]), 'utf8'),
    );
    expect(entry.verdict).toBe('blocked');
    expect(entry.causalAutopsy).toBeNull(); // a corrupt declaration is never recorded as data
  });

  it('origin "prior-pr" without relatedPrs blocks with a specific message', async () => {
    writePassingTier1Fixture({ causalAutopsy: { origin: 'prior-pr' } });
    const result = await runHook(process.env, sandbox);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/"prior-pr" requires relatedPrs/);
  });

  it('ABSENT causalAutopsy never blocks; fix-class signal (fragment change_type: fix) warns advisory', async () => {
    writePassingTier1Fixture(); // no causalAutopsy
    const fragRel = 'upgrades/next/autopsy-fixture.md';
    fs.writeFileSync(
      path.join(sandbox, fragRel),
      '---\nchange_type: fix\n---\n\n## What Changed\n\nfix fixture\n',
    );
    execFileSync('git', ['add', fragRel], { cwd: sandbox });

    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0); // NEVER blocks on absence
    expect(result.stderr).toMatch(/ADVISORY — fix-class commit with no causalAutopsy/);

    const entries = entryFiles();
    const entry = JSON.parse(
      fs.readFileSync(path.join(sandbox, '.instar', 'instar-dev-decisions', entries[0]), 'utf8'),
    );
    expect(entry.causalAutopsy).toBeNull();
    expect(entry.verdict).toBe('pass');
  });

  it('ABSENT causalAutopsy with no fix-class signal passes with NO advisory noise', async () => {
    writePassingTier1Fixture();
    const result = await runHook(process.env, sandbox);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/causalAutopsy/);
  });
});
