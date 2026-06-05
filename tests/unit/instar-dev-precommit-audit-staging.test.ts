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
    fs.copyFileSync(
      path.join(path.dirname(HOOK_SCRIPT), 'lib', 'classify-tier.mjs'),
      path.join(sandbox, 'scripts', 'lib', 'classify-tier.mjs'),
    );
    fs.copyFileSync(HOOK_SCRIPT, path.join(sandbox, 'scripts', 'instar-dev-precommit.js'));
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
});
