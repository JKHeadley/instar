/**
 * joinDir — pure directory-target resolution for `instar join`.
 *
 * Extracted as its own module (like testAsSelfValidation) so the
 * directory-targeting DECISION is fully unit-testable without importing the
 * heavy `machine.ts` dependency graph (GitSyncManager, SecretStore, native
 * modules, …).
 *
 * Spec: MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS §1.3. The git-URL branch of
 * `joinMesh` previously forced `path.resolve(repoName)` and IGNORED `--dir`, so
 * a join could only land in a cwd/repo-name directory — never a caller-chosen
 * home. That blocked any orchestrator (e.g. the Track-E test-as-self harness)
 * from joining a mesh into a specific throwaway home. `resolveJoinDir` honors
 * `--dir` for git URLs while preserving the historical default when it's absent.
 */

import path from 'node:path';

/** True if `repoUrl` is a git clone URL (vs a tunnel http(s) URL or a local path). */
export function isGitCloneUrl(repoUrl: string): boolean {
  return repoUrl.includes('github.com') || repoUrl.includes('.git') || repoUrl.startsWith('git@');
}

/**
 * Resolve the directory `instar join` will clone into / use.
 *
 *  - git URL + `--dir`     → resolved `--dir` (the §1.3 fix: clone the mesh there).
 *  - git URL + no `--dir`  → `<cwd>/<repoName>` (historical default; UNCHANGED).
 *  - non-git URL + `--dir` → resolved `--dir`.
 *  - non-git URL + no dir  → `process.cwd()` (UNCHANGED).
 *
 * Pure (modulo `process.cwd()` for the no-dir defaults). Non-breaking: every
 * no-`--dir` path is byte-identical to the prior behavior.
 */
export function resolveJoinDir(repoUrl: string, options: { dir?: string }): string {
  if (isGitCloneUrl(repoUrl)) {
    const repoName = path.basename(repoUrl, '.git');
    return options.dir ? path.resolve(options.dir) : path.resolve(repoName);
  }
  return options.dir ? path.resolve(options.dir) : process.cwd();
}
