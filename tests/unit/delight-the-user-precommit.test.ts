// safe-git-allow: test file — execFileSync('git', ...) builds the sandbox repo
//   fixture (init, add). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Delight the User review gate — the REAL pre-commit hook in a sandbox repo
 * (docs/STANDARDS-REGISTRY.md → "Delight the User"; spec
 * docs/specs/delight-the-user-standard.md).
 *
 * Negative controls: a screen-only commit with no trace is now refused (screen
 * files are in scope); a complete Tier-1 bundle whose side-effects artifact
 * lacks the delight answer, or names a screenshot that does not exist, is
 * refused by the delight gate specifically. Positive controls: the same bundle
 * with a written answer and real screenshots passes, and so does a reasoned
 * "no visible change" attestation. A non-screen commit is untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'instar-dev-precommit.js');

interface RunResult { status: number | null; out: string; }

async function runHook(cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, INSTAR_PR_OVERLAP_CHECK: 'off' };
    const proc = spawn('node', [path.join(cwd, 'scripts', 'instar-dev-precommit.js')], { env, cwd });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', status => resolve({ status, out }));
    setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('hook timeout')); }, 30_000);
  });
}

const DELETE = '\u0000delete';
const REVIEWED = { secondPass: true, section: '**Reviewer:** independent reviewer subagent\n\nConcur. Looked at before.png and after.png at phone width: the ask leads, Approve is full size, no ids.' };

const ANSWER =
  'Before, the card was one long grey paragraph with a wait id and a UTC stamp in it. Now the ask leads in large ' +
  'type, the recommendation sits in a highlighted box with Approve directly under it, and the time reads ' +
  '"since yesterday, 2:15 PM". Mac and iPhone share the same layout.';

