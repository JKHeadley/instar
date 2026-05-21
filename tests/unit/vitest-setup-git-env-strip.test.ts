/**
 * Regression test: vitest-setup.ts strips the GIT_DIR family from
 * process.env before any test loads.
 *
 * Context: when git invokes a hook (e.g. .husky/pre-push runs the test
 * suite), it sets GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE /
 * GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR in the child env. Those vars
 * override cwd-based git repo resolution, so any test that spawns
 * `git init` / `git commit` in a tmpdir ends up committing into the
 * real parent repo on whichever branch is checked out.
 *
 * That's how the "# Test Project" README clobber landed on main
 * (PRs #130 and #277). The vitest-setup.ts strip is the structural
 * fix. This test pins it so it can't silently drift.
 */
import { describe, it, expect } from 'vitest';
import { GIT_ENV_OVERRIDE_KEYS, sanitizedGitEnv } from '../helpers/git-test-env.js';

describe('vitest-setup git env strip', () => {
  it('GIT_DIR family is absent from process.env at test time', () => {
    for (const key of GIT_ENV_OVERRIDE_KEYS) {
      expect(process.env[key], `${key} should be stripped by vitest-setup`).toBeUndefined();
    }
  });

  it('sanitizedGitEnv() drops the override keys from a polluted base', () => {
    const polluted = {
      ...process.env,
      GIT_DIR: '/fake/.git',
      GIT_WORK_TREE: '/fake',
      GIT_INDEX_FILE: '/fake/.git/index',
      GIT_OBJECT_DIRECTORY: '/fake/.git/objects',
      GIT_COMMON_DIR: '/fake/.git',
    } satisfies NodeJS.ProcessEnv;
    const clean = sanitizedGitEnv(polluted);
    for (const key of GIT_ENV_OVERRIDE_KEYS) {
      expect(clean[key], `${key} should be removed by sanitizedGitEnv`).toBeUndefined();
    }
    // Other keys pass through unchanged.
    expect(clean.PATH).toBe(polluted.PATH);
  });
});
