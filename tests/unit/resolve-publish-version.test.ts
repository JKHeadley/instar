/**
 * Verifies the publish-version resolution policy added after the 2026-05-19
 * v1.0.0 deployment misalignment incident. The release workflow must honor
 * package.json when the operator has intentionally bumped it (LOCAL > NPM),
 * and fall back to a routine patch bump otherwise. The old behavior — always
 * derive from npm, ignore package.json — made an operator-intended major bump
 * structurally impossible and is the exact failure this policy closes.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import { compareSemver, resolvePublishVersion } from '../../scripts/resolve-publish-version.mjs';

describe('compareSemver', () => {
  it('detects greater-than across each semver field', () => {
    expect(compareSemver('1.0.0', '0.28.125')).toBe('gt');
    expect(compareSemver('0.29.0', '0.28.125')).toBe('gt');
    expect(compareSemver('0.28.126', '0.28.125')).toBe('gt');
  });

  it('detects equality', () => {
    expect(compareSemver('0.28.125', '0.28.125')).toBe('eq');
  });

  it('detects less-than (stale package.json)', () => {
    expect(compareSemver('0.28.124', '0.28.125')).toBe('lt');
    expect(compareSemver('0.27.99', '0.28.0')).toBe('lt');
  });
});

describe('resolvePublishVersion', () => {
  it('honors an operator-intended major bump (the v1.0.0 cut)', () => {
    const r = resolvePublishVersion('1.0.0', '0.28.125');
    expect(r.version).toBe('1.0.0');
    expect(r.reason).toBe('operator-intended');
  });

  it('honors an operator-intended minor bump', () => {
    const r = resolvePublishVersion('0.29.0', '0.28.125');
    expect(r.version).toBe('0.29.0');
    expect(r.reason).toBe('operator-intended');
  });

  it('routine patch bump when package.json equals the last release', () => {
    const r = resolvePublishVersion('0.28.125', '0.28.125');
    expect(r.version).toBe('0.28.126');
    expect(r.reason).toBe('routine-patch');
  });

  it('never downgrades when package.json is stale (queued-run case)', () => {
    const r = resolvePublishVersion('0.28.124', '0.28.125');
    expect(r.version).toBe('0.28.126');
    expect(r.reason).toBe('routine-patch');
  });

  it('handles an unpublished package (npm 0.0.0)', () => {
    const r = resolvePublishVersion('1.0.0', '0.0.0');
    expect(r.version).toBe('1.0.0');
    expect(r.reason).toBe('operator-intended');
  });

  it('regression: the exact 2026-05-19 incident input now yields 1.0.0', () => {
    // package.json was bumped to 1.0.13 in the PR; npm was 0.28.124. The old
    // workflow produced 0.28.125. The policy must now honor 1.0.13.
    const r = resolvePublishVersion('1.0.13', '0.28.124');
    expect(r.version).toBe('1.0.13');
    expect(r.reason).toBe('operator-intended');
  });
});
