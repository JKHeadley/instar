/**
 * The content-addressed residue store (spec docs/specs/reaper-node-modules-regenerable.md §4,
 * Testing: residue store, `.package-lock.json`, verdict mapping's restore).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  archiveNodeModulesResidue,
  casDir,
  compareWithManifest,
  hashNodeModulesTree,
  manifestFromTree,
  residueFits,
  restoreNodeModulesResidue,
  verifyResidueArchive,
  ResidueOverFloorError,
  type LockPackageInfo,
} from '../../src/monitoring/agentWorktreeNodeModules.js';

const OP = 'tests/unit/agent-worktree-node-modules-store.test.ts';
const PLENTY = () => ({ free: 10 * 1024 ** 4, total: 20 * 1024 ** 4 });

describe('root node_modules proof: the residue store', () => {
  let root: string;
  let archive: string;
  const lock = new Map<string, LockPackageInfo>([
    ['node_modules/scripted', { git: false, scripted: true, bundled: false }],
    ['node_modules/plain', { git: false, scripted: false, bundled: false }],
  ]);

  /** A tiny npm-shaped install: a scripted package with a bin/, a plain one, a .bin link, npm's hidden lockfile. */
  const install = (dir: string): void => {
    fs.mkdirSync(path.join(dir, 'node_modules/scripted/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/plain'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(dir, 'node_modules/scripted/index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'node_modules/scripted/bin/tool'), '#!/bin/sh\necho ref\n');
    fs.chmodSync(path.join(dir, 'node_modules/scripted/bin/tool'), 0o755);
    fs.writeFileSync(path.join(dir, 'node_modules/plain/index.js'), 'module.exports = 2;\n');
    fs.symlinkSync('../scripted/bin/tool', path.join(dir, 'node_modules/.bin/tool'));
  };
  /** What install scripts add in a session's install. */
  const scriptOutput = (dir: string, native = 'native-object-bytes'): void => {
    fs.mkdirSync(path.join(dir, 'node_modules/scripted/build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/scripted/build/native.o'), native);
    fs.chmodSync(path.join(dir, 'node_modules/scripted/build/native.o'), 0o755);
    fs.writeFileSync(path.join(dir, 'node_modules/scripted/bin/tool'), '#!/bin/sh\necho platform\n');
    fs.symlinkSync('native.o', path.join(dir, 'node_modules/scripted/build/current'));
  };
  const reference = () => {
    const ref = path.join(root, 'ref');
    if (!fs.existsSync(ref)) install(ref);
    return manifestFromTree(hashNodeModulesTree(ref), 'a'.repeat(64) + '-npm11', '11', 0);
  };
  const proven = (dir: string) => {
    const r = compareWithManifest(hashNodeModulesTree(dir), reference(), lock);
    expect(r.verdict).toBe('node-modules-residue');
    return r;
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-store-')));
    archive = path.join(root, 'archive');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP }); });

  it('the residue manifest records type, mode and link target, and a restore reproduces an executable and a link exactly', () => {
    const wt = path.join(root, 'wt');
    install(wt); scriptOutput(wt);
    const r = proven(wt);
    const a = archiveNodeModulesResidue(wt, { residue: r.residue, residueBytes: r.residueBytes }, archive, { volume: PLENTY });
    const body = JSON.parse(fs.readFileSync(a.manifestPath, 'utf8')) as { entries: Array<{ path: string; type: string; mode: number; target?: string }> };
    const byPath = Object.fromEntries(body.entries.map((e) => [e.path, e]));
    expect(byPath['node_modules/scripted/build/native.o']).toMatchObject({ type: 'file', mode: 0o755 });
    expect(byPath['node_modules/scripted/build/current']).toMatchObject({ type: 'symlink', target: 'native.o' });
    expect(byPath['node_modules/scripted/build']).toMatchObject({ type: 'dir' });
    // Restore onto a fresh install from the lockfile.
    const fresh = path.join(root, 'fresh');
    install(fresh);
    restoreNodeModulesResidue(a.manifestPath, archive, fresh);
    const st = fs.statSync(path.join(fresh, 'node_modules/scripted/build/native.o'));
    expect(st.mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(fresh, 'node_modules/scripted/build/native.o'), 'utf8')).toBe('native-object-bytes');
    expect(fs.readlinkSync(path.join(fresh, 'node_modules/scripted/build/current'))).toBe('native.o');
    expect(fs.readFileSync(path.join(fresh, 'node_modules/scripted/bin/tool'), 'utf8')).toBe('#!/bin/sh\necho platform\n');
    // The restored tree is the original, content for content.
    const before = compareWithManifest(hashNodeModulesTree(wt), reference(), lock).residue;
    const after = compareWithManifest(hashNodeModulesTree(fresh), reference(), lock).residue;
    expect(after).toEqual(before);
  });

  it('two checkouts with the same residue bytes store them once; unique bytes are stored per checkout', () => {
    const a = path.join(root, 'a'); install(a); scriptOutput(a, 'same');
    const b = path.join(root, 'b'); install(b); scriptOutput(b, 'same');
    const ra = proven(a); const rb = proven(b);
    const x = archiveNodeModulesResidue(a, { residue: ra.residue, residueBytes: ra.residueBytes }, archive, { volume: PLENTY });
    const y = archiveNodeModulesResidue(b, { residue: rb.residue, residueBytes: rb.residueBytes }, archive, { volume: PLENTY });
    expect(x.storedBytes).toBeGreaterThan(0);
    expect(y.storedBytes).toBe(0);
    const blobs = fs.readdirSync(casDir(archive)).filter((n) => !n.startsWith('.'));
    const c = path.join(root, 'c'); install(c); scriptOutput(c, 'different');
    const rc = proven(c);
    const z = archiveNodeModulesResidue(c, { residue: rc.residue, residueBytes: rc.residueBytes }, archive, { volume: PLENTY });
    expect(z.storedBytes).toBe('different'.length);
    expect(fs.readdirSync(casDir(archive)).filter((n) => !n.startsWith('.')).length).toBe(blobs.length + 1);
  });

  it('a copy is verified by hash before it counts: bytes changed after hashing are refused and leave no blob', () => {
    const wt = path.join(root, 'wt'); install(wt); scriptOutput(wt);
    const r = proven(wt);
    fs.writeFileSync(path.join(wt, 'node_modules/scripted/build/native.o'), 'tampered!!!!!!!!!!!');
    expect(() => archiveNodeModulesResidue(wt, { residue: r.residue, residueBytes: r.residueBytes }, archive, { volume: PLENTY })).toThrow(/changed since hashing/);
    const names = fs.existsSync(casDir(archive)) ? fs.readdirSync(casDir(archive)) : [];
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a re-verify after archive catches a later edit in the checkout', () => {
    const wt = path.join(root, 'wt'); install(wt); scriptOutput(wt);
    const r = proven(wt);
    const a = archiveNodeModulesResidue(wt, { residue: r.residue, residueBytes: r.residueBytes }, archive, { volume: PLENTY });
    expect(() => verifyResidueArchive(wt, a, archive)).not.toThrow();
    fs.appendFileSync(path.join(wt, 'node_modules/.package-lock.json'), ' ');
    expect(() => verifyResidueArchive(wt, a, archive)).toThrow(/changed since archive/);
  });

  it('too little free space gives residue-over-floor and copies nothing', () => {
    const wt = path.join(root, 'wt'); install(wt); scriptOutput(wt);
    const r = proven(wt);
    const tight = () => ({ free: 52 * 1024 ** 3, total: 1024 ** 4 }); // the disk steward's floor is 5% of 1 TiB = 51.2 GiB
    expect(residueFits(archive, r.residueBytes, tight)).toBe(true);
    const tighter = () => ({ free: 51 * 1024 ** 3, total: 1024 ** 4 });
    expect(residueFits(archive, r.residueBytes, tighter)).toBe(false);
    expect(() => archiveNodeModulesResidue(wt, { residue: r.residue, residueBytes: r.residueBytes }, archive, { volume: tighter })).toThrow(ResidueOverFloorError);
    expect(fs.existsSync(casDir(archive))).toBe(false);
  });

  it('nothing is ever deleted from the store: re-archiving and later archives keep every blob', () => {
    const wt = path.join(root, 'wt'); install(wt); scriptOutput(wt, 'v1');
    const r1 = proven(wt);
    archiveNodeModulesResidue(wt, { residue: r1.residue, residueBytes: r1.residueBytes }, archive, { volume: PLENTY });
    const first = new Set(fs.readdirSync(casDir(archive)));
    fs.writeFileSync(path.join(wt, 'node_modules/scripted/build/native.o'), 'v2');
    const r2 = proven(wt);
    archiveNodeModulesResidue(wt, { residue: r2.residue, residueBytes: r2.residueBytes }, archive, { volume: PLENTY });
    const second = new Set(fs.readdirSync(casDir(archive)));
    for (const b of first) expect(second.has(b)).toBe(true);
    expect(second.size).toBe(first.size + 1);
  });

  it('.package-lock.json is excluded from the comparison but archived: a one-byte edit restores byte for byte', () => {
    const wt = path.join(root, 'wt'); install(wt);
    const lockFile = path.join(wt, 'node_modules/.package-lock.json');
    fs.writeFileSync(lockFile, fs.readFileSync(lockFile, 'utf8').replace('3', '4'));
    const r = proven(wt);
    expect(r.residue.map((e) => e.path)).toEqual(['node_modules/.package-lock.json']);
    const a = archiveNodeModulesResidue(wt, { residue: r.residue, residueBytes: r.residueBytes }, archive, { volume: PLENTY });
    const fresh = path.join(root, 'fresh'); install(fresh);
    restoreNodeModulesResidue(a.manifestPath, archive, fresh);
    expect(fs.readFileSync(path.join(fresh, 'node_modules/.package-lock.json'))).toEqual(fs.readFileSync(lockFile));
  });
});
