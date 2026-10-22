/**
 * Tier-1 tests for the harness-changing / protected-path classifier (spec
 * local-verify-merge-authority.md §2 "Harness-changing PRs").
 */

import { describe, it, expect } from 'vitest';
import { classifyHarness, protectedPath, lifecycleScriptFiles } from '../../../src/localVerify/harnessClassifier.js';
import { PROTECTED_PATH_PREFIXES } from '../../../src/monitoring/greenPrAutomergeWiring.js';

const PKG = {
  name: 'instar',
  scripts: { test: 'vitest run', postinstall: 'node scripts/fix-better-sqlite3.cjs' },
  dependencies: { express: '^4.0.0' },
  devDependencies: { vitest: '^2.1.9', typescript: '^5.9.3' },
};
const j = (o: unknown) => JSON.stringify(o, null, 2);

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { devDependencies: { vitest: '^2.1.9', typescript: '^5.9.3' } },
    'node_modules/vitest': { version: '2.1.9', resolved: 'https://r/vitest-2.1.9.tgz', integrity: 'sha512-a' },
    'node_modules/@vitest/runner': { version: '2.1.9', integrity: 'sha512-b' },
    'node_modules/express': { version: '4.21.0', integrity: 'sha512-c' },
  },
};

describe('classifyHarness: paths', () => {
  it.each([
    'scripts/local-verify.mjs', 'scripts/safe-merge.mjs', 'src/localVerify/record.ts',
    'src/monitoring/greenPrLogic.ts', 'src/monitoring/GreenPrAutoMerger.ts', 'src/monitoring/MergeRunner.ts',
    'src/monitoring/greenPrAutomergeWiring.ts', 'vitest.config.ts', 'vitest.e2e.config.ts',
    'tests/setup/build-dist.globalSetup.ts', 'tests/vitest-setup.ts', '.npmrc', 'patches/foo.patch',
    'tsconfig.json', 'tsconfig.build.json', 'scripts/fix-better-sqlite3.cjs',
  ])('%s is harness-changing', (p) => {
    expect(classifyHarness({ changedPaths: ['src/core/x.ts', p] })).toEqual({ harnessChanging: true, reasons: [`path:${p}`] });
  });
  it('ordinary source and test changes are not', () => {
    expect(classifyHarness({ changedPaths: ['src/core/x.ts', 'tests/unit/x.test.ts', 'docs/a.md', 'src/monitoring/greenPrLogicHelpers.ts'] }))
      .toEqual({ harnessChanging: false, reasons: [] });
  });
  it('an unreadable diff is harness-changing', () => {
    expect(classifyHarness({ changedPaths: null })).toEqual({ harnessChanging: true, reasons: ['diff-unreadable'] });
  });
  it('extra globs are honoured', () => {
    expect(classifyHarness({ changedPaths: ['src/monitoring/requiredContexts.ts'], extraGlobs: ['src/monitoring/requiredContexts.ts'] }).harnessChanging).toBe(true);
  });
});

describe('classifyHarness: package.json', () => {
  const run = (head: object) => classifyHarness({ changedPaths: ['package.json'], packageJson: { base: j(PKG), head: j(head) } });
  it('a version bump outside the toolchain is not harness-changing', () => {
    expect(run({ ...PKG, version: '1.2.3', dependencies: { express: '^4.1.0' } })).toEqual({ harnessChanging: false, reasons: [] });
  });
  it('key reordering alone is not a scripts change', () => {
    expect(run({ ...PKG, scripts: { postinstall: PKG.scripts.postinstall, test: PKG.scripts.test } }).harnessChanging).toBe(false);
  });
  it('a scripts change is', () => {
    expect(run({ ...PKG, scripts: { ...PKG.scripts, test: 'exit 0' } }).reasons).toEqual(['package.json:scripts']);
  });
  it('an overrides change is', () => {
    expect(run({ ...PKG, overrides: { vite: '5.0.0' } }).reasons).toEqual(['package.json:overrides']);
  });
  it('a toolchain dependency change is (vitest, @vitest/*, typescript, tsx)', () => {
    expect(run({ ...PKG, devDependencies: { ...PKG.devDependencies, vitest: '^3.0.0' } }).reasons).toEqual(['package.json:toolchain']);
    expect(run({ ...PKG, devDependencies: { ...PKG.devDependencies, '@vitest/coverage-v8': '^2.1.9' } }).reasons).toEqual(['package.json:toolchain']);
    expect(run({ ...PKG, devDependencies: { ...PKG.devDependencies, tsx: '^4.0.0' } }).reasons).toEqual(['package.json:toolchain']);
  });
  it('unreadable or unparseable package.json is harness-changing', () => {
    expect(classifyHarness({ changedPaths: ['package.json'] }).reasons).toEqual(['package.json:unreadable']);
    expect(classifyHarness({ changedPaths: ['package.json'], packageJson: { base: j(PKG), head: null } }).harnessChanging).toBe(true);
    expect(classifyHarness({ changedPaths: ['package.json'], packageJson: { base: j(PKG), head: '{ nope' } }).harnessChanging).toBe(true);
  });
  it('a file a lifecycle script runs is harness-changing, derived from package.json', () => {
    const pkg = { ...PKG, scripts: { ...PKG.scripts, prepare: 'husky && node ./scripts/prep-hooks.mjs' } };
    expect(lifecycleScriptFiles(pkg)).toEqual(expect.arrayContaining(['scripts/fix-better-sqlite3.cjs', 'scripts/prep-hooks.mjs']));
    expect(classifyHarness({ changedPaths: ['scripts/prep-hooks.mjs'], packageJson: { base: j(pkg), head: j(pkg) } }).reasons)
      .toEqual(['lifecycle-script:scripts/prep-hooks.mjs']);
    // A non-lifecycle script file is not.
    expect(classifyHarness({ changedPaths: ['scripts/other.mjs'], packageJson: { base: j(pkg), head: j(pkg) } }).harnessChanging).toBe(false);
  });
});

