/**
 * Parity guard — scripts/release-local.mjs must keep mirroring the publish job
 * of .github/workflows/publish.yml.
 *
 * A local release is only trustworthy if it is the same release CI would make.
 * When someone adds a step to publish.yml (a new `node scripts/<x>` gate), this
 * test fails until release-local.mjs runs it too — in the same relative order.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf-8');
// The post-publish push/tag logic lives in scripts/lib/release-local-steps.mjs.
const local =
  fs.readFileSync(path.join(ROOT, 'scripts', 'release-local.mjs'), 'utf-8') +
  '\n' +
  fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'release-local-steps.mjs'), 'utf-8');

/** Every `scripts/<name>` the workflow invokes with node, in order of first appearance. */
function workflowScripts(): string[] {
  const seen: string[] = [];
  for (const m of workflow.matchAll(/node (scripts\/[\w.-]+)/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

describe('release-local mirrors publish.yml', () => {
  it('finds the workflow steps it is checking against (non-vacuous)', () => {
    expect(workflowScripts()).toEqual(expect.arrayContaining([
      'scripts/assemble-next-md.mjs',
      'scripts/resolve-release-tier.mjs',
      'scripts/resolve-publish-version.mjs',
      'scripts/check-upgrade-guide.js',
      'scripts/post-publish-smoke.mjs',
    ]));
  });

  it('runs every scripts/<x> the workflow runs, in the same order', () => {
    const scripts = workflowScripts();
    const positions = scripts.map((s) => {
      const i = local.indexOf(`'${s}'`);
      expect(i, `release-local.mjs does not run ${s}`).toBeGreaterThan(-1);
      return i;
    });
    // release-skip-annotate sits in the skip branch, which the local script
    // handles inline before the tier gate — same relative position as CI.
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it('mirrors the workflow commands that are not node scripts', () => {
    expect(workflow).toContain('npm version "$NEXT" --no-git-tag-version --allow-same-version');
    expect(local).toContain("['version', VERSION, '--no-git-tag-version', '--allow-same-version']");
    expect(workflow).toContain('git commit -m "chore: release v');
    expect(local).toContain('`chore: release v${VERSION} [skip ci]`');
    expect(workflow).toContain('for attempt in 1 2 3 4 5');
    expect(local).toContain('maxAttempts = 5');
    expect(workflow).toContain('git push origin HEAD:main');
    expect(workflow).not.toContain('git push origin main');
    expect(workflow).toContain('git tag "v${{ steps.bump.outputs.version }}"');
    expect(workflow).toContain('git -c merge.renames=false rebase origin/main');
    // CI can race a concurrent code merge. Its tag must stay on the exact
    // release cut that npm received, even if main needs a later rebase.
    expect(workflow.indexOf('git tag "v${{ steps.bump.outputs.version }}"'))
      .toBeLessThan(workflow.indexOf('git -c merge.renames=false rebase origin/main'));
    expect(workflow.indexOf('git push origin "v${{ steps.bump.outputs.version }}"'))
      .toBeLessThan(workflow.indexOf('git push origin HEAD:main'));
    expect(local).toContain("['-c', 'merge.renames=false', 'rebase', `${remote}/main`]");
    // The local default has a stricter atomic path. Its explicit
    // --keep-tag-on-published recovery path mirrors the CI race behavior.
    expect(local).toContain("['push', '--atomic', remote, 'HEAD:main', tag]");
  });

  it('never bypasses hooks and never force-pushes', () => {
    expect(local).not.toMatch(/--no-verify|HUSKY\s*[:=]|INSTAR_PRE_PUSH_SKIP|--force|'-f'/);
  });

  it('rejects unknown arguments without touching anything', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-local.mjs'), '--publish-now'], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
  });
});
