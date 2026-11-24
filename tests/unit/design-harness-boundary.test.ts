import { describe, expect, it } from 'vitest';
import { classifyHarness, isToolchainPackage } from '../../src/localVerify/harnessClassifier.js';

describe('design verifier trust boundary', () => {
  it.each(['src/designGate/evidenceBinding.ts', 'scripts/design/gate.mjs',
    'docs/design/screens.json', 'docs/design/coverage.json', 'docs/design/rule-ids.lock.json',
    'tests/design/harness/accountsServer.ts', 'tests/design/seeds/accounts.json', 'tests/design/fonts/inter.woff2',
  ])('routes changes to %s through existing harness review', path => {
    expect(classifyHarness({ changedPaths: [path] }).harnessChanging).toBe(true);
  });
  it.each(['playwright-core', 'axe-core'])('classifies %s as verifier toolchain', name => {
    expect(isToolchainPackage(name)).toBe(true);
  });
  it('preserves ordinary UI and unrelated documentation classification', () => {
    expect(classifyHarness({ changedPaths: ['dashboard/console/accounts.js', 'docs/design/opt-in-heartbeat.md'] }).harnessChanging).toBe(false);
    expect(isToolchainPackage('playwright-core-not-a-package')).toBe(false);
    expect(isToolchainPackage('axe-core-helper')).toBe(false);
  });
});
