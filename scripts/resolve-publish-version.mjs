#!/usr/bin/env node
/**
 * resolve-publish-version — reconcile package.json (operator authority) with
 * the npm registry (shipped truth) and print the version the release workflow
 * should publish.
 *
 * Added 2026-05-19 after the v1.0.0 deployment misalignment incident
 * (docs/incidents/2026-05-19-v1-deployment-misalignment.md). The old workflow
 * always derived the next version from npm and ignored package.json, which
 * made an operator-intended major bump structurally impossible. That is the
 * exact failure this script closes.
 *
 * Policy:
 *   LOCAL  > NPM  → publish at LOCAL (operator-intended leap: major/minor/
 *                   explicit-patch jump). This is how a v1.0.0 cut happens.
 *   LOCAL == NPM  → routine patch: NPM with patch+1. The common case — a PR
 *                   that does not touch package.json leaves LOCAL equal to the
 *                   last released version.
 *   LOCAL  < NPM  → stale package.json (a queued run that landed after an
 *                   earlier publish already bumped). Never downgrade — NPM
 *                   with patch+1.
 *
 * Staged versions (added 2026-11-17, feedback fb-354bb7b5-b5d): npm can hold
 * a just-published version as "staged" for close to an hour before
 * `npm view instar version` shows it. A run that starts in that window would
 * resolve the same number again and npm refuses it (E409 "Cannot publish over
 * previously staged version", or 403 once it becomes visible). 1.3.1868 and
 * 1.3.1873 both did this. The publisher therefore pushes a `published/vX.Y.Z`
 * tag the moment `npm publish` succeeds, and the resolver treats the highest
 * `vX.Y.Z` or `published/vX.Y.Z` tag as consumed, exactly like the npm
 * version: the effective "last released" is max(npm, consumed tags).
 *
 * Usage:
 *   node scripts/resolve-publish-version.mjs <localVersion> <npmVersion> [--tags-from-git]
 *   → prints the resolved version to stdout, nothing else. With
 *     --tags-from-git it also reads `git tag -l` in the current directory
 *     (the caller fetches tags first).
 *
 * Exported as a function for unit testing.
 */

/**
 * @param {string} a semver "x.y.z"
 * @param {string} b semver "x.y.z"
 * @returns {"gt"|"eq"|"lt"} a compared to b
 */
export function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 'gt';
    if (x < y) return 'lt';
  }
  return 'eq';
}

const CONSUMED_TAG = /^(?:published\/)?v(\d+\.\d+\.\d+)$/;

/**
 * Highest version a tag says was already handed to npm.
 * @param {string[]} tags tag names (`v1.2.3`, `published/v1.2.3`; others ignored)
 * @returns {string|null}
 */
export function highestConsumedVersion(tags) {
  let best = null;
  for (const t of tags || []) {
    const m = CONSUMED_TAG.exec(String(t).trim());
    if (!m) continue;
    if (best === null || compareSemver(m[1], best) === 'gt') best = m[1];
  }
  return best;
}

/**
 * @param {string} localVersion package.json version
 * @param {string} npmVersion `npm view instar version` (or "0.0.0" if unpublished)
 * @returns {{version: string, reason: "operator-intended"|"routine-patch"}}
 */
export function resolvePublishVersion(localVersion, npmVersion, consumedVersion = null) {
  // A consumed tag above npm means a publish npm has not shown yet: count it.
  if (consumedVersion && compareSemver(consumedVersion, npmVersion) === 'gt') {
    npmVersion = consumedVersion;
  }
  const cmp = compareSemver(localVersion, npmVersion);
  if (cmp === 'gt') {
    return { version: localVersion, reason: 'operator-intended' };
  }
  const [major, minor, patch] = String(npmVersion).split('.').map(Number);
  return {
    version: `${major || 0}.${minor || 0}.${(patch || 0) + 1}`,
    reason: 'routine-patch',
  };
}

// CLI entrypoint — only runs when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const fromGit = args.includes('--tags-from-git');
  const [localVersion, npmVersion] = args.filter((a) => a !== '--tags-from-git');
  if (!localVersion || !npmVersion) {
    console.error('usage: resolve-publish-version.mjs <localVersion> <npmVersion> [--tags-from-git]');
    process.exit(2);
  }
  let consumed = null;
  if (fromGit) {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['tag', '-l', 'v*', 'published/v*'], { encoding: 'utf-8' });
    consumed = highestConsumedVersion(out.split('\n'));
    if (consumed) console.error(`highest consumed tag: ${consumed}`);
  }
  const { version } = resolvePublishVersion(localVersion, npmVersion, consumed);
  process.stdout.write(version);
}
