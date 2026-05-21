/**
 * Shared helpers for spawning git child processes from tests.
 *
 * Git sets GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
 * GIT_COMMON_DIR in the env when it invokes a hook (e.g. .husky/pre-push
 * runs `npm run test:smoke`). Those variables pin every descendant git
 * command to the parent repo regardless of cwd, so a test that thinks it
 * is committing into a tmpdir actually commits into the real repo on
 * whichever branch is checked out.
 *
 * Vitest setup (`tests/vitest-setup.ts`) already strips these from
 * `process.env` before any test loads, so most fixtures will see a clean
 * env automatically. This helper exists as defense-in-depth for fixtures
 * that build their own `env: { ... }` object for spawnSync/execFileSync
 * (a common pattern) — they can call `sanitizedGitEnv()` to guarantee
 * they don't accidentally reintroduce the inherited overrides.
 */
export const GIT_ENV_OVERRIDE_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
] as const;

/**
 * Returns a copy of process.env (or the provided base) with the git
 * env override vars deleted. Use this when constructing `env` for
 * spawnSync / execFileSync / execSync calls that run git in tests.
 */
export function sanitizedGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_ENV_OVERRIDE_KEYS) {
    delete out[key];
  }
  return out;
}
