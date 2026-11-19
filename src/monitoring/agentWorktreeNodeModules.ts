/**
 * The worktree reaper's proof that a real root `node_modules` holds nothing a
 * lockfile cannot rebuild (spec docs/specs/reaper-node-modules-regenerable.md).
 *
 * Pieces, all synchronous file work that runs OFF the server's main thread (the
 * dry-run evaluation worker, the live reclaim child, or the reference builder child):
 *   - lockfile analysis: every installed entry must be pinned (registry +
 *     integrity, or a GitHub git source at a full commit); anything else makes the
 *     checkout `work` (`unsupported-source`), so no proof is attempted (§3);
 *   - the reference key: sha256(package.json + package-lock.json) + npm's major (§3);
 *   - the bracketed hash walk: each file is opened once, fstat'ed, read, fstat'ed
 *     again through the same descriptor, and its path lstat'ed again; any change in
 *     size, mtime_ns, ctime_ns or inode means the checkout is `work` (§4);
 *   - the comparison against a reference manifest, in the spec's classification
 *     order, with the `bin/` exception (§4);
 *   - the content-addressed residue store and the per-checkout residue manifest,
 *     with every blob, the manifest and their folders fsynced (§4);
 *   - the stat-signature re-check used before and after the rename to trash (§5);
 *   - the per-pass verdict memo `classifyIgnoredEntry` reads (§4);
 *   - the per-pass orchestration: eligibility, rotation, `unchecked`,
 *     `reference-unavailable`, `residue-over-floor` (§1, §3, §6).
 *
 * Every failure keeps the checkout: an error never yields `node-modules-residue`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { mediaDiskFloorBytes } from '../core/AppMediaStore.js';
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';

const OP = 'src/monitoring/agentWorktreeNodeModules.ts';

// ── Verdicts ────────────────────────────────────────────────────────

/** Spec §6: the per-checkout verdict for a real root `node_modules`. Only `node-modules-residue` passes. */
export type NodeModulesVerdict = 'node-modules-residue' | 'work' | 'unchecked' | 'reference-unavailable' | 'residue-over-floor';

/** One residue entry: archived to the store (files) or recorded (folders, links). */
export interface NodeModulesResidueEntry {
  /** Checkout-relative path, always under `node_modules/`. */
  path: string;
  type: 'file' | 'dir' | 'symlink';
  /** Files only. */
  sha256?: string;
  size?: number;
  /** Permission bits (`mode & 0o7777`). */
  mode: number;
  /** Symlinks only: the literal link target. */
  target?: string;
}

/** A stat signature: checkout-relative path → `kind:ino:size:mtimeNs:ctimeNs`. */
export type StatSignature = Record<string, string>;

export interface NodeModulesVerdictRecord {
  passId: string;
  checkout: string;
  verdict: NodeModulesVerdict;
  reason: string;
  key?: string;
  checkedAt: number;
  residue: NodeModulesResidueEntry[];
  residueBytes: number;
  /** st_blocks × 512 summed over the root `node_modules` (an upper bound on what removal frees). */
  allocatedBytes: number | null;
  /** Stat of the `node_modules` folder and its `.package-lock.json` (memo freshness, cheap). */
  rootSig: string;
}

// ── Lockfile analysis (§3 "Pinned sources, checked") ────────────────

export interface LockPackageInfo {
  git: boolean;
  scripted: boolean;
  /** inBundle: comes from the parent's integrity-pinned tarball. */
  bundled: boolean;
}

export type LockAnalysis =
  | { ok: true; packages: Map<string, LockPackageInfo> }
  | { ok: false; reason: string; detail?: string };

const REGISTRY_PREFIX = 'https://registry.npmjs.org/';
/** A GitHub git source pinned to a full commit (ssh or https form). */
const GITHUB_PINNED = /^git\+(?:ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?#[0-9a-f]{40}$/;

/** Classify one lockfile `resolved`. Exported for tests. */
export function classifyResolved(resolved: unknown, integrity: unknown): 'registry' | 'git' | 'unsupported' {
  if (typeof resolved !== 'string' || !resolved) return 'unsupported';
  if (resolved.startsWith(REGISTRY_PREFIX) && typeof integrity === 'string' && integrity.length > 0) return 'registry';
  if (GITHUB_PINNED.test(resolved)) return 'git';
  return 'unsupported';
}

/**
 * Read the checkout's `package-lock.json` and check every entry installed on
 * disk is pinned. An entry not installed (an optional package for another OS) is
 * ignored. `installedRoot` is where installation is checked (the checkout; the
 * builder checks its source checkout).
 */
export function analyzeLockfile(lockText: string, installedRoot: string | null, opts: { rejectUninstalledFetchable?: boolean } = {}): LockAnalysis {
  let lock: { lockfileVersion?: unknown; packages?: unknown };
  try { lock = JSON.parse(lockText) as typeof lock; }
  catch { return { ok: false, reason: 'unsupported-source', detail: 'package-lock.json is not valid JSON' }; } // @silent-fallback-ok — unreadable lockfile ⇒ no proof ⇒ work
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== 'object') {
    return { ok: false, reason: 'unsupported-source', detail: 'lockfile has no packages map (lockfileVersion < 2)' };
  }
  const packages = new Map<string, LockPackageInfo>();
  for (const [key, raw] of Object.entries(lock.packages as Record<string, unknown>)) {
    if (key === '') continue; // the root project
    const e = (raw ?? {}) as { resolved?: unknown; integrity?: unknown; link?: unknown; inBundle?: unknown; hasInstallScript?: unknown };
    if (!key.startsWith('node_modules/') || key.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      // A workspace or a path outside node_modules: never reproduced by the scratch build.
      if (installedRoot === null || isInstalled(installedRoot, key)) return { ok: false, reason: 'unsupported-source', detail: `entry ${key} is outside node_modules` };
      continue;
    }
    if (installedRoot !== null && !isInstalled(installedRoot, key)) {
      // e.g. an optional package for another OS. For the reference BUILD (which runs a
      // real `npm ci`), an uninstalled entry that names a fetchable non-registry,
      // non-GitHub source is still refused: npm would clone or download it, even
      // offline (pacote git.js:267-268). An entry with no `resolved` is never fetched.
      if (opts.rejectUninstalledFetchable && typeof e.resolved === 'string' && e.resolved && classifyResolved(e.resolved, e.integrity) === 'unsupported') {
        return { ok: false, reason: 'unsupported-source', detail: `${key} (not installed) resolved ${e.resolved.slice(0, 120)}` };
      }
      continue;
    }
    const bundled = e.inBundle === true;
    if (e.link === true) return { ok: false, reason: 'unsupported-source', detail: `${key} is a link` };
    const kind = bundled && e.resolved === undefined ? 'registry' : classifyResolved(e.resolved, e.integrity);
    if (kind === 'unsupported') return { ok: false, reason: 'unsupported-source', detail: `${key} resolved ${String(e.resolved ?? '(none)').slice(0, 120)}` };
    packages.set(key, { git: kind === 'git', scripted: e.hasInstallScript === true, bundled });
  }
  return { ok: true, packages };
}

