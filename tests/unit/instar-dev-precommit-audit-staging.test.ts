// safe-git-allow: test file — execFileSync('git', ...) builds the sandbox repo
//   fixture (init, add, diff). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Decision-audit self-commit (task #62 root cause, 2026-06-05).
 *
 * writeDecisionAudit runs inside the PRE-COMMIT hook, so its append always
 * landed AFTER staging — the audit line sat uncommitted in the building
 * worktree's tracked .instar/instar-dev-decisions.jsonl. One-PR worktrees
 * never committed it; worktree reclaim deleted it; the audit trail silently
 * leaked ("the decision-audit didn't fire" — it DID fire, the line just
 * evaporated with the worktree). The fix stages the decisions file right
 * after the append so the line rides the very commit it describes.
 *
 * These tests pin: (1) the audit line is WRITTEN and STAGED for an in-scope
 * commit even when the gate then BLOCKS (the staged line rides the retry
 * commit); (2) the staged content carries the evaluated slug.
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

  it('stages the decisions line even when the gate BLOCKS the commit (line rides the retry)', async () => {
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

    // THE FIX: the decisions line exists AND is staged — not an orphaned
    // working-tree modification that evaporates with the worktree.
    const decisionsRel = path.join('.instar', 'instar-dev-decisions.jsonl');
    const onDisk = fs.readFileSync(path.join(sandbox, decisionsRel), 'utf8').trim().split('\n');
    expect(onDisk.length).toBe(1);
    expect(JSON.parse(onDisk[0]).slug).toBe('audit-fixture');

    const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: sandbox, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    expect(stagedFiles).toContain(decisionsRel);

    // And the STAGED copy (not just the working tree) carries the line.
    const stagedContent = execFileSync('git', ['show', `:${decisionsRel}`], { cwd: sandbox, encoding: 'utf8' });
    expect(stagedContent).toContain('"audit-fixture"');
  });
});