describe('classifyHarness: package-lock.json', () => {
  const run = (head: object) => classifyHarness({ changedPaths: ['package-lock.json'], packageLock: { base: j(LOCK), head: j(head) } });
  it('a non-toolchain lock change is not harness-changing', () => {
    expect(run({ ...LOCK, packages: { ...LOCK.packages, 'node_modules/express': { version: '4.22.0', integrity: 'sha512-d' } } }).harnessChanging).toBe(false);
  });
  it('a toolchain version, integrity or nested copy change is', () => {
    expect(run({ ...LOCK, packages: { ...LOCK.packages, 'node_modules/vitest': { ...LOCK.packages['node_modules/vitest'], version: '2.1.10' } } }).reasons)
      .toEqual(['package-lock.json:toolchain']);
    expect(run({ ...LOCK, packages: { ...LOCK.packages, 'node_modules/@vitest/runner': { version: '2.1.9', integrity: 'sha512-EVIL' } } }).harnessChanging).toBe(true);
    expect(run({ ...LOCK, packages: { ...LOCK.packages, 'node_modules/foo/node_modules/typescript': { version: '4.0.0' } } }).harnessChanging).toBe(true);
  });
  it('a v1 lockfile dependencies tree is read too', () => {
    const v1 = { lockfileVersion: 1, dependencies: { foo: { version: '1.0.0', dependencies: { tsx: { version: '4.0.0' } } } } };
    const v1b = { lockfileVersion: 1, dependencies: { foo: { version: '1.0.0', dependencies: { tsx: { version: '4.1.0' } } } } };
    expect(classifyHarness({ changedPaths: ['package-lock.json'], packageLock: { base: j(v1), head: j(v1b) } }).harnessChanging).toBe(true);
  });
  it('an unreadable lockfile is harness-changing', () => {
    expect(classifyHarness({ changedPaths: ['package-lock.json'], packageLock: { base: null, head: j(LOCK) } }).reasons).toEqual(['package-lock.json:unreadable']);
  });
});

describe('protectedPath', () => {
  it('matches the watcher list (directory prefix and exact file)', () => {
    expect(protectedPath(['.github/workflows/ci.yml'], PROTECTED_PATH_PREFIXES)).toBe(true);
    expect(protectedPath(['src/monitoring/MergeRunner.ts'], PROTECTED_PATH_PREFIXES)).toBe(true);
    expect(protectedPath(['docs/audits/a.md'], PROTECTED_PATH_PREFIXES)).toBe(true);
  });
  it('ordinary paths are not protected', () => {
    expect(protectedPath(['src/core/x.ts', 'docs/specs/a.md', '.githubx'], PROTECTED_PATH_PREFIXES)).toBe(false);
  });
  it('glob entries match as globs', () => {
    expect(protectedPath(['src/a/b/Secret.ts'], ['src/**/Secret.ts'])).toBe(true);
    expect(protectedPath(['src/a/b/Other.ts'], ['src/**/Secret.ts'])).toBe(false);
  });
  it('an unreadable diff counts as protected', () => {
    expect(protectedPath(null, PROTECTED_PATH_PREFIXES)).toBe(true);
  });
});