function isInstalled(root: string, key: string): boolean {
  try { fs.lstatSync(path.join(root, ...key.split('/'))); return true; }
  catch { return false; } // @silent-fallback-ok — absent ⇒ not installed
}

/** The deepest `node_modules/<name>` or `node_modules/@scope/<name>` prefix of `rel` (or rel itself), or null. */
export function owningPackage(rel: string): string | null {
  const segs = rel.split('/');
  let owner: string | null = null;
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] !== 'node_modules') continue;
    const name = segs[i + 1];
    if (!name || name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      if (i + 2 < segs.length) owner = segs.slice(0, i + 3).join('/');
      continue;
    }
    owner = segs.slice(0, i + 2).join('/');
  }
  return owner;
}

// ── Reference key (§3) ──────────────────────────────────────────────

export interface ReferenceInputs { packageJson: Buffer; packageLock: Buffer }

export function readReferenceInputs(checkout: string): ReferenceInputs | null {
  try {
    return {
      packageJson: fs.readFileSync(path.join(checkout, 'package.json')),
      packageLock: fs.readFileSync(path.join(checkout, 'package-lock.json')),
    };
  } catch {
    return null; // @silent-fallback-ok — no lockfile ⇒ no key ⇒ work
  }
}

/** sha256 of package.json and package-lock.json (length-prefixed), plus npm's major version. */
export function referenceKey(inputs: ReferenceInputs, npmMajor: string): string {
  const h = crypto.createHash('sha256');
  h.update(`${inputs.packageJson.length}\n`); h.update(inputs.packageJson);
  h.update(`\n${inputs.packageLock.length}\n`); h.update(inputs.packageLock);
  if (!/^\d+$/.test(npmMajor)) throw new Error(`bad npm major ${npmMajor}`);
  return `${h.digest('hex')}-npm${npmMajor}`;
}

export const REFERENCE_KEY = /^[0-9a-f]{64}-npm\d+$/;

/** npm's major version, from `npm --version` run outside any checkout. null when unreadable. */
export function readNpmMajor(npmPath = 'npm', cwd = '/'): string | null {
  try {
    // Runs only in the evaluation worker or the reclaim child, never on the server's main thread.
    const out = withSyncOp(() => execFileSync(npmPath, ['--version'], { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, npm_config_update_notifier: 'false' } })).trim();
    const m = /^(\d+)\./.exec(out);
    return m ? m[1] : null;
  } catch {
    return null; // @silent-fallback-ok — unknown npm ⇒ no key ⇒ every checkout `reference-unavailable`
  }
}

// ── Bracketed hash walk (§4 "Hashing is bracketed by stats") ────────

export interface TreeEntry {
  t: 'f' | 'd' | 'l';
  mode: number;
  size: number;
  sha256?: string;
  target?: string;
}

export interface HashedTree {
  entries: Map<string, TreeEntry>;
  signature: StatSignature;
  allocatedBytes: number;
}

export class TreeChangedError extends Error {
  constructor(readonly rel: string, why: string) { super(`changed during hashing: ${rel} (${why})`); this.name = 'TreeChangedError'; }
}

export interface HashSeams {
  /** Test seam: runs after the first fstat of a file, before its bytes are read. */
  afterFirstFstat?: (rel: string, abs: string) => void;
  /** Test seam: runs after a file is read, before the final fstat and path lstat. */
  afterRead?: (rel: string, abs: string) => void;
}

