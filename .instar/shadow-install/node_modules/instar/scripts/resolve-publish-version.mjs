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
 * Usage:
 *   node scripts/resolve-publish-version.mjs <localVersion> <npmVersion>
 *   → prints the resolved version to stdout, nothing else.
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

/**
 * @param {string} localVersion package.json version
 * @param {string} npmVersion `npm view instar version` (or "0.0.0" if unpublished)
 * @returns {{version: string, reason: "operator-intended"|"routine-patch"}}
 */
export function resolvePublishVersion(localVersion, npmVersion) {
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
  const [, , localVersion, npmVersion] = process.argv;
  if (!localVersion || !npmVersion) {
    console.error('usage: resolve-publish-version.mjs <localVersion> <npmVersion>');
    process.exit(2);
  }
  const { version } = resolvePublishVersion(localVersion, npmVersion);
  process.stdout.write(version);
}
