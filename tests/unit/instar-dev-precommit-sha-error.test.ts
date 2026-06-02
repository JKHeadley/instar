// safe-git-allow: test file — execFileSync('git', ...) builds the sandbox repo
//   fixture (init, add). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tests for the improved artifact-sha-mismatch error in
 * scripts/instar-dev-precommit.js. The old message ("artifact content has
 * changed (sha mismatch)") never told the author what sha to write, so an
 * agent — especially codex, which regenerates artifacts — would chase the hash
 * forever (regenerate → a volatile Date line changes → new sha → repeat). This
 * cost a real ~2h grind on 2026-05-30. The fix prints the EXACT computed sha
 * plus the freeze/re-stage/no-amend recipe, turning it into a copy-paste fix.
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

describe('instar-dev pre-commit — artifact sha-mismatch error message', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-error-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sandbox });
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'docs', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'upgrades', 'side-effects'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, '.instar', 'instar-dev-traces'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'skills', 'instar-dev', 'scripts'), { recursive: true });

    // Stub the eli16 + promotion deps (not reached on a sha failure, but the
    // hook imports them at module load).
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
    // Copy the hook + its new pure tier classifier dependency into the sandbox.
    fs.mkdirSync(path.join(sandbox, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(path.dirname(HOOK_SCRIPT), 'lib', 'classify-tier.mjs'),
      path.join(sandbox, 'scripts', 'lib', 'classify-tier.mjs'),
    );
    fs.copyFileSync(HOOK_SCRIPT, path.join(sandbox, 'scripts', 'instar-dev-precommit.js'));
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: 'tests/unit/instar-dev-precommit-sha-error.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  /** Stage a valid bundle but with a deliberately WRONG artifactSha256 in the trace. */
  function stageWithBadSha(): { realSha: string } {
    const specRel = path.join('docs', 'specs', 'fixture.md');
    const eli16Rel = path.join('docs', 'specs', 'fixture.eli16.md');
    const artifactRel = path.join('upgrades', 'side-effects', 'fixture.md');
    const srcRel = 'src/touched.ts';
    const traceRel = path.join('.instar', 'instar-dev-traces', `${Date.now()}-fixture.json`);

    const artifactBody = `# Side-effects review\n\n## Summary\n\n${'x'.repeat(400)}\n`;
    const realSha = crypto.createHash('sha256').update(artifactBody).digest('hex');

    fs.writeFileSync(path.join(sandbox, specRel), `---\ntitle: Fixture\napproved: true\nreview-convergence: tactical\neli16-overview: fixture.eli16.md\n---\n\nbody\n`);
    fs.writeFileSync(path.join(sandbox, eli16Rel), `# ELI16\n\n${'x'.repeat(400)}\n`);
    fs.writeFileSync(path.join(sandbox, artifactRel), artifactBody);
    fs.writeFileSync(path.join(sandbox, srcRel), '// touched\n');

    fs.writeFileSync(
      path.join(sandbox, traceRel),
      JSON.stringify({
        phase: 'complete',
        slug: 'fixture',
        coveredFiles: [srcRel],
        artifactPath: artifactRel,
        artifactSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // WRONG
        specPath: specRel,
        createdAt: new Date().toISOString(),
      }, null, 2),
    );

    execFileSync('git', ['add', srcRel, specRel, eli16Rel, artifactRel], { cwd: sandbox });
    return { realSha };
  }

  it('blocks the commit and prints the EXACT computed sha + freeze recipe', async () => {
    const { realSha } = stageWithBadSha();
    const result = await runHook(process.env, sandbox);

    expect(result.status).not.toBe(0); // blocked
    const out = result.stderr + result.stdout;
    // The killer feature: the exact sha to write is in the message.
    expect(out).toContain(realSha);
    // And the self-service recipe.
    expect(out).toMatch(/re-stage/i);
    expect(out).toMatch(/do NOT amend/i);
    expect(out).toMatch(/sha mismatch/i);
  });
});