function sigOf(kind: 'f' | 'd' | 'l', st: fs.BigIntStats): string {
  return `${kind}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

const HASH_CHUNK = 1024 * 1024;

/**
 * Walk `<base>/node_modules` without following links, hash every file once with
 * the fstat bracket, and return the entries (paths relative to `base`, so every
 * path starts `node_modules`) and the verified stat signature. Throws
 * TreeChangedError when anything moves under it, or the fs error.
 */
export function hashNodeModulesTree(base: string, seams: HashSeams = {}): HashedTree {
  const entries = new Map<string, TreeEntry>();
  const signature: StatSignature = {};
  let allocated = 0;
  const rootAbs = path.join(base, 'node_modules');
  const rootSt = fs.lstatSync(rootAbs, { bigint: true });
  if (!rootSt.isDirectory()) throw new Error('node_modules is not a real folder');
  signature['node_modules'] = sigOf('d', rootSt);
  allocated += Number(rootSt.blocks) * 512;
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  const stack = ['node_modules'];
  while (stack.length) {
    const relDir = stack.pop()!;
    const names = fs.readdirSync(path.join(base, relDir)).sort();
    for (const name of names) {
      const rel = `${relDir}/${name}`;
      const abs = path.join(base, rel);
      const st = fs.lstatSync(abs, { bigint: true });
      allocated += Number(st.blocks) * 512;
      const mode = Number(st.mode & 0o7777n);
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(abs);
        const again = fs.lstatSync(abs, { bigint: true });
        if (again.ino !== st.ino || again.ctimeNs !== st.ctimeNs) throw new TreeChangedError(rel, 'link replaced');
        entries.set(rel, { t: 'l', mode, size: Number(st.size), target });
        signature[rel] = sigOf('l', st);
        continue;
      }
      if (st.isDirectory()) {
        entries.set(rel, { t: 'd', mode, size: 0 });
        signature[rel] = sigOf('d', st);
        stack.push(rel);
        continue;
      }
      if (!st.isFile()) throw new TreeChangedError(rel, 'not a regular file, folder or link');
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let sha256: string;
      let size = 0;
      let first: fs.BigIntStats;
      let last: fs.BigIntStats;
      try {
        first = fs.fstatSync(fd, { bigint: true });
        seams.afterFirstFstat?.(rel, abs);
        const h = crypto.createHash('sha256');
        for (;;) {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          h.update(buf.subarray(0, n));
          size += n;
        }
        sha256 = h.digest('hex');
        seams.afterRead?.(rel, abs);
        last = fs.fstatSync(fd, { bigint: true });
      } finally { fs.closeSync(fd); }
      const pathNow = fs.lstatSync(abs, { bigint: true });
      for (const [a, b, why] of [[st, first, 'open'], [first, last, 'read'], [last, pathNow, 'path']] as const) {
        if (a.ino !== b.ino || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs) throw new TreeChangedError(rel, `stat moved across ${why}`);
      }
      if (BigInt(size) !== last.size) throw new TreeChangedError(rel, 'read size differs from stat');
      entries.set(rel, { t: 'f', mode, size, sha256 });
      signature[rel] = sigOf('f', last);
    }
  }
  return { entries, signature, allocatedBytes: allocated };
}

/**
 * Re-list `<base>/node_modules` and re-lstat every entry against `signature`
 * (§5). Returns null when identical, else what differs (a changed, added or
 * removed entry). Never throws: an unreadable tree is a difference.
 */
export function restatNodeModules(base: string, signature: StatSignature): string | null {
  try {
    const seen = new Set<string>();
    const rootSt = fs.lstatSync(path.join(base, 'node_modules'), { bigint: true });
    if (!rootSt.isDirectory()) return 'node_modules is no longer a folder';
    const check = (rel: string, st: fs.BigIntStats): string | null => {
      const kind = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : '?';
      seen.add(rel);
      const want = signature[rel];
      if (want === undefined) return `added ${rel}`;
      if (kind === '?' || sigOf(kind as 'f' | 'd' | 'l', st) !== want) return `changed ${rel}`;
      return null;
    };
    const r = check('node_modules', rootSt);
    if (r) return r;
    const stack = ['node_modules'];
    while (stack.length) {
      const relDir = stack.pop()!;
      for (const name of fs.readdirSync(path.join(base, relDir))) {
        const rel = `${relDir}/${name}`;
        const st = fs.lstatSync(path.join(base, rel), { bigint: true });
        const d = check(rel, st);
        if (d) return d;
        if (st.isDirectory()) stack.push(rel);
      }
    }
    for (const rel of Object.keys(signature)) if (!seen.has(rel)) return `removed ${rel}`;
    return null;
  } catch (err) {
    return `unreadable: ${(err as Error).message.slice(0, 200)}`; // @silent-fallback-ok — an unreadable tree is reported as changed ⇒ KEEP
  }
}

/** Cheap freshness stamp for the memo: the folder and its `.package-lock.json`. */
export function rootSignature(checkout: string): string {
  try {
    const d = fs.lstatSync(path.join(checkout, 'node_modules'), { bigint: true });
    if (!d.isDirectory()) return 'not-a-folder';
    let lock = 'none';
    try { lock = sigOf('f', fs.lstatSync(path.join(checkout, 'node_modules', '.package-lock.json'), { bigint: true })); } catch { /* @silent-fallback-ok — absent lock is part of the stamp */ }
    return `${sigOf('d', d)}|${lock}`;
  } catch {
    return 'unreadable'; // @silent-fallback-ok — never equals a recorded stamp ⇒ memo invalid ⇒ work
  }
}

// ── Reference manifests (§3) ────────────────────────────────────────

export interface ReferenceManifestEntry { t: 'f' | 'd' | 'l'; h?: string; x?: 0 | 1; l?: string }
export interface ReferenceManifest {
  version: 1;
  key: string;
  npmMajor: string;
  createdAt: number;
  /** Paths relative to the install root (all start `node_modules/`), excluding `node_modules/.package-lock.json`. */
  files: Record<string, ReferenceManifestEntry>;
}

export const NPM_HIDDEN_LOCKFILE = 'node_modules/.package-lock.json';

export function manifestFromTree(tree: HashedTree, key: string, npmMajor: string, now: number): ReferenceManifest {
  const files: Record<string, ReferenceManifestEntry> = {};
  for (const [rel, e] of [...tree.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (rel === NPM_HIDDEN_LOCKFILE) continue;
    if (e.t === 'f') files[rel] = { t: 'f', h: e.sha256, x: (e.mode & 0o111) !== 0 ? 1 : 0 };
    else if (e.t === 'l') files[rel] = { t: 'l', l: e.target };
    else files[rel] = { t: 'd' };
  }
  return { version: 1, key, npmMajor, createdAt: now, files };
}

export function manifestPath(refsDir: string, key: string): string {
  if (!REFERENCE_KEY.test(key)) throw new Error(`bad reference key ${key}`);
  return path.join(refsDir, 'manifests', `${key}.json`);
}

export function readManifest(refsDir: string, key: string): ReferenceManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(refsDir, key), 'utf8')) as ReferenceManifest;
    return m && m.version === 1 && m.key === key && m.files && typeof m.files === 'object' ? m : null;
  } catch {
    return null; // @silent-fallback-ok — no manifest ⇒ the checkout is `unchecked` or `reference-unavailable`, never passed
  }
}

/** Write bytes to `target` atomically and durably: temp, fsync, rename, fsync the folder. */
export function writeFileDurable(target: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: `${OP}:writeFileDurable` }); } catch { /* @silent-fallback-ok — a dot-prefixed .tmp never reads as the file */ }
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, target);
  fsyncDir(dir);
}

export function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function writeManifest(refsDir: string, manifest: ReferenceManifest): string {
  const target = manifestPath(refsDir, manifest.key);
  writeFileDurable(target, JSON.stringify(manifest));
  return target;
}

/** Kept manifests, for the cap and the report. */
export function listManifests(refsDir: string): Array<{ key: string; file: string; bytes: number; lastUsedAt: number }> {
  const dir = path.join(refsDir, 'manifests');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; } // @silent-fallback-ok — none yet
  const out: Array<{ key: string; file: string; bytes: number; lastUsedAt: number }> = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const key = n.slice(0, -5);
    if (!REFERENCE_KEY.test(key)) continue;
    try { const st = fs.statSync(path.join(dir, n)); out.push({ key, file: path.join(dir, n), bytes: st.size, lastUsedAt: st.mtimeMs }); }
    catch { /* @silent-fallback-ok — vanished mid-list */ }
  }
  return out;
}

/** Mark a manifest used (its mtime is its last-used time; the 14-day retention and the cap's LRU read it). */
export function touchManifest(refsDir: string, key: string, now: number): void {
  try { const t = new Date(now); fs.utimesSync(manifestPath(refsDir, key), t, t); }
  catch { /* @silent-fallback-ok — a missed touch only makes the manifest look older; it is rebuilt on need */ }
}

// ── Build status (written by the builder's supervisor, read by the pass) ──

export type BuildFailureCause = 'npm-cache-missing' | 'timeout' | 'build-error' | 'scratch-ceiling' | 'unsupported-source' | 'killed';
export interface BuildStatusEntry { failures: number; lastAt: number; cause: BuildFailureCause; nextAt: number; error?: string }
export interface BuildStatusFile { keys: Record<string, BuildStatusEntry>; scratchHighWaterBytes: number }

export function readBuildStatus(refsDir: string): BuildStatusFile {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(refsDir, 'status.json'), 'utf8')) as Partial<BuildStatusFile>;
    return { keys: raw.keys && typeof raw.keys === 'object' ? raw.keys : {}, scratchHighWaterBytes: typeof raw.scratchHighWaterBytes === 'number' ? raw.scratchHighWaterBytes : 0 };
  } catch {
    return { keys: {}, scratchHighWaterBytes: 0 }; // @silent-fallback-ok — no builds yet
  }
}

// ── The comparison (§4) ─────────────────────────────────────────────

export interface ComparisonResult {
  verdict: 'node-modules-residue' | 'work';
  reason: string;
  residue: NodeModulesResidueEntry[];
  residueBytes: number;
}

/**
 * Compare a checkout's hashed `node_modules` with the reference manifest, in the
 * spec's classification order. Pure: no I/O.
 */
export function compareWithManifest(tree: HashedTree, manifest: ReferenceManifest, lock: Map<string, LockPackageInfo>): ComparisonResult {
  const work = (reason: string): ComparisonResult => ({ verdict: 'work', reason, residue: [], residueBytes: 0 });
  const lockEntry = tree.entries.get(NPM_HIDDEN_LOCKFILE);
  if (!lockEntry || lockEntry.t !== 'f') return work('not-npm');
  for (const rel of Object.keys(manifest.files)) {
    if (!tree.entries.has(rel)) return work(`missing ${rel}`);
  }
  const residue: NodeModulesResidueEntry[] = [];
  let residueBytes = 0;
  const addResidue = (rel: string, e: TreeEntry): void => {
    if (e.t === 'f') { residue.push({ path: rel, type: 'file', sha256: e.sha256, size: e.size, mode: e.mode }); residueBytes += e.size; }
    else if (e.t === 'l') residue.push({ path: rel, type: 'symlink', target: e.target, mode: e.mode });
    else residue.push({ path: rel, type: 'dir', mode: e.mode });
  };
  const matches = (e: TreeEntry, m: ReferenceManifestEntry): boolean => {
    if (e.t !== m.t) return false;
    if (e.t === 'f') return e.sha256 === m.h && ((e.mode & 0o111) !== 0 ? 1 : 0) === m.x;
    if (e.t === 'l') return e.target === m.l;
    return true;
  };
  for (const [rel, e] of [...tree.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (rel === NPM_HIDDEN_LOCKFILE) { addResidue(rel, e); continue; } // always archived: a hand edit is kept byte for byte
    // No links out (npm's .bin links resolve inside node_modules).
    if (e.t === 'l') {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), e.target ?? ''));
      if (path.posix.isAbsolute(e.target ?? '') || !(resolved === 'node_modules' || resolved.startsWith('node_modules/'))) return work(`link out of node_modules: ${rel}`);
    }
    const owner = owningPackage(rel);
    const m = manifest.files[rel];
    if (owner === null) {
      // Rule 2: outside any package. npm's caches are script residue.
      if (rel === 'node_modules/.vite' || rel.startsWith('node_modules/.vite/') || rel === 'node_modules/.cache' || rel.startsWith('node_modules/.cache/')) { addResidue(rel, e); continue; }
      if (m && matches(e, m)) continue;
      return work(m ? `changed ${rel}` : `extra file outside any package: ${rel}`);
    }
    const info = lock.get(owner);
    if (!info) return work(`no lockfile entry for ${owner}`);
    // Rule 1: a git dependency's files are residue whatever their content.
    if (info.git) { addResidue(rel, e); continue; }
    if (m) {
      // Rule 3: a pinned tarball file must match, except an executable under the
      // package's bin/ in a package with install scripts.
      if (matches(e, m)) continue;
      const within = rel.slice(owner.length + 1).split('/');
      if (info.scripted && e.t === 'f' && (e.mode & 0o111) !== 0 && within.slice(0, -1).includes('bin')) { addResidue(rel, e); continue; }
      return work(`changed ${rel}`);
    }
    // Rule 4: an extra file is install-script output only in a package with install scripts.
    if (info.scripted) { addResidue(rel, e); continue; }
    return work(`extra ${rel}`);
  }
  return { verdict: 'node-modules-residue', reason: 'matches-reference', residue, residueBytes };
}

// ── The residue store (§4 "Script residue goes to a shared, content-addressed store") ──

export class ResidueOverFloorError extends Error {
  constructor(readonly free: number | null, readonly need: number) { super(`residue-over-floor: free ${free ?? 'unknown'} bytes, need the disk floor plus ${need}`); this.name = 'ResidueOverFloorError'; }
}

/** Free and total bytes on the volume holding `dir` (or its nearest existing parent). */
export function volumeOf(dir: string): { free: number; total: number } | null {
  let d = path.resolve(dir);
  for (;;) {
    try { const st = fs.statfsSync(d); return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) }; }
    catch {
      const up = path.dirname(d);
      if (up === d) return null; // @silent-fallback-ok — unknown ⇒ callers keep
      d = up;
    }
  }
}

/** True when archiving `bytes` keeps free space above the disk steward's floor. */
export function residueFits(archiveRoot: string, bytes: number, vol: (d: string) => { free: number; total: number } | null = volumeOf): boolean {
  const v = vol(archiveRoot);
  if (!v) return false;
  return v.free - mediaDiskFloorBytes(v.total) > bytes;
}

export function casDir(archiveRoot: string): string { return path.join(archiveRoot, 'cas'); }

function hashFileAt(file: string): { size: number; sha256: string } {
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let size = 0;
  try {
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n === 0) break; h.update(buf.subarray(0, n)); size += n; }
  } finally { fs.closeSync(fd); }
  return { size, sha256: h.digest('hex') };
}

/**
 * Copy one residue file into the store by content: chunked copy to a temp name
 * while hashing, fsync, re-hash the copy, compare with the hash the comparison
 * recorded, then rename to `cas/<sha256>` (or, when that blob exists, verify it
 * and drop the temp copy). Throws on any mismatch. Returns bytes newly stored.
 */
function storeBlob(src: string, expect: { sha256: string; size: number }, cas: string): number {
  if (!/^[0-9a-f]{64}$/.test(expect.sha256)) throw new Error('bad residue hash');
  const dest = path.join(cas, expect.sha256);
  if (fs.existsSync(dest)) {
    const have = hashFileAt(dest);
    if (have.sha256 !== expect.sha256 || have.size !== expect.size) throw new Error(`store blob ${expect.sha256} does not verify`);
    // The source must still hold exactly these bytes.
    const now = hashFileAt(src);
    if (now.sha256 !== expect.sha256 || now.size !== expect.size) throw new Error(`residue changed since hashing: ${src}`);
    return 0;
  }
  const tmp = path.join(cas, `.${expect.sha256}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  let size = 0;
  try {
    const inFd = fs.openSync(src, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const outFd = fs.openSync(tmp, 'wx', 0o600);
      try {
        for (;;) {
          const n = fs.readSync(inFd, buf, 0, buf.length, null);
          if (n === 0) break;
          h.update(buf.subarray(0, n));
          let off = 0;
          while (off < n) off += fs.writeSync(outFd, buf, off, n - off);
          size += n;
        }
        fs.fsyncSync(outFd);
      } finally { fs.closeSync(outFd); }
    } finally { fs.closeSync(inFd); }
    const sha = h.digest('hex');
    if (sha !== expect.sha256 || size !== expect.size) throw new Error(`residue changed since hashing: ${src}`);
    const copy = hashFileAt(tmp);
    if (copy.sha256 !== sha || copy.size !== size) throw new Error(`store copy does not verify: ${src}`);
    fs.renameSync(tmp, dest);
    return size;
  } catch (err) {
    try { if (fs.existsSync(tmp)) SafeFsExecutor.safeUnlinkSync(tmp, { operation: `${OP}:storeBlob` }); }
    catch { /* @silent-fallback-ok — a dot-prefixed .tmp never reads as a blob */ }
    throw err;
  }
}