describe('instar-dev pre-commit — Delight the User gate (real hook, sandbox repo)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'delight-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sandbox });
    for (const d of ['scripts/lib', 'docs/specs', 'upgrades/side-effects', '.instar/instar-dev-traces', 'src', 'dashboard', 'shots', 'skills/instar-dev/scripts', 'skills/instar-dev/templates']) {
      fs.mkdirSync(path.join(sandbox, d), { recursive: true });
    }
    fs.writeFileSync(
      path.join(sandbox, 'scripts', 'eli16-overview-check.mjs'),
      `import path from 'node:path';\nexport const MIN_ELI16_CHARS = 800;\n` +
      `export function checkEli16Overview(specPath) {\n` +
      `  const eli16Path = path.join(path.dirname(specPath), path.basename(specPath, '.md') + '.eli16.md');\n` +
      `  return { ok: true, eli16Path, charCount: 9999, minChars: 1 };\n}\n`,
    );
    fs.writeFileSync(
      path.join(sandbox, 'skills', 'instar-dev', 'scripts', 'verify-proposal-derived-runbook.mjs'),
      'export function verifyProposalDerivedRunbooks() { return { ok: true, reason: "ok" }; }\n',
    );
    fs.cpSync(path.join(path.dirname(HOOK_SCRIPT), 'lib'), path.join(sandbox, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(HOOK_SCRIPT, path.join(sandbox, 'scripts', 'instar-dev-precommit.js'));
    for (const f of ['write-audit-convergence.mjs', 'audit-secret-patterns.mjs', 'standards-registry-article-core.mjs']) {
      fs.copyFileSync(path.join(path.dirname(HOOK_SCRIPT), f), path.join(sandbox, 'scripts', f));
    }
    fs.copyFileSync(
      path.join(REPO_ROOT, 'skills', 'instar-dev', 'templates', 'side-effects-artifact.md'),
      path.join(sandbox, 'skills', 'instar-dev', 'templates', 'side-effects-artifact.md'),
    );
    fs.writeFileSync(path.join(sandbox, 'shots', 'before.png'), 'png-bytes-before');
    fs.writeFileSync(path.join(sandbox, 'shots', 'after.png'), 'png-bytes-after');
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: 'tests/unit/delight-the-user-precommit.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  /** Stage a complete Tier-1 bundle around `files`, with `delight` as the §6c body (null = no §6c). */
  function stageTier1(files: Record<string, string>, delight: string | null, review: { secondPass?: boolean; section?: string } = {}): void {
    const eli16Rel = 'upgrades/delight-fixture.eli16.md';
    const seRel = 'upgrades/side-effects/delight-fixture.md';
    for (const [rel, body] of Object.entries(files)) {
      if (body === DELETE) execFileSync('git', ['rm', '-q', rel], { cwd: sandbox });
      else fs.writeFileSync(path.join(sandbox, rel), body);
    }
    fs.writeFileSync(path.join(sandbox, eli16Rel), 'E'.repeat(900));
    const se =
      `# Side-Effects Review — delight fixture\n\n${'S'.repeat(250)}\n\n` +
      `## 6b. Operator-surface quality\n\nLeads with its action; no raw internals; destructive quiet; phone width checked.\n\n` +
      (delight === null ? '' : `## 6c. Delight the user\n\n${delight}\n\n`) +
      `## 7. Multi-machine posture\n\nmachine-local by design.\n` +
      (review.section ? `\n## Second-pass review\n\n${review.section}\n` : '');
    fs.writeFileSync(path.join(sandbox, seRel), se);
    const covered = [...Object.keys(files), eli16Rel, seRel];
    fs.writeFileSync(
      path.join(sandbox, '.instar', 'instar-dev-traces', `${Date.now()}-delight-fixture.json`),
      JSON.stringify({
        phase: 'complete', slug: 'delight-fixture', tier: 1, coveredFiles: covered,
        eli16Path: eli16Rel, sideEffectsPath: seRel, createdAt: new Date().toISOString(),
        ...(review.secondPass ? { secondPass: 'true', reviewerConcurred: true } : {}),
      }, null, 2),
    );
    execFileSync('git', ['add', ...covered.filter((f) => files[f] !== DELETE)], { cwd: sandbox });
  }

  const CARD = { 'dashboard/card.js': 'export function renderCard(el) { el.textContent = "Approve"; }\n' };

  it('NEGATIVE: a screen-only commit with no trace is refused (screen files are in scope now)', async () => {
    fs.writeFileSync(path.join(sandbox, 'dashboard/card.js'), CARD['dashboard/card.js']);
    execFileSync('git', ['add', 'dashboard/card.js'], { cwd: sandbox });
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('dashboard/card.js');
  });

  it('NEGATIVE: a complete Tier-1 bundle with no delight section is refused by the delight gate', async () => {
    stageTier1(CARD, null);
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Delight the User review gate/);
    expect(r.out).toMatch(/no "Delight the user" section/);
  });

  it('NEGATIVE: a delight answer naming a screenshot that does not exist is refused', async () => {
    stageTier1(CARD, `${ANSWER}\n\n- Before: shots/before.png\n- After: shots/missing-after.png`);
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/screenshot does not exist: shots\/missing-after\.png/);
  });

  it('NEGATIVE: a css-only change still needs the delight answer', async () => {
    stageTier1({ 'dashboard/card.css': '.card { padding: 16px; }\n' }, `${ANSWER}`);
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Delight the User review gate/);
  });

  it('NEGATIVE: an image-only change (a replaced icon) still needs the delight answer', async () => {
    stageTier1({ 'dashboard/icon.png': 'new-icon-bytes' }, null);
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Delight the User review gate/);
  });

  it('NEGATIVE: complete screenshots but no second reader is refused (every screen change is reviewed)', async () => {
    stageTier1(CARD, `${ANSWER}\n\n- Before: shots/before.png\n- After: shots/after.png`);
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/no concurring second-pass review/);
  });

  it('NEGATIVE: a second-pass section that never names the pictures is refused', async () => {
    stageTier1(CARD, `${ANSWER}\n\n- Before: shots/before.png\n- After: shots/after.png`, { secondPass: true, section: '**Reviewer:** independent reviewer subagent\n\nConcur, looks good to me overall.' });
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not name the screenshot it reviewed: after\.png/);
  });

  it('NEGATIVE: deleting a screen file with no delight answer is refused', async () => {
    fs.writeFileSync(path.join(sandbox, 'dashboard/old-panel.js'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'dashboard/old-panel.js'], { cwd: sandbox });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'seed'], { cwd: sandbox });
    stageTier1({ 'dashboard/old-panel.js': DELETE }, null);
    const r = await runHook(sandbox);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Delight the User review gate/);
  });

  it('POSITIVE: deleting a screen with its before picture and "screen removed" passes', async () => {
    fs.writeFileSync(path.join(sandbox, 'dashboard/old-panel.js'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'dashboard/old-panel.js'], { cwd: sandbox });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'seed'], { cwd: sandbox });
    stageTier1({ 'dashboard/old-panel.js': DELETE }, `${ANSWER}\n\n- Before: shots/before.png\n- After: none — screen removed: the panel moved into People`, REVIEWED);
    const r = await runHook(sandbox);
    expect(r.out).not.toMatch(/Delight the User review gate/);
    expect(r.status).toBe(0);
  });

  it('POSITIVE: a written answer with real before/after screenshots and a second reader passes', async () => {
    stageTier1(CARD, `${ANSWER}\n\n- Before: shots/before.png\n- After: shots/after.png`, REVIEWED);
    const r = await runHook(sandbox);
    expect(r.out).not.toMatch(/Delight the User review gate/);
    expect(r.status).toBe(0);
  });

  it('POSITIVE: a reasoned "no visible change" attestation passes', async () => {
    stageTier1(CARD, `${ANSWER}\n\n- Screenshots: no visible change — renames the render helper; the card renders identically`);
    const r = await runHook(sandbox);
    expect(r.status).toBe(0);
  });

  it('UNTOUCHED: a non-screen src change needs no delight section', async () => {
    stageTier1({ 'src/touched.ts': '// touched\n' }, null);
    const r = await runHook(sandbox);
    expect(r.out).not.toMatch(/Delight the User review gate/);
    expect(r.status).toBe(0);
  });
});
