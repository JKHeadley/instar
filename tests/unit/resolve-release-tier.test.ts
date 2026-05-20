/**
 * Verifies the Layer 2 release-tier gate added after the 2026-05-19 v1.0.0
 * deployment misalignment. The publish workflow must be physically gated by
 * a committed tier declaration. "hold" must block all publishes. "patch"
 * preserves the pre-Layer-2 behavior. "minor" and "major" enforce that the
 * package.json bump actually matches the declared tier, with major
 * additionally blocked until Layer 5 (multi-signature) ships.
 *
 * Layer 2 closes the path that allowed the 2026-05-19 incident: there was no
 * way to declare "no deploy" in code the workflow honored. With this layer,
 * a one-line tier change is the operator's authoritative signal.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import {
  compareSemver,
  validateTierConfig,
  readTierConfig,
  resolveReleaseTier,
} from '../../scripts/resolve-release-tier.mjs';

// Tests use mkdtempSync(tmpdir()) — the OS handles cleanup, so the test does
// not call rmSync (the lint forbids direct destructive fs from non-funnel
// callers, and a pure-logic test should not pull in SafeFsExecutor just for
// fixture teardown).
function withTempConfig(body: { tier?: unknown; reason?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockdown-tier-'));
  const path = join(dir, 'release-tier.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('validateTierConfig', () => {
  it('accepts each of the four valid tiers', () => {
    for (const tier of ['patch', 'minor', 'major', 'hold']) {
      expect(validateTierConfig({ tier })).toMatchObject({ tier });
    }
  });

  it('rejects an unknown tier', () => {
    expect(() => validateTierConfig({ tier: 'release' })).toThrow(/invalid tier/);
  });

  it('rejects a missing tier field', () => {
    expect(() => validateTierConfig({})).toThrow(/invalid tier/);
  });

  it('rejects non-object input', () => {
    expect(() => validateTierConfig(null)).toThrow(/JSON object/);
    expect(() => validateTierConfig('hold')).toThrow(/JSON object/);
  });
});

describe('readTierConfig', () => {
  it('defaults to patch when the file is missing (pre-Layer-2 checkouts)', () => {
    const result = readTierConfig('/path/that/does/not/exist/release-tier.json');
    expect(result.tier).toBe('patch');
    expect(result.reason).toMatch(/no \.instar\/release-tier\.json/);
  });

  it('reads a valid tier file from disk', () => {
    const path = withTempConfig({ tier: 'hold', reason: 'v1.0.0 work in progress' });
    const result = readTierConfig(path);
    expect(result.tier).toBe('hold');
    expect(result.reason).toBe('v1.0.0 work in progress');
  });

  it('throws on an invalid tier file', () => {
    const path = withTempConfig({ tier: 'bogus' });
    expect(() => readTierConfig(path)).toThrow(/invalid tier/);
  });
});

describe('resolveReleaseTier — hold', () => {
  it('blocks publish under tier=hold regardless of versions', () => {
    const r = resolveReleaseTier({ tier: 'hold', reason: 'major arc' }, '1.0.0', '0.28.125');
    expect(r.decision).toBe('skip');
    expect(r.tier).toBe('hold');
    expect(r.reason).toMatch(/tier=hold/);
    expect(r.reason).toMatch(/major arc/);
  });

  it('hold reason is omitted gracefully when not provided', () => {
    const r = resolveReleaseTier({ tier: 'hold' }, '1.0.0', '0.28.125');
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/tier=hold/);
  });
});

describe('resolveReleaseTier — patch', () => {
  it('allows routine patch releases (pre-Layer-2 behavior preserved)', () => {
    const r = resolveReleaseTier({ tier: 'patch' }, '1.0.13', '1.0.13');
    expect(r.decision).toBe('allow');
    expect(r.tier).toBe('patch');
  });

  it('allows patch tier even when package.json declares a major leap (Layer 1 catches that separately)', () => {
    // Note: Layer 2's job is tier-vs-bump matching for minor/major. A
    // declared 1.0.0 bump under tier=patch is allowed BY THIS LAYER; the
    // operator deliberately set tier=patch so Layer 1 honors the LOCAL value.
    // This split keeps each layer focused.
    const r = resolveReleaseTier({ tier: 'patch' }, '1.0.0', '0.28.125');
    expect(r.decision).toBe('allow');
  });
});

describe('resolveReleaseTier — minor', () => {
  it('allows when package.json declares a minor leap', () => {
    const r = resolveReleaseTier({ tier: 'minor' }, '1.1.0', '1.0.13');
    expect(r.decision).toBe('allow');
    expect(r.tier).toBe('minor');
  });

  it('blocks when package.json is still on the same minor', () => {
    const r = resolveReleaseTier({ tier: 'minor' }, '1.0.14', '1.0.13');
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/does not declare a minor leap/);
  });

  it('blocks when package.json is below npm minor', () => {
    const r = resolveReleaseTier({ tier: 'minor' }, '0.28.0', '1.0.13');
    expect(r.decision).toBe('skip');
  });
});

describe('resolveReleaseTier — major (Layer 5 not yet shipped)', () => {
  it('blocks even when package.json declares a major leap, until Layer 5 ships', () => {
    const r = resolveReleaseTier({ tier: 'major' }, '2.0.0', '1.0.13');
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/Layer 5/);
  });

  it('blocks without a major leap (the always-block case)', () => {
    const r = resolveReleaseTier({ tier: 'major' }, '1.0.14', '1.0.13');
    expect(r.decision).toBe('skip');
  });
});

describe('compareSemver (re-exported)', () => {
  it('detects major leaps', () => {
    expect(compareSemver('1.0.0', '0.28.125')).toBe('gt');
  });

  it('detects equality', () => {
    expect(compareSemver('1.0.13', '1.0.13')).toBe('eq');
  });

  it('detects downgrade', () => {
    expect(compareSemver('0.28.124', '0.28.125')).toBe('lt');
  });
});

describe('regression — 2026-05-19 incident under Layer 2', () => {
  it('a session marked no-deploy with tier=hold blocks the four v0.28.122–v0.28.125 publishes', () => {
    // The incident sequence: package.json was bumped to 1.0.13 across four
    // PRs during a session the operator marked "no deploy." Under Layer 2,
    // tier=hold would have blocked every single publish regardless of the
    // package.json value. This is the headline guarantee.
    const r = resolveReleaseTier(
      { tier: 'hold', reason: 'no-deploy session per operator instruction' },
      '1.0.13',
      '0.28.121',
    );
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/tier=hold/);
  });
});
