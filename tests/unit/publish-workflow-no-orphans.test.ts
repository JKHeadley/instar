/**
 * publish.yml must never leave a version on npm with no release commit or tag.
 *
 * Two shapes did exactly that (22 orphaned versions between 1.3.1384 and
 * 1.3.1493, e.g. 1.3.1386, 1.3.1491):
 *   1. The release commit's rebase hit a fake CONFLICT (file location): the
 *      commit deletes every upgrades/next/*.md fragment, git's directory-rename
 *      detection read that as a renamed directory, and a fragment a PR added
 *      meanwhile was "moved". The fix disables directory renames for that rebase.
 *   2. The post-publish smoke test ran BEFORE the commit step, so a slow npm
 *      propagation failed the run after `npm publish` and the commit never ran.
 *      The smoke test now runs after the release commit and tag are pushed.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf-8');

function at(needle: string): number {
  const i = workflow.indexOf(needle);
  expect(i, `publish.yml no longer contains: ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('publish.yml cannot orphan a published version', () => {
  it('pushes the release commit and tag before the post-publish smoke test', () => {
    const publish = at('run: npm publish --provenance --access public');
    const tagPush = at('git push origin "v${{ steps.bump.outputs.version }}"');
    const smoke = at('run: node scripts/post-publish-smoke.mjs');
    expect(publish).toBeLessThan(tagPush);
    expect(tagPush).toBeLessThan(smoke);
  });

  it('rebases the release commit with directory-rename detection off', () => {
    expect(workflow).toContain('git -c merge.directoryRenames=false rebase origin/main');
    expect(workflow).not.toMatch(/if ! git rebase origin\/main/);
  });

  it('the flag really turns the fragment collision into a clean rebase (real git)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-orphan-'));
    const g = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf-8' });
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
    try {
      g('init', '-q', '-b', 'main');
      w('upgrades/next/a.md', 'a\n'); w('package.json', '{"version":"1.0.0"}\n');
      g('add', '-A'); g('commit', '-qm', 'base');
      // The release commit: fold the fragment into the version guide, delete it.
      g('checkout', '-qb', 'release');
      w('upgrades/1.0.1.md', 'a\n'); g('rm', '-q', 'upgrades/next/a.md'); w('package.json', '{"version":"1.0.1"}\n');
      g('add', '-A'); g('commit', '-qm', 'chore: release v1.0.1 [skip ci]');
      // A PR merges a new fragment while the release is running.
      g('checkout', '-q', 'main');
      w('upgrades/next/c.md', 'c\n'); g('add', '-A'); g('commit', '-qm', 'pr');
      g('checkout', '-q', 'release');

      // Control: the default rebase reproduces the production conflict.
      const plain = g('rebase', 'main');
      expect(plain.status).not.toBe(0);
      expect(plain.stdout + plain.stderr).toContain('CONFLICT (file location)');
      g('rebase', '--abort');

      const fixed = g('-c', 'merge.directoryRenames=false', 'rebase', 'main');
      expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
      const files = g('ls-files').stdout.split('\n').filter(Boolean).sort();
      // The PR's fragment stays queued for the NEXT release; ours is consumed.
      expect(files).toEqual(['package.json', 'upgrades/1.0.1.md', 'upgrades/next/c.md']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
