/**
 * Tier-1 regression guard for the pnpm dependency build-script allowlist.
 *
 * pnpm >= 11 refuses to run a dependency's install/postinstall script unless it
 * is explicitly allowed, and exits NON-ZERO (ERR_PNPM_IGNORED_BUILDS) while any
 * remain unresolved. Before `pnpm-workspace.yaml` was committed, a fresh
 * checkout could not `pnpm install` at all — reproduced on v1.3.1071 with
 * pnpm 11.5.1: exit 1 listing 13 ignored build scripts.
 *
 * These tests exist because the failure is INVISIBLE to CI: ci.yml installs with
 * `npm ci`, which runs every one of these scripts with no gate. So a green build
 * says nothing about the pnpm path that CLAUDE.md's Quick Reference tells every
 * agent to use. Deleting this file, or flipping a native package to false, would
 * re-break the documented path without turning CI red — hence a guard here
 * rather than trust that nobody touches it.
 *
 * NOTE the location: pnpm 11 reads this from `pnpm-workspace.yaml`. The same
 * allowlist placed in package.json under `pnpm.onlyBuiltDependencies` is SILENTLY
 * IGNORED — verified directly (all 13 scripts still reported as ignored, install
 * still exit 1). The second test pins that, so a future refactor cannot "tidy"
 * the config into package.json and quietly reintroduce the failure.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../..');
const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');

/**
 * Packages whose install script produces a runtime artifact — a compiled native
 * binding or a downloaded platform binary. Omitting any of these leaves the
 * package broken at runtime rather than merely unbuilt.
 */
const REQUIRED_BUILDS = [
  'better-sqlite3',
  'bufferutil',
  'cloudflared',
  'cpu-features',
  'esbuild',
  'onnxruntime-node',
  'sharp',
  'ssh2',
  'utf-8-validate',
] as const;

function readAllowBuilds(): Record<string, unknown> {
  const raw = fs.readFileSync(workspacePath, 'utf8');
  const parsed = load(raw) as { allowBuilds?: Record<string, unknown> } | null;
  expect(parsed, 'pnpm-workspace.yaml must parse as a YAML mapping').toBeTruthy();
  const allow = parsed?.allowBuilds;
  expect(allow, 'pnpm-workspace.yaml must declare an allowBuilds mapping').toBeTruthy();
  return allow as Record<string, unknown>;
}

describe('pnpm build-script allowlist', () => {
  it('pnpm-workspace.yaml exists at the repo root', () => {
    expect(
      fs.existsSync(workspacePath),
      'pnpm-workspace.yaml is required — without it `pnpm install` exits non-zero '
        + 'with ERR_PNPM_IGNORED_BUILDS on a fresh checkout',
    ).toBe(true);
  });

  it('allows every dependency whose install script produces a runtime artifact', () => {
    const allow = readAllowBuilds();
    for (const pkg of REQUIRED_BUILDS) {
      expect(
        Object.prototype.hasOwnProperty.call(allow, pkg),
        `${pkg} must appear in allowBuilds — its install script compiles a native `
          + 'binding or downloads a platform binary',
      ).toBe(true);
      expect(
        allow[pkg],
        `${pkg} must be allowed (true). Setting it false leaves it unbuilt and `
          + 'broken at runtime, and pnpm will not warn you at call time.',
      ).toBe(true);
    }
  });

  it('records an explicit true/false decision for every entry — never a placeholder', () => {
    const allow = readAllowBuilds();
    const entries = Object.entries(allow);
    expect(entries.length, 'allowBuilds must not be empty').toBeGreaterThan(0);
    for (const [pkg, value] of entries) {
      // pnpm's own generated template writes the literal string
      // "set this to true or false" for each entry. That template is NOT a
      // decision: with it in place the install still fails. Only real booleans
      // count, so a half-finished file cannot pass for a completed one.
      expect(
        typeof value,
        `${pkg} must be a boolean, not ${JSON.stringify(value)} — pnpm's generated `
          + 'placeholder text is not a decision and does not resolve the error',
      ).toBe('boolean');
    }
  });

  it('does NOT rely on package.json pnpm.onlyBuiltDependencies, which pnpm 11 ignores', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { pnpm?: { onlyBuiltDependencies?: unknown } };
    // Verified empirically on pnpm 11.5.1: this field has no effect — all 13
    // build scripts were still reported ignored and the install still exited 1.
    // Keeping it would read as configuration while doing nothing, so the guard
    // asserts the allowlist lives ONLY in pnpm-workspace.yaml.
    expect(
      pkg.pnpm?.onlyBuiltDependencies,
      'package.json must not carry onlyBuiltDependencies — pnpm 11 ignores it, so '
        + 'it would be dead config that looks authoritative. Use pnpm-workspace.yaml.',
    ).toBeUndefined();
  });
});
