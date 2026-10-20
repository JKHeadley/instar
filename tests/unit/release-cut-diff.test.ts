// safe-git-allow: test file — direct execFileSync builds scratch git repos so the
//   real pre-push gate can run against a real release-cut diff. fs cleanup is the
//   per-test tmpdir.

/**
 * Unit + integration tests — release-cut recognition for pre-push gate §3b.
 *
 * The "chore: release vX" cut commit bumps package.json / package-lock.json and
 * consumes the release-note fragments. Since §3b's release-relevance moved to
 * the shared predicate (which counts package.json), every cut tripped "release-
 * relevant file(s) changed but no release-note fragment". These tests pin the
 * narrow exemption: a REAL cut passes, and anything that is not purely a cut
 * still fails exactly as before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyReleaseCut, compareSemver, jsonEqual } from '../../scripts/release-cut-diff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ── Pure classifier ───────────────────────────────────────────────────

const PKG_OLD = { name: 'instar', version: '1.3.1358', dependencies: { a: '^1.0.0' } };
const PKG_NEW = { ...PKG_OLD, version: '1.3.1359' };
const LOCK_OLD = {
  name: 'instar', version: '1.3.1358', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'instar', version: '1.3.1358', dependencies: { a: '^1.0.0' } }, 'node_modules/a': { version: '1.0.0' } },
};
const LOCK_NEW = {
  ...LOCK_OLD, version: '1.3.1359',
  packages: { ...LOCK_OLD.packages, '': { ...LOCK_OLD.packages[''], version: '1.3.1359' } },
};

function readers(base: Record<string, unknown>, head: Record<string, unknown>) {
  const r = (m: Record<string, unknown>) => (p: string) => (p in m ? JSON.stringify(m[p], null, 2) : null);
  return { readBase: r(base), readHead: r(head) };
}

const CUT_ENTRIES = [
  { status: 'M', path: 'package-lock.json' },
  { status: 'M', path: 'package.json' },
  { status: 'A', path: 'upgrades/1.3.1359.md' },
  { status: 'D', path: 'upgrades/next/some-fix.md' },
];

function classify(entries: Array<{ status: string; path: string }>, base = {}, head = {}) {
  return classifyReleaseCut({
    entries,
    ...readers(
      { 'package.json': PKG_OLD, 'package-lock.json': LOCK_OLD, ...base },
      { 'package.json': PKG_NEW, 'package-lock.json': LOCK_NEW, ...head },
    ),
  });
}

describe('classifyReleaseCut (pure)', () => {
  it('recognises a real cut: version-only package.json + lock, one versioned guide, consumed fragment', () => {
    const v = classify(CUT_ENTRIES);
    expect(v).toEqual({ isCut: true, version: '1.3.1359', reason: 'release cut v1.3.1359' });
  });

  it('recognises a cut that consumed several fragments and a legacy NEXT.md, without a lockfile change', () => {
    const v = classify([
      { status: 'M', path: 'package.json' },
      { status: 'A', path: 'upgrades/1.3.1359.md' },
      { status: 'D', path: 'upgrades/next/a.md' },
      { status: 'D', path: 'upgrades/next/b.md' },
      { status: 'D', path: 'upgrades/NEXT.md' },
    ]);
    expect(v.isCut).toBe(true);
  });

  it('REJECTS package.json with a dependency change alongside the version bump', () => {
    const v = classify(CUT_ENTRIES, {}, {
      'package.json': { ...PKG_NEW, dependencies: { a: '^2.0.0' } },
    });
    expect(v.isCut).toBe(false);
    expect(v.reason).toContain('more than the "version" field');
  });

  it('REJECTS package.json with a scripts change (anything beyond "version")', () => {
    const v = classify(CUT_ENTRIES, {}, { 'package.json': { ...PKG_NEW, scripts: { x: 'y' } } });
    expect(v.isCut).toBe(false);
  });

  it('REJECTS a lockfile that changes a dependency entry', () => {
    const v = classify(CUT_ENTRIES, {}, {
      'package-lock.json': { ...LOCK_NEW, packages: { ...LOCK_NEW.packages, 'node_modules/a': { version: '1.0.1' } } },
    });
    expect(v.isCut).toBe(false);
    expect(v.reason).toContain('package-lock.json');
  });

  it('REJECTS a lockfile whose version does not match the new package.json version', () => {
    const v = classify(CUT_ENTRIES, {}, { 'package-lock.json': { ...LOCK_NEW, version: '1.3.1360' } });
    expect(v.isCut).toBe(false);
  });

  it('REJECTS a lockfile whose packages[""].version does not match', () => {
    const v = classify(CUT_ENTRIES, {}, {
      'package-lock.json': { ...LOCK_NEW, packages: { ...LOCK_NEW.packages, '': { ...LOCK_NEW.packages[''], version: '1.3.1358' } } },
    });
    expect(v.isCut).toBe(false);
  });

  it('REJECTS a cut plus any src/ change', () => {
    const v = classify([...CUT_ENTRIES, { status: 'M', path: 'src/core/Thing.ts' }]);
    expect(v.isCut).toBe(false);
    expect(v.reason).toContain('src/core/Thing.ts');
  });

  it('REJECTS a cut plus a scripts/ or workflow change', () => {
    expect(classify([...CUT_ENTRIES, { status: 'A', path: 'scripts/x.mjs' }]).isCut).toBe(false);
    expect(classify([...CUT_ENTRIES, { status: 'M', path: '.github/workflows/publish.yml' }]).isCut).toBe(false);
  });

  it('REJECTS when the added guide does not match the new version', () => {
    const entries = CUT_ENTRIES.map((e) => (e.status === 'A' ? { ...e, path: 'upgrades/1.3.1360.md' } : e));
    expect(classify(entries).isCut).toBe(false);
  });

  it('REJECTS when no versioned guide is added, or when two are', () => {
    expect(classify(CUT_ENTRIES.filter((e) => e.status !== 'A')).isCut).toBe(false);
    expect(classify([...CUT_ENTRIES, { status: 'A', path: 'upgrades/1.3.1358.md' }]).isCut).toBe(false);
  });

  it('REJECTS when the version did not change', () => {
    const v = classify(CUT_ENTRIES, {}, { 'package.json': PKG_OLD, 'package-lock.json': LOCK_OLD });
    expect(v.isCut).toBe(false);
  });

  it('REJECTS a version that goes DOWN (must increase, not merely differ)', () => {
    const v = classify(
      CUT_ENTRIES.map((e) => (e.status === 'A' ? { ...e, path: 'upgrades/1.3.1357.md' } : e)),
      {},
      {
        'package.json': { ...PKG_NEW, version: '1.3.1357' },
        'package-lock.json': { ...LOCK_NEW, version: '1.3.1357', packages: { ...LOCK_NEW.packages, '': { ...LOCK_NEW.packages[''], version: '1.3.1357' } } },
      },
    );
    expect(v.isCut).toBe(false);
    expect(v.reason).toContain('does not increase');
  });

  it('compares versions numerically, not as strings (1.3.999 → 1.3.1000 is an increase)', () => {
    const lockAt = (ver: string) => ({ ...LOCK_OLD, version: ver, packages: { ...LOCK_OLD.packages, '': { ...LOCK_OLD.packages[''], version: ver } } });
    const v = classify(
      CUT_ENTRIES.map((e) => (e.status === 'A' ? { ...e, path: 'upgrades/1.3.1000.md' } : e)),
      { 'package.json': { ...PKG_OLD, version: '1.3.999' }, 'package-lock.json': lockAt('1.3.999') },
      { 'package.json': { ...PKG_OLD, version: '1.3.1000' }, 'package-lock.json': lockAt('1.3.1000') },
    );
    expect(v.isCut).toBe(true);
    expect(compareSemver('1.3.999', '1.3.1000')).toBeLessThan(0);
  });

  it('REJECTS a non-X.Y.Z version', () => {
    const v = classify(
      CUT_ENTRIES.map((e) => (e.status === 'A' ? { ...e, path: 'upgrades/1.3.1359-rc.1.md' } : e)),
      {},
      { 'package.json': { ...PKG_NEW, version: '1.3.1359-rc.1' } },
    );
    expect(v.isCut).toBe(false);
  });

  it('REJECTS a modified (not deleted) fragment, and a deletion outside upgrades/next/', () => {
    expect(classify([...CUT_ENTRIES, { status: 'M', path: 'upgrades/next/other.md' }]).isCut).toBe(false);
    expect(classify([...CUT_ENTRIES, { status: 'D', path: 'upgrades/side-effects/x.md' }]).isCut).toBe(false);
  });

  it('REJECTS when package.json is absent from the diff, or unparseable', () => {
    expect(classify(CUT_ENTRIES.filter((e) => e.path !== 'package.json')).isCut).toBe(false);
    const v = classifyReleaseCut({
      entries: CUT_ENTRIES,
      readBase: () => '{not json',
      readHead: () => '{not json',
    });
    expect(v.isCut).toBe(false);
  });

  it('REJECTS an empty diff', () => {
    expect(classify([]).isCut).toBe(false);
  });

  it('jsonEqual compares structurally', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

// ── Integration: the real gate against a real git release-cut diff ────

const GUIDE = (version: string) => [
  `# Upgrade Guide — v${version}`,
  '',
  '## What Changed',
  '',
  'Fixes a bug in the scheduler.',
  '',
  '## Evidence',
  '',
  'Reproduced first: with the old code the scheduler skipped every job whose cron',
  'expression contained a step value, so a job set to every 15 minutes never ran at',
  'all. Observed 0 runs across a 2 hour window. After the fix the same job ran 8',
  'times in the same window. Reverting the one-line change reproduced the failure',
  'again, which is how the cause was confirmed rather than assumed.',
  '',
  '## What to Tell Your User',
  '',
  'Your agent picked up a small repair. Nothing changes about how it talks to you.',
  '',
  '## Summary of New Capabilities',
  '',
  '| Capability | How to Use |',
  '|-----------|-----------|',
  '| Repair | automatic |',
  '',
].join('\n');

/** An env with no git-repo pointers leaked from an outer hook (GIT_DIR etc.). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '', NODE_ENV: 'test' };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_')) delete env[k];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

describe('Pre-push gate integration — release cut commits (§3b exemption)', () => {
  let scratch: string;
  const env = cleanEnv();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: scratch, env, stdio: 'pipe', encoding: 'utf-8' });
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
    fs.writeFileSync(path.join(scratch, rel), content);
  };
  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-cut-'));
    for (const file of ['pre-push-gate.js', 'upgrade-guide-validator.mjs', 'assemble-next-md.mjs', 'release-relevant-paths.mjs', 'release-cut-diff.mjs', 'lint-no-direct-destructive.js', 'lint-no-direct-llm-http.js']) {
      write(`scripts/${file}`, fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf-8'));
    }
    fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
    write('src/.keep', '');
    write('upgrades/side-effects/some-fix.md', '# Side-Effects Review (test scratch)\n');
    write('package.json', json({ name: 'instar-test', version: '0.28.998', dependencies: { a: '^1.0.0' } }));
    write('package-lock.json', json({
      name: 'instar-test', version: '0.28.998', lockfileVersion: 3, requires: true,
      packages: { '': { name: 'instar-test', version: '0.28.998', dependencies: { a: '^1.0.0' } } },
    }));
    write('upgrades/0.28.998.md', GUIDE('0.28.998'));
    write('upgrades/next/some-fix.md', GUIDE('next').replace(/^# .*\n/, ''));
    git('init', '--initial-branch=main', '.');
    git('add', '-A');
    git('commit', '-m', 'base: a merged fix with its fragment');
    git('checkout', '-b', 'release');
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Perform what publish.yml does to cut 0.28.999. */
  function cut() {
    const pkg = JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf-8'));
    pkg.version = '0.28.999';
    write('package.json', json(pkg));
    const lock = JSON.parse(fs.readFileSync(path.join(scratch, 'package-lock.json'), 'utf-8'));
    lock.version = '0.28.999';
    lock.packages[''].version = '0.28.999';
    write('package-lock.json', json(lock));
    fs.renameSync(path.join(scratch, 'upgrades/next/some-fix.md'), path.join(scratch, 'upgrades/0.28.999.md'));
    write('upgrades/0.28.999.md', GUIDE('0.28.999'));
  }

  function commitAndRunGate() {
    git('add', '-A');
    git('commit', '-m', 'chore: release v0.28.999 [skip ci]');
    const r = spawnSync(process.execPath, [path.join(scratch, 'scripts', 'pre-push-gate.js')], { cwd: scratch, env, encoding: 'utf-8' });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }

  it('ACCEPTS a real release cut (package.json + lock version bump, fragment → versioned guide)', () => {
    cut();
    const { status, out } = commitAndRunGate();
    expect(out).toContain('Release cut v0.28.999 recognised');
    expect(out).not.toContain('no release-note fragment was added');
    expect(status).toBe(0);
  });

  it('STILL REFUSES when package.json also changes a dependency', () => {
    cut();
    const pkg = JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf-8'));
    pkg.dependencies.a = '^2.0.0';
    write('package.json', json(pkg));
    const { status, out } = commitAndRunGate();
    expect(out).toContain('no release-note fragment was added');
    expect(out).not.toContain('recognised');
    expect(status).toBe(1);
  });

  it('STILL REFUSES a cut that also carries a src/ change', () => {
    cut();
    write('src/thing.ts', 'export const x = 1;\n');
    const { status, out } = commitAndRunGate();
    expect(out).toContain('no release-note fragment was added');
    expect(out).toContain('src/thing.ts');
    expect(status).toBe(1);
  });

  it('ACCEPTS the 5a90d6be7 shape: the fragment RENAMED (git sees R) into upgrades/<newVersion>.md', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf-8'));
    pkg.version = '0.28.999';
    write('package.json', json(pkg));
    const lock = JSON.parse(fs.readFileSync(path.join(scratch, 'package-lock.json'), 'utf-8'));
    lock.version = '0.28.999';
    lock.packages[''].version = '0.28.999';
    write('package-lock.json', json(lock));
    // Same content plus a title line, as the real cut did (R097).
    const frag = fs.readFileSync(path.join(scratch, 'upgrades/next/some-fix.md'), 'utf-8');
    fs.rmSync(path.join(scratch, 'upgrades/next/some-fix.md'));
    write('upgrades/0.28.999.md', `# Upgrade Guide — v0.28.999\n\n${frag}`);
    const { status, out } = commitAndRunGate();
    // Non-vacuous: git's default (rename-detecting) diff really sees a rename.
    expect(git('diff', '-M', '--name-status', 'main...HEAD')).toMatch(/^R\d+\tupgrades\/next\/some-fix\.md\tupgrades\/0\.28\.999\.md$/m);
    expect(out).toContain('Release cut v0.28.999 recognised');
    expect(status).toBe(0);
  });

  it('a release cut passes ONLY via the exemption: its fragment deletion no longer counts as a fragment', () => {
    cut();
    const { out } = commitAndRunGate();
    // The gate prints this line only when the exemption fired; with §3b's
    // fragment count now limited to ADDED/MODIFIED fragments there is no other
    // way for a cut to pass.
    expect(out).toContain('Release cut v0.28.999 recognised');
  });

  it('REFUSES a src change whose only fragment activity is DELETING someone else\'s fragment', () => {
    fs.rmSync(path.join(scratch, 'upgrades/next/some-fix.md'));
    write('src/thing.ts', 'export const x = 1;\n');
    const { status, out } = commitAndRunGate();
    expect(out).toContain('no release-note fragment was added');
    expect(status).toBe(1);
  });

  it('REFUSES a src change whose fragment was moved OUT of upgrades/next/ (rename does not count)', () => {
    fs.renameSync(path.join(scratch, 'upgrades/next/some-fix.md'), path.join(scratch, 'upgrades/0.28.999.md'));
    write('src/thing.ts', 'export const x = 1;\n');
    const { status, out } = commitAndRunGate();
    expect(out).toContain('no release-note fragment was added');
    expect(status).toBe(1);
  });

  it('a fragment renamed WITHIN upgrades/next/ (and edited) still counts — rename detection is off', () => {
    const frag = fs.readFileSync(path.join(scratch, 'upgrades/next/some-fix.md'), 'utf-8');
    fs.rmSync(path.join(scratch, 'upgrades/next/some-fix.md'));
    write('upgrades/next/some-fix-renamed.md', `${frag}\nAlso tidies a log line.\n`);
    write('src/thing.ts', 'export const x = 1;\n');
    write('tests/thing.test.ts', 'export {};\n');
    git('add', '-A');
    // Non-vacuous: with rename detection on, git reports this as R, which an
    // AM filter would drop.
    expect(git('diff', '--cached', '-M', '--name-status')).toMatch(/^R\d+\tupgrades\/next\/some-fix\.md\tupgrades\/next\/some-fix-renamed\.md$/m);
    const { out } = commitAndRunGate();
    expect(out).not.toContain('no release-note fragment was added');
  });

  it('control: a src change that MODIFIES a fragment still passes §3b', () => {
    fs.appendFileSync(path.join(scratch, 'upgrades/next/some-fix.md'), '\nAlso tidies a log line.\n');
    write('src/thing.ts', 'export const x = 1;\n');
    write('tests/thing.test.ts', 'export {};\n');
    const { out } = commitAndRunGate();
    expect(out).not.toContain('no release-note fragment was added');
  });

  it('control: a bare version bump with no versioned guide is still refused', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf-8'));
    pkg.version = '0.28.999';
    write('package.json', json(pkg));
    const { status, out } = commitAndRunGate();
    expect(out).toContain('no release-note fragment was added');
    expect(status).toBe(1);
  });
});
