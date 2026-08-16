#!/usr/bin/env node
/**
 * resolve-release-tier — Layer 2 of the Deployment Lockdown spec.
 *
 * Reads `.instar/release-tier.json` (committed) and decides whether the
 * current publish attempt is permitted by the declared release tier.
 *
 * Why this exists. The 2026-05-19 deployment misalignment shipped four
 * "v1.0.x" PRs as v0.28.122–v0.28.125 patches because the workflow had no
 * concept of "we are in a holding pattern" or "this is a major-version arc."
 * Every PR was a patch by definition. Layer 1 made package.json the version
 * authority; Layer 2 (this script) makes the release-tier file the publish
 * authority. Together they let an operator declare "no deploy" in code that
 * the workflow physically honors.
 *
 * Allowed tier values:
 *   "patch" — auto-publish on every NEXT.md-bearing PR (current default).
 *   "minor" — auto-publish only when LOCAL.minor > NPM.minor.
 *   "major" — auto-publish only when LOCAL.major > NPM.major AND Layer 5
 *             multi-signatures are present. Layer 5 is not yet shipped, so
 *             this tier currently blocks until Layer 5 lands.
 *   "hold"  — auto-publish DISABLED. Used during major-feature work, after
 *             an incident, or whenever the operator wants to pause shipping.
 *
 * Missing file → defaults to "patch" (the pre-Layer-2 behavior). This keeps
 * the script safe for older checkouts that haven't been migrated.
 *
 * Usage:
 *   node scripts/resolve-release-tier.mjs <localVersion> <npmVersion>
 *     [--config-path <path>]
 *   → exit 0 + prints "allow" to stdout when publish is permitted
 *   → exit 0 + prints "skip" to stdout when tier blocks (workflow should
 *     skip cleanly, not fail the run; reason goes to stderr)
 *   → exit 2 on bad usage / invalid tier file (workflow should fail loudly)
 *
 * Exported as a function for unit testing.
 */

import { readFileSync, existsSync } from 'node:fs';

const VALID_TIERS = ['patch', 'minor', 'major', 'hold'];

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
 * Compare major / minor components only.
 * @param {string} a
 * @param {string} b
 * @returns {"gt"|"eq"|"lt"}
 */
function compareMajorMinor(a, b, depth) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < depth; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 'gt';
    if (x < y) return 'lt';
  }
  return 'eq';
}

/**
 * @typedef {{ tier: "patch"|"minor"|"major"|"hold", reason?: string, setAt?: string, setBy?: string }} TierConfig
 * @typedef {{ decision: "allow"|"skip", reason: string, tier: string }} Resolution
 */

/**
 * @param {unknown} raw parsed JSON
 * @returns {TierConfig}
 */
export function validateTierConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('release-tier.json must be a JSON object');
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const tier = obj.tier;
  if (typeof tier !== 'string' || !VALID_TIERS.includes(tier)) {
    throw new Error(
      `release-tier.json: invalid tier "${String(tier)}"; must be one of ${VALID_TIERS.join(', ')}`
    );
  }
  return /** @type {TierConfig} */ (obj);
}

/**
 * Read the release-tier config. Missing file → defaults to patch.
 * @param {string} configPath
 * @returns {TierConfig}
 */
export function readTierConfig(configPath) {
  if (!existsSync(configPath)) {
    return { tier: 'patch', reason: 'no .instar/release-tier.json present; defaulting to patch (pre-Layer-2 behavior)' };
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  return validateTierConfig(raw);
}

/**
 * Decide whether the current publish attempt is allowed by the declared tier.
 * @param {TierConfig} config
 * @param {string} localVersion package.json
 * @param {string} npmVersion `npm view instar version`
 * @returns {Resolution}
 */
export function resolveReleaseTier(config, localVersion, npmVersion) {
  const { tier } = config;

  if (tier === 'hold') {
    return {
      decision: 'skip',
      tier,
      reason: `tier=hold: auto-publish is paused${config.reason ? ` (${config.reason})` : ''}. Change .instar/release-tier.json to "patch" / "minor" / "major" to resume.`,
    };
  }

  if (tier === 'patch') {
    return { decision: 'allow', tier, reason: 'tier=patch: routine maintenance line' };
  }

  if (tier === 'minor') {
    const cmp = compareMajorMinor(localVersion, npmVersion, 2);
    if (cmp === 'gt') {
      return { decision: 'allow', tier, reason: `tier=minor: package.json (${localVersion}) declares a minor leap over npm (${npmVersion})` };
    }
    return {
      decision: 'skip',
      tier,
      reason: `tier=minor: package.json (${localVersion}) does not declare a minor leap over npm (${npmVersion}). Bump package.json minor or change tier to "patch".`,
    };
  }

  if (tier === 'major') {
    // Layer 5 multi-signature gate not yet implemented. Until it ships, the
    // major tier blocks publishes outright. This is intentional: the spec
    // requires both LOCAL.major > NPM.major AND signature verification before
    // a major publish. Lacking the latter, we refuse rather than ship a
    // major version with only single-agent authority.
    return {
      decision: 'skip',
      tier,
      reason: 'tier=major: multi-signature requirement (Layer 5) not yet implemented; major publishes are blocked until that layer lands.',
    };
  }

  // Defensive: validateTierConfig rejects unknown tiers, but TypeScript-style
  // exhaustiveness still wants a fallback.
  throw new Error(`unhandled tier "${tier}"`);
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let configPath = '.instar/release-tier.json';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config-path') {
      configPath = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  const [localVersion, npmVersion] = positional;
  if (!localVersion || !npmVersion) {
    process.stderr.write('usage: resolve-release-tier.mjs <localVersion> <npmVersion> [--config-path <path>]\n');
    process.exit(2);
  }
  try {
    const config = readTierConfig(configPath);
    const result = resolveReleaseTier(config, localVersion, npmVersion);
    process.stderr.write(`${result.reason}\n`);
    process.stdout.write(result.decision);
  } catch (err) {
    process.stderr.write(`resolve-release-tier: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
