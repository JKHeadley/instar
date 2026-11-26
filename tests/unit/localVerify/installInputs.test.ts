/**
 * Tier-1: the install-inputs hash (docs/specs/local-verify-borrowed-slices-count.md, C item 5).
 * A helper installs packages only from merged code, and helps a waiting change only when that
 * change leaves the install inputs as `main` has them. Covered here: the canonical form; the
 * version fields set to empty (a release-only diff hashes equal, any other diff does not); an
 * absent `.npmrc` hashing as an empty one; the listed install-step files; refusal values (never a
 * throw) for a missing or malformed file; linked and local-path packages reported; and the guard
 * that fails when `package.json` gains an install step the in-code list does not cover.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/core/appMediaTypes.js';
import {
  INSTALL_INPUTS_DOMAIN, INSTALL_SCRIPT_NAMES, INSTALL_STEP_COMMANDS, INSTALL_STEP_PATHS, INSTALL_VERSION_FIELDS,
  installInputsHash, isInstallStepPath, uncoveredInstallSteps, type InstallInputFiles,
} from '../../../src/localVerify/installInputs.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');

const PKG = {
  name: 'instar', version: '1.3.1907', type: 'module',
  scripts: { build: 'tsc', postinstall: 'node scripts/fix-better-sqlite3.cjs', prepare: 'husky' },
  dependencies: { 'better-sqlite3': '^12.4.1', express: '^5.1.0' },
  devDependencies: { vitest: '^2.1.9', husky: '^9.1.7' },
};
const LOCK = {
  name: 'instar', version: '1.3.1907', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'instar', version: '1.3.1907', dependencies: { 'better-sqlite3': '^12.4.1', express: '^5.1.0' }, devDependencies: { vitest: '^2.1.9', husky: '^9.1.7' } },
    'node_modules/express': { version: '5.1.0', resolved: 'https://registry.npmjs.org/express/-/express-5.1.0.tgz', integrity: 'sha512-abc' },
    'node_modules/vitest': { version: '2.1.9', resolved: 'https://registry.npmjs.org/vitest/-/vitest-2.1.9.tgz', integrity: 'sha512-def', dev: true },
  },
};
const STEP = [
  { path: 'scripts/fix-better-sqlite3.cjs', content: "require('./resolve-node-binary.cjs');\n" },
  { path: 'scripts/resolve-node-binary.cjs', content: 'module.exports = {};\n' },
  { path: '.husky/pre-commit', content: 'npx lint-staged\n' },
  { path: '.husky/pre-push', content: 'npm test\n' },
];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const inputs = (o: { pkg?: unknown; lock?: unknown; npmrc?: string | null; stepFiles?: InstallInputFiles['stepFiles'] } = {}): InstallInputFiles => ({
  packageJson: JSON.stringify(o.pkg ?? PKG, null, 2),
  packageLock: JSON.stringify(o.lock ?? LOCK, null, 2),
  npmrc: o.npmrc === undefined ? null : o.npmrc,
  stepFiles: o.stepFiles ?? STEP,
});
const hashOf = (o: Parameters<typeof inputs>[0] = {}): string => {
  const r = installInputsHash(inputs(o));
  if (!r.ok) throw new Error(`refused: ${r.refusal}`);
  return r.hash;
};
const BASE = hashOf();

describe('the canonical form', () => {
  it('is the domain line, then a length-framed frame per input in a fixed order, SHA-256', () => {
    const pkg = clone(PKG); pkg.version = '';
    const lock = clone(LOCK); lock.version = ''; lock.packages[''].version = '';
    const h = crypto.createHash('sha256');
    h.update(`${INSTALL_INPUTS_DOMAIN}\n`);
    const frame = (label: string, text: string) => { const b = Buffer.from(text, 'utf8'); h.update(`${label}\n${b.length}\n`); h.update(b); h.update('\n'); };
    frame('package.json', canonicalJson(pkg));
    frame('package-lock.json', canonicalJson(lock));
    frame('.npmrc', '');
    for (const f of [...STEP].sort((a, b) => (a.path < b.path ? -1 : 1))) frame(`step:${f.path}`, f.content);
    expect(INSTALL_INPUTS_DOMAIN).toBe('instar-lv-install-inputs-v1');
    expect(BASE).toBe(h.digest('hex'));
    expect(BASE).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names exactly the three version fields it empties', () => {
    expect(INSTALL_VERSION_FIELDS).toEqual({ 'package.json': [['version']], 'package-lock.json': [['version'], ['packages', '', 'version']] });
  });

  it('does not depend on whitespace, key order, or the order the step files are given in', () => {
    const reordered = { devDependencies: PKG.devDependencies, dependencies: { express: '^5.1.0', 'better-sqlite3': '^12.4.1' }, scripts: PKG.scripts, type: 'module', version: '1.3.1907', name: 'instar' };
    expect(hashOf({ pkg: reordered })).toBe(BASE);
    expect(installInputsHash({ ...inputs(), packageJson: JSON.stringify(PKG), packageLock: JSON.stringify(LOCK) })).toMatchObject({ ok: true, hash: BASE });
    expect(hashOf({ stepFiles: [...STEP].reverse() })).toBe(BASE);
    expect(hashOf({ stepFiles: STEP.map((f) => ({ path: `./${f.path}`, content: Buffer.from(f.content) })) })).toBe(BASE);
  });

  it('a frame cannot be moved between inputs: the same bytes in another file hash differently', () => {
    const a = hashOf({ npmrc: 'x', stepFiles: [{ path: '.husky/pre-commit', content: '' }] });
    const b = hashOf({ npmrc: '', stepFiles: [{ path: '.husky/pre-commit', content: 'x' }] });
    expect(a).not.toBe(b);
  });
});

describe('the version fields', () => {
  it('a release (the three version fields and nothing else) hashes equal', () => {
    const pkg = clone(PKG); pkg.version = '1.3.1908';
    const lock = clone(LOCK); lock.version = '1.3.1908'; lock.packages[''].version = '1.3.1908';
    expect(hashOf({ pkg, lock })).toBe(BASE);
    // Each field alone, too.
    expect(hashOf({ pkg })).toBe(BASE);
    const onlyRoot = clone(LOCK); onlyRoot.packages[''].version = '2.0.0';
    expect(hashOf({ lock: onlyRoot })).toBe(BASE);
  });

  it('a dependency\'s version is not the project\'s version: changing it changes the hash', () => {
    const lock = clone(LOCK); lock.packages['node_modules/express'].version = '5.1.1';
    expect(hashOf({ lock })).not.toBe(BASE);
    const pkg = clone(PKG); pkg.dependencies.express = '^5.2.0';
    expect(hashOf({ pkg })).not.toBe(BASE);
    const integrity = clone(LOCK); integrity.packages['node_modules/express'].integrity = 'sha512-other';
    expect(hashOf({ lock: integrity })).not.toBe(BASE);
  });

  it('a new package, a removed package, a changed install script and a changed name all change the hash', () => {
    const added = clone(LOCK) as typeof LOCK & { packages: Record<string, unknown> };
    added.packages['node_modules/left-pad'] = { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-x' };
    expect(hashOf({ lock: added })).not.toBe(BASE);
    const removed = clone(LOCK) as { packages: Record<string, unknown> }; delete removed.packages['node_modules/vitest'];
    expect(hashOf({ lock: removed })).not.toBe(BASE);
    const script = clone(PKG); script.scripts.postinstall = 'node scripts/fix-better-sqlite3.cjs && node scripts/extra.cjs';
    expect(hashOf({ pkg: script })).not.toBe(BASE);
    const renamed = clone(PKG); renamed.name = 'instar-fork';
    expect(hashOf({ pkg: renamed })).not.toBe(BASE);
  });

  it('a version field that is absent stays absent: adding one is not the same as having none', () => {
    const none = clone(PKG) as Partial<typeof PKG>; delete none.version;
    expect(hashOf({ pkg: none })).not.toBe(BASE);
    // Present with any value, including empty, is one and the same.
    const empty = clone(PKG); empty.version = '';
    expect(hashOf({ pkg: empty })).toBe(BASE);
  });
});

describe('.npmrc and the install-step files', () => {
  it('an absent .npmrc hashes as an empty one; any content changes the hash', () => {
    expect(hashOf({ npmrc: null })).toBe(BASE);
    expect(hashOf({ npmrc: '' })).toBe(BASE);
    expect(hashOf({ npmrc: 'registry=https://registry.example.test/\n' })).not.toBe(BASE);
    expect(hashOf({ npmrc: 'ignore-scripts=true\n' })).not.toBe(hashOf({ npmrc: 'ignore-scripts=false\n' }));
  });

  it('a changed, added or removed install-step file changes the hash; an empty file is not an absent one', () => {
    const edited = STEP.map((f) => (f.path === 'scripts/fix-better-sqlite3.cjs' ? { ...f, content: `${f.content}// edited\n` } : f));
    expect(hashOf({ stepFiles: edited })).not.toBe(BASE);
    expect(hashOf({ stepFiles: [...STEP, { path: '.husky/commit-msg', content: 'x\n' }] })).not.toBe(BASE);
    const without = STEP.filter((f) => f.path !== '.husky/pre-push');
    expect(hashOf({ stepFiles: without })).not.toBe(BASE);
    expect(hashOf({ stepFiles: [...without, { path: '.husky/pre-push', content: '' }] })).not.toBe(hashOf({ stepFiles: without }));
  });

  it('refuses a step file outside the list, an unsafe path, or one path twice', () => {
    expect(installInputsHash(inputs({ stepFiles: [...STEP, { path: 'scripts/other.cjs', content: '' }] }))).toEqual({ ok: false, refusal: 'step-file-not-listed' });
    expect(installInputsHash(inputs({ stepFiles: [{ path: '.husky/../package.json', content: '' }] }))).toEqual({ ok: false, refusal: 'step-file-not-listed' });
    expect(installInputsHash(inputs({ stepFiles: [{ path: '/etc/passwd', content: '' }] }))).toEqual({ ok: false, refusal: 'step-file-not-listed' });
    expect(installInputsHash(inputs({ stepFiles: [{ path: '.husky/a\nb', content: '' }] }))).toEqual({ ok: false, refusal: 'step-file-not-listed' });
    expect(installInputsHash(inputs({ stepFiles: [STEP[0], { path: `./${STEP[0].path}`, content: 'again' }] }))).toEqual({ ok: false, refusal: 'step-file-duplicate' });
  });

  it('isInstallStepPath: a listed file, or anything under a listed folder, and nothing else', () => {
    expect(isInstallStepPath('scripts/fix-better-sqlite3.cjs')).toBe(true);
    expect(isInstallStepPath('scripts/resolve-node-binary.cjs')).toBe(true);
    expect(isInstallStepPath('.husky/pre-commit')).toBe(true);
    expect(isInstallStepPath('.husky/_/husky.sh')).toBe(true);
    expect(isInstallStepPath('scripts/fix-better-sqlite3.cjs.bak')).toBe(false);
    expect(isInstallStepPath('scripts/other.cjs')).toBe(false);
    expect(isInstallStepPath('.huskyx/pre-commit')).toBe(false);
    expect(isInstallStepPath('.husky')).toBe(false);
    expect(isInstallStepPath('package.json')).toBe(false);
  });
});

describe('refusal values, never a throw', () => {
  it('a missing file, a file that does not parse, and a file whose top level is not an object are refused', () => {
    const cases: Array<[Partial<InstallInputFiles>, string]> = [
      [{ packageJson: null }, 'package-json-missing'],
      [{ packageLock: null }, 'package-lock-missing'],
      [{ packageJson: '{"name": "instar",' }, 'package-json-malformed'],
      [{ packageJson: '' }, 'package-json-malformed'],
      [{ packageJson: '[]' }, 'package-json-malformed'],
      [{ packageJson: 'null' }, 'package-json-malformed'],
      [{ packageJson: '"instar"' }, 'package-json-malformed'],
      [{ packageLock: '<<<<<<< HEAD\n{}' }, 'package-lock-malformed'],
      [{ packageLock: '7' }, 'package-lock-malformed'],
      [{ packageLock: JSON.stringify({ ...LOCK, packages: [] }) }, 'package-lock-malformed'],
      [{ packageLock: JSON.stringify({ ...LOCK, packages: { '': 'instar' } }) }, 'package-lock-malformed'],
    ];
    for (const [over, refusal] of cases) {
      let r: ReturnType<typeof installInputsHash> | undefined;
      expect(() => { r = installInputsHash({ ...inputs(), ...over }); }, refusal).not.toThrow();
      expect(r, refusal).toEqual({ ok: false, refusal });
    }
  });

  it('the other side: a lock with no packages map, or with no root entry, still hashes', () => {
    expect(installInputsHash({ ...inputs(), packageLock: JSON.stringify({ name: 'instar', version: '1.0.0', lockfileVersion: 1 }) }).ok).toBe(true);
    expect(installInputsHash({ ...inputs(), packageLock: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/express': { version: '5.1.0' } } }) }).ok).toBe(true);
    expect(installInputsHash({ ...inputs(), packageJson: '{}' }).ok).toBe(true);
  });
});

describe('linked and local-path packages', () => {
  it('reports none for registry packages', () => {
    expect(installInputsHash(inputs())).toMatchObject({ ok: true, localPaths: [] });
  });

  it('reports a file:, link: or relative dependency, a workspace, a linked lock entry and a local folder in the lock', () => {
    const pkg = clone(PKG) as typeof PKG & { dependencies: Record<string, string>; workspaces?: string[]; overrides?: unknown };
    pkg.dependencies.local = 'file:../local-pkg';
    pkg.dependencies.linked = 'link:./vendor/linked';
    pkg.dependencies.rel = './vendor/rel';
    pkg.workspaces = ['packages/*'];
    pkg.overrides = { express: { qs: 'file:./vendor/qs' } };
    const lock = clone(LOCK) as { packages: Record<string, unknown> };
    lock.packages['node_modules/local'] = { resolved: 'packages/local', link: true };
    lock.packages['packages/local'] = { name: 'local', version: '1.0.0' };
    lock.packages['node_modules/tar'] = { version: '1.0.0', resolved: 'file:vendor/tar-1.0.0.tgz' };
    const r = installInputsHash(inputs({ pkg, lock }));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.localPaths).toEqual([
      'package-lock.json link node_modules/local',
      'package-lock.json packages packages/local',
      'package-lock.json resolved node_modules/tar file:vendor/tar-1.0.0.tgz',
      'package.json dependencies linked link:./vendor/linked',
      'package.json dependencies local file:../local-pkg',
      'package.json dependencies rel ./vendor/rel',
      'package.json overrides express>qs file:./vendor/qs',
      'package.json workspaces',
    ]);
    expect(r.ok && r.hash).not.toBe(BASE);
  });
});

describe('the install-step coverage guard', () => {
  it('covers this repository\'s package.json: every install-time script uses only listed commands and listed paths', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    // If this fails: a preinstall / install / postinstall / prepare step was added or changed. Add the
    // repository paths it runs to INSTALL_STEP_PATHS (and its command to INSTALL_STEP_COMMANDS) in
    // src/localVerify/installInputs.ts, so a waiting change that edits them is refused by helpers.
    expect(uncoveredInstallSteps(pkg.scripts)).toEqual([]);
    expect(INSTALL_SCRIPT_NAMES).toEqual(['preinstall', 'install', 'postinstall', 'prepare']);
  });

  it('every listed path exists in this repository, and a listed script requires only listed files', () => {
    for (const p of INSTALL_STEP_PATHS) expect(fs.existsSync(path.join(ROOT, p)), p).toBe(true);
    for (const p of INSTALL_STEP_PATHS.filter((x) => /\.[cm]?js$/.test(x))) {
      const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
      for (const m of text.matchAll(/\brequire\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)|\bfrom\s+(['"])(\.{1,2}\/[^'"]+)\3/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(p), m[2] ?? m[4]));
        expect(isInstallStepPath(target), `${p} requires ${target}`).toBe(true);
      }
    }
    for (const implied of Object.values(INSTALL_STEP_COMMANDS).flat()) expect(INSTALL_STEP_PATHS).toContain(implied);
  });

  it('passes today\'s steps and fails on a path the list does not cover', () => {
    expect(uncoveredInstallSteps({ postinstall: 'node scripts/fix-better-sqlite3.cjs', prepare: 'husky', build: 'tsc && node scripts/anything.mjs' })).toEqual([]);
    expect(uncoveredInstallSteps({ postinstall: 'node scripts/fix-better-sqlite3.cjs && node scripts/patch-native.cjs' })).toEqual(['postinstall: path scripts/patch-native.cjs is not in INSTALL_STEP_PATHS']);
    expect(uncoveredInstallSteps({ preinstall: 'node ./tools/check.mjs' })).toEqual(['preinstall: path ./tools/check.mjs is not in INSTALL_STEP_PATHS']);
    expect(uncoveredInstallSteps({ install: 'node --experimental-strip-types setup.ts' })).toEqual(['install: path setup.ts is not in INSTALL_STEP_PATHS']);
    // A file under a listed folder, and the folder itself, are covered.
    expect(uncoveredInstallSteps({ prepare: 'node .husky/install.mjs' })).toEqual([]);
    expect(uncoveredInstallSteps({ prepare: 'husky .husky/' })).toEqual([]);
    // A settings prefix and flags are read past.
    expect(uncoveredInstallSteps({ postinstall: 'CI=1 node --no-warnings scripts/fix-better-sqlite3.cjs' })).toEqual([]);
  });

  it('fails on a command it does not know, and on shell it cannot read', () => {
    expect(uncoveredInstallSteps({ postinstall: 'patch-package' })).toEqual(['postinstall: command patch-package is not in INSTALL_STEP_COMMANDS']);
    expect(uncoveredInstallSteps({ prepare: 'husky && npm run build' })).toEqual(['prepare: command npm is not in INSTALL_STEP_COMMANDS']);
    expect(uncoveredInstallSteps({ install: 'bash scripts/fix-better-sqlite3.cjs' })).toEqual(['install: command bash is not in INSTALL_STEP_COMMANDS']);
    expect(uncoveredInstallSteps({ postinstall: 'node $(cat tool-path)' })).toEqual(['postinstall: shell syntax the check cannot read']);
    expect(uncoveredInstallSteps({ postinstall: 'node scripts/fix-better-sqlite3.cjs > out.log' })).toEqual(['postinstall: shell syntax the check cannot read']);
    expect(uncoveredInstallSteps({ postinstall: 'node scripts/fix-better-sqlite3.cjs &' })).toEqual(['postinstall: shell syntax the check cannot read']);
    expect(uncoveredInstallSteps({ prepare: 7 })).toEqual(['prepare: not a string']);
    expect(uncoveredInstallSteps('husky')).toEqual(['scripts: not an object']);
  });

  it('a command that reads a folder without naming it must have that folder listed; no install scripts at all is covered', () => {
    expect(uncoveredInstallSteps({ prepare: 'husky' }, ['scripts/fix-better-sqlite3.cjs'])).toEqual(['prepare: husky reads .husky/, which is not in INSTALL_STEP_PATHS']);
    expect(uncoveredInstallSteps({ build: 'tsc', test: 'vitest run' })).toEqual([]);
    expect(uncoveredInstallSteps(undefined)).toEqual([]);
  });
});
