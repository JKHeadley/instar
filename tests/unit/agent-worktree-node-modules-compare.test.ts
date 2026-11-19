/**
 * The root node_modules proof's comparison (spec docs/specs/reaper-node-modules-regenerable.md
 * §3-§5, Testing: comparison, pinned sources, classification order, bin exception,
 * hashing bracket, final re-check). A real fixture install is built offline from a
 * tiny lockfile and a LOCAL npm cache (install scripts run, as in a session), and
 * the reference is built by the real reference builder (scripts never run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  analyzeLockfile,
  classifyResolved,
  compareWithManifest,
  hashNodeModulesTree,
  owningPackage,
  readManifest,
  readNpmMajor,
  readReferenceInputs,
  referenceKey,
  restatNodeModules,
  TreeChangedError,
  type ReferenceManifest,
  type LockPackageInfo,
  type HashedTree,
} from '../../src/monitoring/agentWorktreeNodeModules.js';
import { runReferenceBuild } from '../../src/monitoring/agentWorktreeReferenceBuildMain.js';
import { makeNpmFixture, type NpmFixture } from '../helpers/npmNodeModulesFixture.js';

const OP = 'tests/unit/agent-worktree-node-modules-compare.test.ts';

describe('root node_modules proof: the comparison', () => {
  let root: string;
  let fx: NpmFixture;
  let checkout: string;
  let refsDir: string;
  let manifest: ReferenceManifest;
  let lock: Map<string, LockPackageInfo>;
  let n = 0;

  const copyCheckout = (): string => {
    const dest = path.join(root, `copy-${++n}`);
    fs.cpSync(checkout, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    return dest;
  };
  const verdict = (dir: string) => compareWithManifest(hashNodeModulesTree(dir), manifest, lock);

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-compare-')));
    fx = makeNpmFixture(root);
    checkout = path.join(root, 'checkout');
    fx.writeProject(checkout, { rootPostinstallMarker: 'ROOT_MARKER' });
    fx.install(checkout);
    refsDir = path.join(root, 'refs');
    const major = readNpmMajor('npm', root)!;
    const key = referenceKey(readReferenceInputs(checkout)!, major);
    const r = await runReferenceBuild({
      buildId: crypto.randomBytes(16).toString('hex'), key, sourceCheckout: checkout, refsDir, npmMajor: major,
      npmCacheDir: fx.cacheDir, scratchCeilingBytes: 512 * 1024 * 1024, timeoutMs: 120_000, resultPath: path.join(refsDir, 'r.json'),
    });
    expect(r.ok, r.error).toBe(true);
    manifest = readManifest(refsDir, key)!;
    const a = analyzeLockfile(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'), checkout);
    if (!a.ok) throw new Error(a.reason);
    lock = a.packages;
  }, 120_000);
  afterAll(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP }); });

  it('the session install ran its scripts; the reference did not (no markers in the manifest)', () => {
    expect(fs.existsSync(path.join(checkout, 'ROOT_MARKER'))).toBe(true);
    expect(fs.existsSync(path.join(checkout, 'node_modules/fixscript/build/native.o'))).toBe(true);
    expect(Object.keys(manifest.files).some((f) => f.includes('build/native.o'))).toBe(false);
    expect(manifest.files['node_modules/.package-lock.json']).toBeUndefined();
  });

  it('an exact match is node-modules-residue; the residue is the script output, the bin/ rewrite and .package-lock.json', () => {
    const r = verdict(checkout);
    expect(r.verdict).toBe('node-modules-residue');
    const paths = r.residue.map((e) => e.path);
    expect(paths).toContain('node_modules/.package-lock.json');
    expect(paths).toContain('node_modules/fixscript/build/native.o');
    expect(paths).toContain('node_modules/fixscript/build');
    expect(paths).toContain('node_modules/fixscript/bin/tool'); // the bin/ exception
    expect(paths.some((p) => p.startsWith('node_modules/fixplain'))).toBe(false);
    expect(r.residueBytes).toBeGreaterThan(0);
  });

  it('one changed byte in a package without install scripts is work', () => {
    const c = copyCheckout();
    const f = path.join(c, 'node_modules/fixplain/lib/util.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('42', '43'));
    expect(verdict(c)).toMatchObject({ verdict: 'work' });
  });

  it('a missing file is work (it could be a deliberate deletion)', () => {
    const c = copyCheckout();
    SafeFsExecutor.safeUnlinkSync(path.join(c, 'node_modules/fixplain/index.js'), { operation: OP });
    expect(verdict(c).reason).toMatch(/^missing /);
  });

  it('an extra file inside the scripted package, a changed executable under its bin/, and a file under .vite/ are residue', () => {
    const c = copyCheckout();
    fs.writeFileSync(path.join(c, 'node_modules/fixscript/extra.bin'), 'x');
    fs.writeFileSync(path.join(c, 'node_modules/fixscript/bin/tool'), '#!/bin/sh\necho other\n');
    fs.mkdirSync(path.join(c, 'node_modules/.vite/vitest'), { recursive: true });
    fs.writeFileSync(path.join(c, 'node_modules/.vite/vitest/results.json'), '{}');
    const r = verdict(c);
    expect(r.verdict).toBe('node-modules-residue');
    expect(r.residue.map((e) => e.path)).toEqual(expect.arrayContaining([
      'node_modules/fixscript/extra.bin', 'node_modules/fixscript/bin/tool', 'node_modules/.vite/vitest/results.json',
    ]));
  });

  it('bin exception: a changed shipped .js file in the same scripted package is work', () => {
    const c = copyCheckout();
    fs.appendFileSync(path.join(c, 'node_modules/fixscript/index.js'), '// debug\n');
    expect(verdict(c)).toMatchObject({ verdict: 'work', reason: 'changed node_modules/fixscript/index.js' });
  });

  it('an extra file in a package without install scripts is work', () => {
    const c = copyCheckout();
    fs.writeFileSync(path.join(c, 'node_modules/fixplain/notes.txt'), 'mine');
    expect(verdict(c)).toMatchObject({ verdict: 'work', reason: 'extra node_modules/fixplain/notes.txt' });
  });

  it('a symlink out of node_modules is work; npm\'s own .bin link passes', () => {
    expect(fs.lstatSync(path.join(checkout, 'node_modules/.bin/fixbin')).isSymbolicLink()).toBe(true);
    const c = copyCheckout();
    fs.symlinkSync(os.tmpdir(), path.join(c, 'node_modules/fixscript/out-link'));
    expect(verdict(c).reason).toMatch(/link out of node_modules/);
  });

  it('no .package-lock.json is work, and so is a pnpm layout', () => {
    const c = copyCheckout();
    SafeFsExecutor.safeUnlinkSync(path.join(c, 'node_modules/.package-lock.json'), { operation: OP });
    expect(verdict(c)).toMatchObject({ verdict: 'work', reason: 'not-npm' });
    const p = path.join(root, 'pnpm');
    fs.mkdirSync(path.join(p, 'node_modules/.pnpm/fixplain@1.0.0/node_modules/fixplain'), { recursive: true });
    fs.writeFileSync(path.join(p, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n');
    fs.symlinkSync('.pnpm/fixplain@1.0.0/node_modules/fixplain', path.join(p, 'node_modules/fixplain'));
    expect(verdict(p)).toMatchObject({ verdict: 'work', reason: 'not-npm' });
  });

  it('classification order: every file of a git dependency pinned to a commit is residue, even when it matches', () => {
    const tree: HashedTree = {
      entries: new Map([
        ['node_modules/.package-lock.json', { t: 'f', mode: 0o644, size: 2, sha256: 'a'.repeat(64) }],
        ['node_modules/libsig', { t: 'd', mode: 0o755, size: 0 }],
        ['node_modules/libsig/index.js', { t: 'f', mode: 0o644, size: 3, sha256: 'b'.repeat(64) }],
        ['node_modules/libsig/built.o', { t: 'f', mode: 0o644, size: 4, sha256: 'c'.repeat(64) }],
      ]),
      signature: {}, allocatedBytes: 0,
    };
    const m: ReferenceManifest = { version: 1, key: 'k', npmMajor: '11', createdAt: 0, files: { 'node_modules/libsig': { t: 'd' }, 'node_modules/libsig/index.js': { t: 'f', h: 'b'.repeat(64), x: 0 } } };
    const r = compareWithManifest(tree, m, new Map([['node_modules/libsig', { git: true, scripted: false, bundled: false }]]));
    expect(r.verdict).toBe('node-modules-residue');
    expect(r.residue.map((e) => e.path)).toEqual(['node_modules/.package-lock.json', 'node_modules/libsig', 'node_modules/libsig/built.o', 'node_modules/libsig/index.js']);
  });

  it('owningPackage picks the deepest package, scoped names included', () => {
    expect(owningPackage('node_modules/a/lib/x.js')).toBe('node_modules/a');
    expect(owningPackage('node_modules/a/node_modules/@s/b/x.js')).toBe('node_modules/a/node_modules/@s/b');
    expect(owningPackage('node_modules/.bin/x')).toBeNull();
    expect(owningPackage('node_modules/@s')).toBeNull();
    expect(owningPackage('node_modules/a')).toBe('node_modules/a');
  });

  describe('pinned sources', () => {
    const lockWith = (entry: Record<string, unknown>, name = 'dep') => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [`node_modules/${name}`]: entry } });
    const installed = (name: string): string => { const d = path.join(root, `inst-${++n}`); fs.mkdirSync(path.join(d, 'node_modules', name), { recursive: true }); return d; };

    it('a file: dependency, a remote tarball, a git branch and an unknown git host each give unsupported-source', () => {
      for (const resolved of ['file:../local-dep', 'https://example.com/dep-1.0.0.tgz', 'git+ssh://git@github.com/o/dep.git#main', 'git+ssh://git@gitlab.com/o/dep.git#' + 'a'.repeat(40)]) {
        const a = analyzeLockfile(lockWith({ version: '1.0.0', resolved, integrity: 'sha512-x' }), installed('dep'));
        expect(a.ok, resolved).toBe(false);
        if (!a.ok) expect(a.reason).toBe('unsupported-source');
      }
      expect(analyzeLockfile(lockWith({ version: '1.0.0', link: true, resolved: '../x' }), installed('dep')).ok).toBe(false);
    });

    it('registry with integrity and a GitHub commit pin are supported; an uninstalled optional entry is ignored', () => {
      expect(classifyResolved('https://registry.npmjs.org/a/-/a-1.0.0.tgz', 'sha512-x')).toBe('registry');
      expect(classifyResolved('https://registry.npmjs.org/a/-/a-1.0.0.tgz', undefined)).toBe('unsupported');
      expect(classifyResolved('git+ssh://git@github.com/whiskeysockets/libsignal-node.git#' + 'e'.repeat(40), undefined)).toBe('git');
      expect(classifyResolved('git+https://github.com/o/r.git#' + 'f'.repeat(40), undefined)).toBe('git');
      const notInstalled = path.join(root, `empty-${++n}`);
      fs.mkdirSync(path.join(notInstalled, 'node_modules'), { recursive: true });
      const a = analyzeLockfile(lockWith({ version: '1.0.0', resolved: 'file:../nope', optional: true }, 'sqlite-vec-linux-arm64'), notInstalled);
      expect(a.ok).toBe(true);
      // The reference build refuses an UNINSTALLED entry that npm would fetch from outside
      // the registry or GitHub (second-pass finding): it would clone even offline.
      const gitlab = analyzeLockfile(lockWith({ version: '1.0.0', resolved: 'git+ssh://git@gitlab.com/o/dep.git#' + 'b'.repeat(40), optional: true }), notInstalled, { rejectUninstalledFetchable: true });
      expect(gitlab.ok).toBe(false);
      if (!gitlab.ok) expect(gitlab.reason).toBe('unsupported-source');
      // ...but an uninstalled entry with no resolved URL (another OS's optional build) still passes.
      expect(analyzeLockfile(lockWith({ version: '1.0.0', optional: true }, 'sqlite-vec-linux-arm64'), notInstalled, { rejectUninstalledFetchable: true }).ok).toBe(true);
      // and an uninstalled registry entry with integrity passes too.
      expect(analyzeLockfile(lockWith({ version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-y', optional: true }, 'x'), notInstalled, { rejectUninstalledFetchable: true }).ok).toBe(true);
      const g = analyzeLockfile(lockWith({ version: '1.0.0', resolved: 'git+ssh://git@github.com/o/dep.git#' + 'a'.repeat(40) }), installed('dep'));
      expect(g.ok && g.packages.get('node_modules/dep')?.git).toBe(true);
    });
  });

  describe('hashing bracket', () => {
    it('a file modified between the first fstat and the read makes the checkout work', () => {
      const c = copyCheckout();
      expect(() => hashNodeModulesTree(c, {
        afterFirstFstat: (rel, abs) => { if (rel === 'node_modules/fixplain/lib/util.js') fs.appendFileSync(abs, '// late\n'); },
      })).toThrow(TreeChangedError);
    });

    it('a path swapped to another inode after the read makes the checkout work', () => {
      const c = copyCheckout();
      expect(() => hashNodeModulesTree(c, {
        afterRead: (rel, abs) => {
          if (rel !== 'node_modules/fixplain/index.js') return;
          const other = `${abs}.swap`;
          fs.writeFileSync(other, fs.readFileSync(abs));
          fs.renameSync(other, abs);
        },
      })).toThrow(TreeChangedError);
    });
  });

  describe('the final re-check against the hash-time signature', () => {
    it('an edit to a previously matching file, an added file and a removed file are each caught; an unchanged tree passes', () => {
      const c = copyCheckout();
      const sig = hashNodeModulesTree(c).signature;
      expect(restatNodeModules(c, sig)).toBeNull();
      const f = path.join(c, 'node_modules/fixplain/lib/util.js');
      fs.appendFileSync(f, '\n');
      expect(restatNodeModules(c, sig)).toMatch(/^changed node_modules\/fixplain\/lib\/util\.js/);

      const c2 = copyCheckout();
      const sig2 = hashNodeModulesTree(c2).signature;
      fs.writeFileSync(path.join(c2, 'node_modules/fixplain/new.js'), 'x');
      expect(restatNodeModules(c2, sig2)).toMatch(/node_modules\/fixplain/);

      const c3 = copyCheckout();
      const sig3 = hashNodeModulesTree(c3).signature;
      SafeFsExecutor.safeUnlinkSync(path.join(c3, 'node_modules/fixbin/cli.js'), { operation: OP });
      expect(restatNodeModules(c3, sig3)).not.toBeNull();
    });

    it('an unchanged tree of 16,000 entries passes in under 1 s', () => {
      const big = path.join(root, 'big');
      for (let d = 0; d < 160; d++) {
        const dir = path.join(big, 'node_modules', `p${d}`);
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 99; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), `${d}-${f}`);
      }
      const sig = hashNodeModulesTree(big).signature;
      expect(Object.keys(sig).length).toBeGreaterThanOrEqual(16_000);
      const t0 = performance.now();
      expect(restatNodeModules(big, sig)).toBeNull();
      expect(performance.now() - t0).toBeLessThan(1_000);
    }, 60_000);
  });
});