export interface ResidueArchive { manifestPath: string; manifestSha256: string; storedBytes: number; entries: NodeModulesResidueEntry[] }

/**
 * Archive a checkout's script residue (§4): every file blob into `cas/`, each
 * fsynced, then the `cas/` folder fsynced; then the residue manifest (type, mode,
 * sha256, link target per path) written atomically and fsynced, and its folder
 * fsynced. Throws (the checkout is kept) on any failure, and ResidueOverFloorError
 * when the copy would take free space below the disk steward's floor.
 */
export function archiveNodeModulesResidue(
  checkout: string,
  record: Pick<NodeModulesVerdictRecord, 'residue' | 'residueBytes' | 'key'>,
  archiveRoot: string,
  opts: { now?: () => number; volume?: (d: string) => { free: number; total: number } | null } = {},
): ResidueArchive {
  const now = opts.now ?? Date.now;
  if (!residueFits(archiveRoot, record.residueBytes, opts.volume)) throw new ResidueOverFloorError(opts.volume ? opts.volume(archiveRoot)?.free ?? null : volumeOf(archiveRoot)?.free ?? null, record.residueBytes);
  fs.mkdirSync(archiveRoot, { recursive: true });
  const ignoreFile = path.join(archiveRoot, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');
  const cas = casDir(archiveRoot);
  fs.mkdirSync(cas, { recursive: true });
  let stored = 0;
  for (const e of record.residue) {
    const abs = path.join(checkout, ...e.path.split('/'));
    const st = fs.lstatSync(abs);
    const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    if (kind !== e.type) throw new Error(`residue changed since hashing: ${e.path} is now ${kind}`);
    if ((st.mode & 0o7777) !== e.mode) throw new Error(`residue changed since hashing: ${e.path} mode`);
    if (e.type === 'symlink' && fs.readlinkSync(abs) !== e.target) throw new Error(`residue changed since hashing: ${e.path} target`);
    if (e.type === 'file') stored += storeBlob(abs, { sha256: e.sha256!, size: e.size! }, cas);
  }
  fsyncDir(cas);
  fsyncDir(archiveRoot);
  const body = JSON.stringify({ version: 1, checkout, key: record.key ?? null, createdAt: now(), entries: record.residue });
  const dir = path.join(archiveRoot, path.basename(checkout), 'node_modules-residue');
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (!existed) { fsyncDir(path.dirname(dir)); fsyncDir(path.dirname(path.dirname(dir))); }
  const target = path.join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`);
  writeFileDurable(target, body);
  return { manifestPath: target, manifestSha256: crypto.createHash('sha256').update(body).digest('hex'), storedBytes: stored, entries: record.residue };
}

/** Re-verify archived residue by hash (§5): every file in the checkout still hashes to its stored blob, which exists and verifies. */
export function verifyResidueArchive(checkout: string, archive: ResidueArchive, archiveRoot: string): void {
  const cas = casDir(archiveRoot);
  for (const e of archive.entries) {
    if (e.type !== 'file') continue;
    const src = hashFileAt(path.join(checkout, ...e.path.split('/')));
    if (src.sha256 !== e.sha256 || src.size !== e.size) throw new Error(`residue changed since archive: ${e.path}`);
    const blob = hashFileAt(path.join(cas, e.sha256!));
    if (blob.sha256 !== e.sha256 || blob.size !== e.size) throw new Error(`store blob does not verify: ${e.path}`);
  }
  const raw = fs.readFileSync(archive.manifestPath);
  if (crypto.createHash('sha256').update(raw).digest('hex') !== archive.manifestSha256) throw new Error('residue manifest changed since archive');
}

/**
 * Restore residue from a residue manifest into `destCheckout` (on top of a fresh
 * install from the lockfile). Folders first, then files with their mode, then links.
 */
export function restoreNodeModulesResidue(residueManifestPath: string, archiveRoot: string, destCheckout: string): number {
  const m = JSON.parse(fs.readFileSync(residueManifestPath, 'utf8')) as { entries: NodeModulesResidueEntry[] };
  const cas = casDir(archiveRoot);
  const sorted = [...m.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  let n = 0;
  for (const e of sorted) {
    if (e.path.split('/').some((s) => s === '..' || s === '.' || s === '') || !e.path.startsWith('node_modules')) throw new Error(`bad residue path ${e.path}`);
    const abs = path.join(destCheckout, ...e.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (e.type === 'dir') { fs.mkdirSync(abs, { recursive: true }); fs.chmodSync(abs, e.mode); n++; continue; }
    try { const st = fs.lstatSync(abs); if (st.isDirectory()) throw new Error(`restore target is a folder: ${e.path}`); SafeFsExecutor.safeUnlinkSync(abs, { operation: `${OP}:restore` }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    if (e.type === 'symlink') { fs.symlinkSync(e.target!, abs); n++; continue; }
    fs.copyFileSync(path.join(cas, e.sha256!), abs);
    fs.chmodSync(abs, e.mode);
    n++;
  }
  return n;
}

// ── The verdict memo (§4 "How it fits the classify flow") ──────────

/** What `classifyIgnoredEntry` reads for a root `node_modules`. */
export interface NodeModulesMemoLookup { lookup(checkout: string): NodeModulesVerdictRecord | null }

function realOrSelf(p: string): string { try { return fs.realpathSync(p); } catch { return path.resolve(p); } } // @silent-fallback-ok — unresolvable ⇒ compare the literal

/**
 * The per-pass memo. In memory for the evaluating process; each verdict is also
 * written (atomic, fsynced) to `<dir>/memo/<sha256(checkout)>.json` with its full
 * stat signature and pass id, and an index records when each checkout was last
 * hashed (the rotation reads it). A lookup answers only for the current pass and
 * only while the folder's cheap stamp is unchanged.
 */
export class NodeModulesMemo implements NodeModulesMemoLookup {
  private passId = '';
  private readonly records = new Map<string, NodeModulesVerdictRecord>();
  private readonly signatures = new Map<string, StatSignature>();
  private index: Record<string, { checkedAt: number; verdict: NodeModulesVerdict }> | null = null;

  constructor(private readonly dir: string | null) {}

  get currentPassId(): string { return this.passId; }

  beginPass(passId: string): void {
    this.passId = passId;
    this.records.clear();
    this.signatures.clear();
  }

  set(record: NodeModulesVerdictRecord, signature: StatSignature | null): void {
    const key = realOrSelf(record.checkout);
    this.records.set(key, record);
    if (signature) this.signatures.set(key, signature);
    if (!this.dir) return;
    try {
      writeFileDurable(path.join(this.dir, 'memo', `${crypto.createHash('sha256').update(key).digest('hex')}.json`), JSON.stringify({ record, signature }));
      if (signature) {
        const idx = this.readIndex();
        idx[key] = { checkedAt: record.checkedAt, verdict: record.verdict };
        writeFileDurable(path.join(this.dir, 'memo-index.json'), JSON.stringify(idx));
      }
    } catch {
      // @silent-fallback-ok — the durable copy is for rotation and audit; an unwritten one makes the
      // checkout look never-checked (it is checked first next pass). The in-memory verdict stands.
    }
  }

  lookup(checkout: string): NodeModulesVerdictRecord | null {
    const r = this.records.get(realOrSelf(checkout));
    if (!r || r.passId !== this.passId || !this.passId) return null;
    if (rootSignature(checkout) !== r.rootSig) return null;
    return r;
  }

  signatureFor(checkout: string): StatSignature | null {
    const r = this.lookup(checkout);
    return r ? this.signatures.get(realOrSelf(checkout)) ?? null : null;
  }

  /** When this checkout was last hashed (any pass), 0 when never. */
  lastCheckedAt(checkout: string): number {
    return this.readIndex()[realOrSelf(checkout)]?.checkedAt ?? 0;
  }

  private readIndex(): Record<string, { checkedAt: number; verdict: NodeModulesVerdict }> {
    if (this.index) return this.index;
    let idx: Record<string, { checkedAt: number; verdict: NodeModulesVerdict }> = {};
    if (this.dir) {
      try { const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'memo-index.json'), 'utf8')) as unknown; if (raw && typeof raw === 'object' && !Array.isArray(raw)) idx = raw as typeof idx; }
      catch { /* @silent-fallback-ok — no index yet: every checkout reads never-checked */ }
    }
    this.index = idx;
    return idx;
  }
}

// ── The per-pass orchestration (§1, §3, §6) ─────────────────────────

/** The reaper deps the pass needs (a subset of makeAgentWorktreeReaperDeps' result). */
export interface NodeModulesPassDeps {
  isInUse: (p: string) => boolean;
  isMerged: (info: { path: string; branch: string | null; headSha: string }) => boolean;
  isCleanExceptRootNodeModules: (p: string) => boolean;
}

export interface NodeModulesPassOptions {
  deps: NodeModulesPassDeps;
  worktrees: Array<{ path: string; branch: string | null; headSha: string }>;
  memo: NodeModulesMemo;
  /** Manifests, scratch and build status live here. */
  refsDir: string;
  /** The residue store's archive root (free-space check, store size). */
  archiveRoot: string;
  /** At most this many checkouts are hashed per pass (the reaper's maxReapsPerPass). */
  maxHashes: number;
  npmMajor: string | null;
  passId: string;
  now?: () => number;
  volume?: (d: string) => { free: number; total: number } | null;
  hashSeams?: HashSeams;
}

export interface NodeModulesCheck {
  verdict: NodeModulesVerdict;
  reason: string;
  residueBytes?: number;
  allocatedBytes?: number | null;
  key?: string;
}

export interface NodeModulesPassSummary {
  passId: string;
  /** Per checkout path, for those held back only by a real root `node_modules`. */
  checks: Record<string, NodeModulesCheck>;
  /** Keys of the otherwise-eligible checkouts (a manifest for one of these is needed). */
  eligibleKeys: string[];
  /** Keys with no manifest yet, each with one checkout to copy the two input files from. */
  needed: Array<{ key: string; sourceCheckout: string }>;
  /** Keys of every checkout holding a real npm `node_modules` (a manifest of another key is unneeded). */
  keysInUse: string[];
  manifests: { count: number; bytes: number };
  storeBytes: number | null;
  scratchHighWaterBytes: number;
  npmMajor: string | null;
}

/** Sum of apparent sizes under `root` (links not followed); null when unreadable. */
function treeBytes(root: string): number | null {
  let total = 0;
  try {
    if (!fs.existsSync(root)) return 0;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop()!;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else total += fs.lstatSync(full).size;
      }
    }
    return total;
  } catch {
    return null; // @silent-fallback-ok — unmeasured, reported as null
  }
}

function isRealDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; } // @silent-fallback-ok — absent ⇒ not real
}

/**
 * Compute every root `node_modules` verdict for this pass and write the memo.
 * A checkout is considered only when it holds a real root `node_modules` and is
 * otherwise eligible (not in use, on a branch, `isCleanExceptRootNodeModules`,
 * merged). Hashing is bounded to `maxHashes`, oldest-checked first; the rest read
 * `unchecked`, never `work`.
 */
export function runNodeModulesPass(opts: NodeModulesPassOptions): NodeModulesPassSummary {
  const now = opts.now ?? Date.now;
  opts.memo.beginPass(opts.passId);
  const status = readBuildStatus(opts.refsDir);
  const manifestsBefore = new Set(listManifests(opts.refsDir).map((m) => m.key));
  const checks: Record<string, NodeModulesCheck> = {};
  const keysInUse = new Set<string>();
  const eligibleKeys = new Set<string>();
  const needed = new Map<string, string>();
  const toHash: Array<{ path: string; key: string; lock: Map<string, LockPackageInfo> }> = [];
  const record = (p: string, c: NodeModulesCheck, extra: Partial<NodeModulesVerdictRecord> = {}, signature: StatSignature | null = null): void => {
    checks[p] = c;
    opts.memo.set({
      passId: opts.passId, checkout: p, verdict: c.verdict, reason: c.reason, key: c.key, checkedAt: now(),
      residue: [], residueBytes: c.residueBytes ?? 0, allocatedBytes: c.allocatedBytes ?? null, rootSig: rootSignature(p), ...extra,
    }, signature);
  };

  for (const info of opts.worktrees) {
    const p = info.path;
    if (!isRealDir(path.join(p, 'node_modules'))) continue;
    const isNpm = fs.existsSync(path.join(p, 'node_modules', '.package-lock.json'));
    const inputs = isNpm ? readReferenceInputs(p) : null;
    const key = inputs && opts.npmMajor ? (() => { try { return referenceKey(inputs, opts.npmMajor!); } catch { return null; } })() : null; // @silent-fallback-ok — no key ⇒ handled below
    if (key) keysInUse.add(key);
    // Otherwise eligible (the named, tested predicate): only then is any proof attempted.
    let eligible = false;
    try { eligible = !opts.deps.isInUse(p) && !!info.branch && opts.deps.isCleanExceptRootNodeModules(p) && opts.deps.isMerged(info); }
    catch { eligible = false; } // @silent-fallback-ok — an unreadable signal ⇒ not eligible ⇒ the checkout is kept as today
    if (!eligible) continue;
    if (!isNpm) { record(p, { verdict: 'work', reason: 'not-npm' }); continue; }
    if (!inputs) { record(p, { verdict: 'work', reason: 'no-lockfile' }); continue; }
    const lock = analyzeLockfile(inputs.packageLock.toString('utf8'), p);
    if (!lock.ok) { record(p, { verdict: 'work', reason: lock.reason }); continue; }
    if (!key) { record(p, { verdict: 'reference-unavailable', reason: 'npm-version-unknown' }); continue; }
    eligibleKeys.add(key);
    if (!manifestsBefore.has(key)) {
      const st = status.keys[key];
      if (!needed.has(key)) needed.set(key, p);
      record(p, st ? { verdict: 'reference-unavailable', reason: st.cause, key } : { verdict: 'unchecked', reason: 'reference-pending', key });
      continue;
    }
    toHash.push({ path: p, key, lock: lock.packages });
  }

  // Rotation: oldest-checked first, at most maxHashes per pass.
  toHash.sort((a, b) => opts.memo.lastCheckedAt(a.path) - opts.memo.lastCheckedAt(b.path) || (a.path < b.path ? -1 : 1));
  let hashed = 0;
  for (const c of toHash) {
    if (hashed >= opts.maxHashes) { record(c.path, { verdict: 'unchecked', reason: 'rotation', key: c.key }); continue; }
    const manifest = readManifest(opts.refsDir, c.key);
    if (!manifest) { if (!needed.has(c.key)) needed.set(c.key, c.path); record(c.path, { verdict: 'unchecked', reason: 'reference-pending', key: c.key }); continue; }
    hashed++;
    touchManifest(opts.refsDir, c.key, now());
    const stamp = rootSignature(c.path);
    let tree: HashedTree;
    try { tree = hashNodeModulesTree(c.path, opts.hashSeams); }
    catch (err) { record(c.path, { verdict: 'work', reason: err instanceof TreeChangedError ? err.message : `hash failed: ${(err as Error).message.slice(0, 200)}`, key: c.key }); continue; }
    const cmp = compareWithManifest(tree, manifest, c.lock);
    if (cmp.verdict === 'node-modules-residue' && !residueFits(opts.archiveRoot, cmp.residueBytes, opts.volume)) {
      record(c.path, { verdict: 'residue-over-floor', reason: 'archive would take free space below the disk floor', key: c.key, residueBytes: cmp.residueBytes, allocatedBytes: tree.allocatedBytes }, { rootSig: stamp });
      continue;
    }
    record(c.path, { verdict: cmp.verdict, reason: cmp.reason, key: c.key, residueBytes: cmp.residueBytes, allocatedBytes: tree.allocatedBytes },
      { residue: cmp.residue, rootSig: stamp }, tree.signature);
  }

  const manifests = listManifests(opts.refsDir);
  return {
    passId: opts.passId,
    checks,
    eligibleKeys: [...eligibleKeys],
    needed: [...needed].map(([key, sourceCheckout]) => ({ key, sourceCheckout })),
    keysInUse: [...keysInUse],
    manifests: { count: manifests.length, bytes: manifests.reduce((s, m) => s + m.bytes, 0) },
    storeBytes: treeBytes(casDir(opts.archiveRoot)),
    scratchHighWaterBytes: status.scratchHighWaterBytes,
    npmMajor: opts.npmMajor,
  };
}

/** Allocated bytes (st_blocks × 512) under `root`, links not followed; null when unreadable. */
export function allocatedBytes(root: string): number | null {
  let total = 0;
  try {
    const top = fs.lstatSync(root);
    total += top.blocks * 512;
    if (!top.isDirectory()) return total;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop()!;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        total += fs.lstatSync(full).blocks * 512;
        if (ent.isDirectory()) stack.push(full);
      }
    }
    return total;
  } catch {
    return null; // @silent-fallback-ok — unmeasured, reported as null
  }
}
