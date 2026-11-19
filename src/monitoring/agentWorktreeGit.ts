/**
 * Git-backed signal sources for the AgentWorktreeReaper. Kept separate from the
 * classifier so the reaper stays unit-testable with fakes; the merged-detection
 * is itself a standalone, fake-git-testable function.
 *
 * All queries are read-only (SafeGitExecutor.readSync). The single destructive
 * op — `git worktree remove` — goes through SafeGitExecutor.execSync.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';
import { classifyPorcelain } from '../core/worktreeDirtyCheck.js';
import type { AgentWorktreeReaperDeps, WorktreeInfo } from './AgentWorktreeReaper.js';
import { type WorktreeEnumeration, summarizeEnumerationError } from './worktreeEnumeration.js';
import { GENERATED_STANDARDS_REGISTRY_OUTPUTS } from '../core/standardsRegistryPath.js';

/**
 * Reaper-specific residue denylist (spec: worktree-reaper-untracked-blindspot).
 * Empty by design. This gates an irreversible `git worktree remove`, and even
 * cache/marker names can hold unique user-authored bytes. Keep any such file
 * until it is explicitly inspected or archived by a separate cleanup path.
 * We do NOT mutate DEFAULT_RESIDUE_DENYLIST (it feeds the separate yield-safety
 * config list + other consumers); the reaper carries its own list.
 */
export const REAPER_RESIDUE_DENYLIST: readonly string[] = [];

/** Read-only git executor signature (injected so this module is testable). */
export type ReadGit = (args: string[], cwd: string) => string;

/**
 * The commit gate's own per-change records. Only names the gate itself writes
 * match (ISO timestamp prefix, directly in the record folder, `.json`): a
 * hand-named file there is still treated as work and keeps the checkout.
 */
const GATE_RECORD_PATH = /^\.instar\/instar-dev-(?:decisions|traces)\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[^/]+\.json$/;

export function isGateRecordPath(relPath: string): boolean {
  return GATE_RECORD_PATH.test(relPath);
}

/**
 * Ignored entries a merged, clean checkout can lose without losing work
 * (spec docs/specs/disk-steward.md §4). Each class is corroborated by the
 * checkout itself, never by the name alone:
 *   - a `node_modules` SYMLINK (any depth): removed as a link by
 *     `git worktree remove`, never followed, so its target (often an install
 *     many checkouts share) is untouched. A real `node_modules` directory stays
 *     `work`: nothing in the checkout proves it holds no hand edits, and other
 *     checkouts may link into it.
 *   - root `dist/`: only when every file in it maps back to a source file
 *     the checkout's own tsconfig compiles into it (see distIsBuildOutput).
 *   - `src/data/standards-registry.md`: only when its git blob hash equals
 *     `HEAD:docs/STANDARDS-REGISTRY.md`, so its exact bytes are in a commit
 *     (spec reaper-generated-files-regenerable §1).
 * `archived-residue` (spec reaper-generated-files-regenerable §2-3): the closed
 * list of the repo's own generated files below, regular files only. Not proven,
 * so their bytes are archived and verified before removal, like gate records.
 * Anything else ignored stays `work`, as before (a hand-made `notes/dist/`
 * or an `audit-data/` folder keeps the checkout).
 */
export type IgnoredEntryClass = 'gate-record' | 'regenerable' | 'archived-residue' | 'work';

/**
 * The repo's own generated files (spec docs/specs/reaper-generated-files-regenerable.md §2).
 * A closed list: each entry names the step that writes it. These are NOT proven
 * regenerable, so `preserveGateRecords` archives their bytes and verifies the
 * copy before the checkout can be removed. A path is added here only with a
 * named writer and a measurement, never by a judgment at deletion time.
 */
export const ARCHIVED_RESIDUE_FILES: Readonly<Record<string, string>> = {
  'src/data/standards-registry.meta.json': 'scripts/generate-standards-registry-asset.mjs',
  'src/data/standards-guard-index.json': 'scripts/generate-standards-registry-asset.mjs',
  'src/data/standards-guard-index.meta.json': 'scripts/generate-standards-registry-asset.mjs',
  'src/data/builtin-manifest.json': 'scripts/generate-builtin-manifest.cjs',
  '.instar/standards-coverage.json': 'scripts/standards-coverage.mjs',
  '.instar/dup-build-cache.json': 'scripts/lib/duplicate-build-check.mjs',
  '.instar/docs-coverage.json': 'scripts/docs-coverage.mjs',
  '.instar/docs-coverage.md': 'scripts/docs-coverage.mjs',
};

/**
 * Folders whose direct children are archived residue (one level only; a
 * subfolder, a link or a name off the rule makes the whole folder `work`).
 *   - `.husky/_/`: husky's install in `npm run prepare` (hook stubs, `h`, `husky.sh`, `.gitignore`).
 *   - `.instar/audit/`: the per-checkout SafeGitExecutor / SafeFsExecutor audit trails.
 */
export const ARCHIVED_RESIDUE_DIRS: Readonly<Record<string, { writer: string; child: RegExp }>> = {
  '.husky/_': { writer: 'husky install (npm run prepare)', child: /^[^/]+$/ },
  '.instar/audit': { writer: 'SafeGitExecutor / SafeFsExecutor audit trail', child: /^[^/]+\.jsonl(?:\.1)?$/ },
};

/** The generator writes a verbatim byte copy of this tracked file (scripts/generate-standards-registry-asset.mjs). */
export const REGISTRY_COPY_PATH: string = GENERATED_STANDARDS_REGISTRY_OUTPUTS[0];
export const REGISTRY_SOURCE_PATH = 'docs/STANDARDS-REGISTRY.md';

/** All compiler outputs of one build are written within this window. */
export const DIST_BUILD_WINDOW_MS = 15 * 60_000;

/** dist/ subfolders the repo's own `build` script writes beside tsc output. */
export const BUILD_GENERATED_DIST_DIRS = ['data', 'keys', 'native'] as const;

function readTsconfigDirs(checkout: string): { outDir?: string; rootDir?: string } | null {
  try {
    const raw = fs.readFileSync(path.join(checkout, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const co = (JSON.parse(raw) as { compilerOptions?: { outDir?: unknown; rootDir?: unknown } }).compilerOptions ?? {};
    const norm = (v: unknown) => (typeof v === 'string' ? path.normalize(v).replace(/[\\/]+$/, '') : undefined);
    return { outDir: norm(co.outDir), rootDir: norm(co.rootDir) };
  } catch {
    return null; // @silent-fallback-ok — no readable build config ⇒ dist/ is not corroborated ⇒ work (KEEP)
  }
}

/**
 * Root `dist/` is build output only when (a) the checkout's own tsconfig builds
 * `rootDir` into `outDir: dist`, and (b) every file under it is either a
 * compiler output of a source file present in `rootDir` (`x.js`, `x.d.ts` and
 * their maps for `x.ts`/`x.tsx`/`x.mts`/`x.cts`/`x.js`) or lives in a folder the
 * build script generates. Any other file (a hand-placed `dist/hotfix.js`) means
 * `work`. The checkout is clean and merged when this runs, so a present source
 * file is tracked source.
 */
function distIsBuildOutput(checkout: string): boolean {
  const dirs = readTsconfigDirs(checkout);
  if (!dirs || dirs.outDir !== 'dist' || !dirs.rootDir) return false;
  const distRoot = path.join(checkout, 'dist');
  const srcRoot = path.join(checkout, dirs.rootDir);
  try {
    if (fs.lstatSync(distRoot).isSymbolicLink()) return true; // removed as a link, never followed
    const stack = [''];
    let minMtime = Infinity;
    let maxMtime = -Infinity;
    while (stack.length) {
      const rel = stack.pop()!;
      for (const ent of fs.readdirSync(path.join(distRoot, rel), { withFileTypes: true })) {
        const childRel = rel ? path.join(rel, ent.name) : ent.name;
        if (ent.isDirectory()) { stack.push(childRel); continue; }
        const top = childRel.split(path.sep)[0];
        if ((BUILD_GENERATED_DIST_DIRS as readonly string[]).includes(top) && childRel !== top) {
          // Written by the build script in the same build: only the window check applies.
          const gm = fs.lstatSync(path.join(distRoot, childRel)).mtimeMs;
          if (gm < minMtime) minMtime = gm;
          if (gm > maxMtime) maxMtime = gm;
          continue;
        }
        const m = /^(.*)\.(?:d\.ts\.map|d\.ts|js\.map|js|d\.mts|mjs|d\.cts|cjs)(?:\.map)?$/.exec(childRel);
        if (!m) return false;
        const stem = path.join(srcRoot, m[1]);
        if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'].some((ext) => fs.existsSync(stem + ext))) return false;
        const mt = fs.lstatSync(path.join(distRoot, childRel)).mtimeMs;
        if (mt < minMtime) minMtime = mt;
        if (mt > maxMtime) maxMtime = mt;
      }
    }
    // The compiler rewrites every output on each build, so all outputs share one
    // build window. A file edited by hand afterwards falls outside it ⇒ work.
    return maxMtime === -Infinity || maxMtime - minMtime <= DIST_BUILD_WINDOW_MS;
  } catch {
    return false; // @silent-fallback-ok — unreadable output ⇒ not corroborated ⇒ work (KEEP)
  }
}

export function classifyIgnoredEntry(relPath: string, checkout: string, readGit?: ReadGit): IgnoredEntryClass {
  if (isGateRecordPath(relPath)) return 'gate-record';
  const segments = relPath.replace(/\/+$/, '').split('/');
  if (segments.some((s) => s === '' || s === '..' || s === '.')) return 'work';
  const nm = segments.indexOf('node_modules');
  if (nm >= 0) return isSymlink(path.join(checkout, ...segments.slice(0, nm + 1))) ? 'regenerable' : 'work';
  if (segments[0] === 'dist' && distIsBuildOutput(checkout)) return 'regenerable';
  const rel = segments.join('/');
  if (rel === REGISTRY_COPY_PATH) return readGit && registryCopyIsCommitted(checkout, readGit) ? 'regenerable' : 'work';
  if (Object.prototype.hasOwnProperty.call(ARCHIVED_RESIDUE_FILES, rel)) {
    return isPlainFileInCheckout(checkout, segments) ? 'archived-residue' : 'work';
  }
  if (Object.prototype.hasOwnProperty.call(ARCHIVED_RESIDUE_DIRS, rel)) {
    // A wholly ignored folder git reports as one entry: read exactly one level.
    return expandResidueDir(checkout, rel) ? 'archived-residue' : 'work';
  }
  const parent = segments.slice(0, -1).join('/');
  if (segments.length > 1 && Object.prototype.hasOwnProperty.call(ARCHIVED_RESIDUE_DIRS, parent)) {
    // One child of a listed folder, reported by name.
    return ARCHIVED_RESIDUE_DIRS[parent].child.test(segments[segments.length - 1]) && isPlainFileInCheckout(checkout, segments)
      ? 'archived-residue' : 'work';
  }
  return 'work';
}

/**
 * The registry copy is provably in a commit only when its git blob hash equals
 * the blob of its tracked source at HEAD. Any failure ⇒ not proven ⇒ work.
 */
function registryCopyIsCommitted(checkout: string, readGit: ReadGit): boolean {
  const segments = REGISTRY_COPY_PATH.split('/');
  if (!isPlainFileInCheckout(checkout, segments)) return false;
  try {
    const copy = readGit(['-C', checkout, 'hash-object', '--no-filters', '--', path.join(checkout, ...segments)], checkout).trim();
    const source = readGit(['-C', checkout, 'rev-parse', '--verify', '--quiet', `HEAD:${REGISTRY_SOURCE_PATH}`], checkout).trim();
    return /^[0-9a-f]{40,64}$/.test(copy) && copy === source;
  } catch {
    return false; // @silent-fallback-ok — no proof ⇒ work (KEEP)
  }
}

/** A regular file (never a link) whose every folder on the way from the checkout is a real folder. */
function isPlainFileInCheckout(checkout: string, segments: string[]): boolean {
  try {
    for (let i = 1; i < segments.length; i++) {
      if (!fs.lstatSync(path.join(checkout, ...segments.slice(0, i))).isDirectory()) return false;
    }
    return fs.lstatSync(path.join(checkout, ...segments)).isFile();
  } catch {
    return false; // @silent-fallback-ok — unreadable ⇒ not proven a plain file ⇒ work (KEEP)
  }
}

/**
 * The children of a listed residue folder, as checkout-relative paths, or null
 * when the folder (or any folder above it) is a link, or any child is not a
 * regular file matching the folder's rule.
 */
function expandResidueDir(checkout: string, relDir: string): string[] | null {
  const rule = ARCHIVED_RESIDUE_DIRS[relDir];
  if (!rule) return null;
  const segments = relDir.split('/');
  try {
    for (let i = 1; i <= segments.length; i++) {
      if (!fs.lstatSync(path.join(checkout, ...segments.slice(0, i))).isDirectory()) return null;
    }
    const out: string[] = [];
    for (const ent of fs.readdirSync(path.join(checkout, ...segments), { withFileTypes: true })) {
      if (!ent.isFile() || !rule.child.test(ent.name)) return null;
      out.push(`${relDir}/${ent.name}`);
    }
    return out;
  } catch {
    return null; // @silent-fallback-ok — unreadable ⇒ work (KEEP)
  }
}

/** True only for a symbolic link (lstat; the link is never followed). */
function isSymlink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); }
  catch { return false; } // @silent-fallback-ok — unreadable ⇒ not proven a link ⇒ work (KEEP)
}

/**
 * Checkouts under `worktreesDir` that some symlink OUTSIDE them points into
 * (disk-steward §4). On Echo's Studio worktrees chain their node_modules
 * through each other and the 2.0 pipeline links into checkouts, so removing a
 * link target breaks every checkout behind it. Walks, without blocking the
 * event loop: each checkout's top levels (not inside node_modules), the agent
 * home's top level, `.worktrees-deps/` and `.instar/lanes/` in full. Each link
 * is resolved both lexically (catches a target that is itself a link) and by
 * realpath. null when any walk fails or runs out of time (callers then keep
 * every checkout).
 */
export interface InboundLinkIndex {
  /** Realpaths of checkouts something outside them links into. */
  linked: Set<string>;
  /** Unreadable folders owned by another account (skipped; their links cannot be used by this agent's processes). */
  skippedForeign: string[];
}

/**
 * Walk `root` for symlinks without following them. maxDepth counts levels below
 * root; `pruneName` folders are not entered. Returns null when a folder this
 * account owns cannot be read (unknown ⇒ callers keep everything). A folder
 * owned by another account that this account cannot read is skipped and
 * listed: no process running as this account can traverse it to use its links.
 */
async function walkLinks(root: string, maxDepth: number, pruneName: string | null, out: string[], skipped: string[], deadline: number): Promise<boolean> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const stack: Array<[string, number]> = [[root, 0]];
  while (stack.length) {
    if (Date.now() > deadline) return false;
    const [dir, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // @silent-fallback-ok — an unreadable folder makes the index unknown (false), which keeps every checkout
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && dir !== root) continue; // vanished mid-walk
      if (code === 'ENOENT') return true;
      if (code === 'EACCES' || code === 'EPERM') {
        try {
          const st = await fs.promises.lstat(dir);
          if (uid >= 0 && st.uid !== uid) { skipped.push(dir); continue; }
        } catch { /* @silent-fallback-ok — unknown owner ⇒ unknown index, which keeps every checkout */ }
      }
      return false;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) out.push(full);
      else if (e.isDirectory() && depth < maxDepth && e.name !== pruneName) stack.push([full, depth + 1]);
    }
  }
  return true;
}

export async function buildInboundLinkIndex(agentHome: string, worktreesDir: string, opts?: { timeoutMs?: number }): Promise<InboundLinkIndex | null> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 300_000);
  const worktreesReal = (() => { try { return fs.realpathSync(worktreesDir); } catch { return worktreesDir; } })(); // @silent-fallback-ok — unresolvable ⇒ compare the literal path
  const links: string[] = [];
  const skippedForeign: string[] = [];
  const walks: Array<[string, number, string | null]> = [
    [worktreesDir, 3, 'node_modules'],
    [agentHome, 0, null],
    [path.join(agentHome, '.worktrees-deps'), Number.MAX_SAFE_INTEGER, null],
    [path.join(agentHome, '.instar', 'lanes'), Number.MAX_SAFE_INTEGER, null],
  ];
  for (const [root, depth, prune] of walks) {
    if (!(await walkLinks(root, depth, prune, links, skippedForeign, deadline))) return null;
  }
  const owner = (p: string): string | null => {
    const norm = p === worktreesDir || p.startsWith(worktreesDir + path.sep) ? worktreesReal + p.slice(worktreesDir.length) : p;
    if (!norm.startsWith(worktreesReal + path.sep)) return null;
    const slug = norm.slice(worktreesReal.length + 1).split(path.sep)[0];
    return slug ? path.join(worktreesReal, slug) : null;
  };
  const linked = new Set<string>();
  for (const link of links) {
    let target: string;
    try { target = await fs.promises.readlink(link); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // removed mid-walk
      return null; // @silent-fallback-ok — unreadable link ⇒ unknown index ⇒ every checkout kept
    }
    const from = owner(link);
    const lexical = owner(path.resolve(path.dirname(link), target));
    if (lexical && lexical !== from) linked.add(lexical);
    try {
      const real = owner(await fs.promises.realpath(link));
      if (real && real !== from) linked.add(real);
    } catch { /* dangling link: the lexical target is what matters */ }
  }
  return { linked, skippedForeign };
}

/**
 * Untracked only. A staged record is someone's in-progress commit, and a locally
 * edited tracked record cannot be put back here (the source-tree guard refuses
 * `git restore`, deliberately), so both keep the checkout.
 */
function isUntrackedGateRecord(line: string): boolean {
  return line.startsWith('?? ') && isGateRecordPath(line.slice(3));
}

function statusLines(porcelain: string): string[] {
  return porcelain.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
}

/** `--untracked-files=all` so a wholly-untracked record folder lists each file, not the folder. */
const statusArgs = (p: string): string[] => ['-C', p, 'status', '--porcelain', '--untracked-files=all'];
const ignoredArgs = (p: string): string[] => ['-C', p, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'];

/** One file the archive step copies: its checkout-relative path, size and sha256. */
export interface ResidueManifestEntry { relPath: string; size: number; sha256: string }

/** What `preserveGateRecords` archived, for the final re-check before removal. */
export interface ResidueManifest {
  /** Files still in the checkout after the archive step (ignored gate records + archived residue), sorted. */
  entries: ResidueManifestEntry[];
  /** How many files were archived (gate records + residue). */
  archived: number;
  /** Untracked gate records the archive step deleted (their folders may now collapse into one ignored entry). */
  removedUntracked: string[];
}

interface ArchivableListing {
  /** Untracked gate records (deleted after archiving, so a non-forced remove succeeds). */
  untracked: string[];
  /** Ignored gate records. */
  ignoredRecords: string[];
  /** Archived residue files (folder entries expanded one level). */
  residue: string[];
}

/**
 * Everything the checkout holds beyond its commits, sorted into what may be
 * archived. Throws on anything that is work (tracked change, untracked non-record,
 * ignored work), so the caller keeps the checkout BEFORE changing anything.
 */
function listArchivable(p: string, readGit: ReadGit, expandable: ReadonlySet<string> = new Set()): ArchivableListing {
  const untracked: string[] = [];
  for (const line of statusLines(readGit(statusArgs(p), p))) {
    if (!isUntrackedGateRecord(line)) throw new Error(`not gate-records-only: ${line}`);
    untracked.push(line.slice(3));
  }
  const ignoredRecords: string[] = [];
  const residue: string[] = [];
  const entries = readGit(ignoredArgs(p), p).split('\0').filter(Boolean);
  // git can report a folder AND the files inside it; each path is classified once.
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const relPath = entries[i];
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    const kind = classifyIgnoredEntry(relPath, p, readGit);
    if (kind === 'work' && relPath.endsWith('/') && expandable.has(relPath.replace(/\/+$/, ''))) {
      // A folder that only collapsed into one entry because the archive step
      // deleted the untracked records beside its ignored files: list its files
      // by name and classify each, exactly as before the deletion.
      entries.push(...readGit(['-C', p, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', relPath], p).split('\0').filter(Boolean));
      continue;
    }
    // Regenerable entries go with the checkout (git worktree remove deletes ignored
    // files); they are neither archived nor a reason to keep it.
    if (kind === 'regenerable') continue;
    if (kind === 'gate-record') { ignoredRecords.push(relPath); continue; }
    if (kind === 'archived-residue') {
      const rel = relPath.replace(/\/+$/, '');
      if (Object.prototype.hasOwnProperty.call(ARCHIVED_RESIDUE_DIRS, rel)) {
        const children = expandResidueDir(p, rel);
        if (!children) throw new Error(`not gate-records-only: ${relPath}`);
        residue.push(...children);
      } else {
        residue.push(rel);
      }
      continue;
    }
    throw new Error(`not gate-records-only: ${relPath}`);
  }
  return { untracked, ignoredRecords: [...new Set(ignoredRecords)], residue: [...new Set(residue)] };
}

const COPY_CHUNK_BYTES = 1024 * 1024;

/** sha256 + size of a file, read in bounded memory. */
function hashFile(file: string): { size: number; sha256: string } {
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  const fd = fs.openSync(file, 'r');
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      size += n;
    }
  } finally { fs.closeSync(fd); }
  return { size, sha256: h.digest('hex') };
}

/**
 * Copy one file into the archive in bounded memory: stream to a temporary name
 * in the destination folder while hashing the bytes read, fsync, re-hash the
 * copy, then rename into place. A failed or mismatched copy is unlinked, so no
 * partial file is ever left looking archived. Identical bytes already archived
 * are overwritten; different bytes get a hash suffix. Returns the source's hash
 * and size (taken from the same read that wrote the copy).
 */
function archiveFile(src: string, dest: string): { size: number; sha256: string } {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let size = 0;
  try {
    const inFd = fs.openSync(src, 'r');
    try {
      const outFd = fs.openSync(tmp, 'wx');
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
    const sha256 = h.digest('hex');
    const copy = hashFile(tmp);
    if (copy.sha256 !== sha256 || copy.size !== size) throw new Error(`archive verification failed: ${src}`);
    let target = dest;
    if (fs.existsSync(target) && hashFile(target).sha256 !== sha256) target = `${dest}.${sha256.slice(0, 8)}`;
    fs.renameSync(tmp, target);
    return { size, sha256 };
  } catch (err) {
    try { if (fs.existsSync(tmp)) SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'src/monitoring/agentWorktreeGit.ts:archiveFile' }); }
    catch { /* @silent-fallback-ok — a stray temp name never reads as archived (it is dot-prefixed + .tmp); the throw below keeps the checkout */ }
    throw err;
  }
}

/** True when `child` is `parent` or inside it (both resolved through realpath where possible). */
function isWithin(child: string, parent: string): boolean {
  const real = (x: string) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } }; // @silent-fallback-ok — unresolvable ⇒ compare the resolved literal
  const c = real(child);
  const pr = real(parent);
  return c === pr || c.startsWith(pr + path.sep);
}

/** Free bytes on the volume that holds `dir` (or its nearest existing parent); null when unreadable. */
function freeBytesAt(dir: string): number | null {
  let d = path.resolve(dir);
  for (;;) {
    try {
      const st = fs.statfsSync(d);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      const up = path.dirname(d);
      if (up === d) return null; // @silent-fallback-ok — unknown free space ⇒ caller keeps the checkout
      d = up;
    }
  }
}

/**
 * Copy a checkout's gate records and archived residue out to
 * `<archiveRoot>/<worktree>/<relative path>`, verify each copy, and delete the
 * untracked gate records, which would otherwise make a non-forced
 * `git worktree remove` refuse. Throws (the reaper then keeps the checkout) on
 * anything that is work, BEFORE changing the checkout. Order (spec
 * reaper-generated-files-regenerable §4): gate records are archived and the
 * untracked ones unlinked BEFORE the residue is archived, so nothing this step
 * does can land in residue after its copy. Returns the manifest the final
 * re-check compares against.
 */
export function preserveGateRecords(p: string, archiveRoot: string, readGit: ReadGit): ResidueManifest {
  const { untracked, ignoredRecords, residue } = listArchivable(p, readGit);
  const records = [...untracked, ...ignoredRecords];
  const all = [...records, ...residue];
  let totalBytes = 0;
  for (const relPath of all) {
    const st = fs.lstatSync(path.join(p, relPath));
    if (!st.isFile()) throw new Error(`not a regular file: ${relPath}`);
    totalBytes += st.size;
  }
  // A locked checkout will refuse removal, so leave its records where they are.
  if (fs.existsSync(path.join(readGit(['-C', p, 'rev-parse', '--absolute-git-dir'], p).trim(), 'locked'))) {
    throw new Error('checkout is locked');
  }
  // The executors' audit trail must not be written into the checkout being removed.
  const auditDir = process.env.INSTAR_AUDIT_LOG_DIR;
  if (process.env.INSTAR_AUDIT_LOG_DISABLED !== '1') {
    if (auditDir && isWithin(auditDir, p)) throw new Error('INSTAR_AUDIT_LOG_DIR points inside the checkout');
    if (!auditDir && isWithin(process.cwd(), p)) throw new Error('this process works inside the checkout (its audit trail would land there)');
  }
  // The copy must physically fit on the archive's volume.
  if (all.length > 0) {
    const free = freeBytesAt(archiveRoot);
    if (free === null || free <= totalBytes) throw new Error(`archive volume has too little free space (${free ?? 'unknown'} <= ${totalBytes} bytes)`);
  }
  const worktreeArchive = path.join(archiveRoot, path.basename(p));
  const ensureIgnoreFile = (): void => {
    // Machine-local, like the ignored traces it holds: state sync must not pick it up.
    fs.mkdirSync(archiveRoot, { recursive: true });
    const ignoreFile = path.join(archiveRoot, '.gitignore');
    if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');
  };
  if (all.length > 0) ensureIgnoreFile();
  // 1) Gate records: archived (on disk, verified) before the untracked originals are deleted.
  // Keep each record's hash from the same read that wrote its archive copy: a record
  // rewritten after the copy must fail the final re-check (second-pass review, 2026-11-18).
  const recordHashes = new Map<string, { size: number; sha256: string }>();
  for (const relPath of records) recordHashes.set(relPath, archiveFile(path.join(p, relPath), path.join(worktreeArchive, relPath)));
  for (const relPath of untracked) {
    SafeFsExecutor.safeUnlinkSync(path.join(p, relPath), { operation: 'src/monitoring/agentWorktreeGit.ts:preserveGateRecords' });
  }
  // 2) Residue: archived last; the final re-check compares against these hashes.
  const entries: ResidueManifestEntry[] = [];
  for (const relPath of ignoredRecords) entries.push({ relPath, ...(recordHashes.get(relPath) ?? hashFile(path.join(p, relPath))) });
  for (const relPath of residue) entries.push({ relPath, ...archiveFile(path.join(p, relPath), path.join(worktreeArchive, relPath)) });
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  // Ignored records and residue are archived above; `git worktree remove` takes them with the checkout.
  return { entries, archived: all.length, removedUntracked: untracked };
}

/**
 * The final re-check's file half (spec §4): re-list the checkout's full residue
 * with the same enumeration and classification, re-hash every file, and throw
 * when anything differs from what was archived: a file added, removed, renamed,
 * replaced or changed type, or any size or hash change. Untracked gate records
 * were deleted by the archive step, so any untracked entry now is new.
 */
export function recheckResidueManifest(p: string, archived: ResidueManifest, readGit: ReadGit): void {
  // Folders above the archived files may now be reported whole (see listArchivable).
  const expandable = new Set<string>();
  for (const rel of [...archived.entries.map((e) => e.relPath), ...archived.removedUntracked]) {
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) expandable.add(segs.slice(0, i).join('/'));
  }
  const now = listArchivable(p, readGit, expandable);
  if (now.untracked.length > 0) throw new Error(`residue changed since archive: new untracked ${now.untracked[0]}`);
  const rels = [...now.ignoredRecords, ...now.residue].sort();
  const want = archived.entries.map((e) => e.relPath);
  if (rels.length !== want.length || rels.some((r, i) => r !== want[i])) {
    throw new Error('residue changed since archive: the file list differs');
  }
  for (const e of archived.entries) {
    const file = path.join(p, e.relPath);
    if (!fs.lstatSync(file).isFile()) throw new Error(`residue changed since archive: ${e.relPath} is no longer a regular file`);
    const h = hashFile(file);
    if (h.size !== e.size || h.sha256 !== e.sha256) throw new Error(`residue changed since archive: ${e.relPath}`);
  }
}

/** Sum of apparent file sizes under `root`, never following links; null when unreadable or past `maxEntries`. */
export function apparentBytes(root: string, maxEntries = 500_000): number | null {
  let total = 0;
  let seen = 0;
  let top: fs.Stats;
  try { top = fs.lstatSync(root); }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null; } // @silent-fallback-ok — absent ⇒ 0 bytes; unreadable ⇒ unknown
  if (!top.isDirectory()) return top.size;
  const stack = [root];
  try {
    while (stack.length) {
      const dir = stack.pop()!;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (++seen > maxEntries) return null;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        total += fs.lstatSync(full).size;
      }
    }
    return total;
  } catch {
    return null; // @silent-fallback-ok — an unmeasurable size reads as unknown, never zero
  }
}

/**
 * Dry-run projection for one eligible checkout (spec §5): the residue bytes the
 * archive step would copy (gate records + archived residue) and the apparent
 * bytes removal would reclaim. null when it cannot be measured.
 */
export function projectReclaim(p: string, readGit: ReadGit): { residueBytes: number; apparentBytes: number } | null {
  try {
    const { untracked, ignoredRecords, residue } = listArchivable(p, readGit);
    let residueBytes = 0;
    for (const rel of [...untracked, ...ignoredRecords, ...residue]) residueBytes += fs.lstatSync(path.join(p, rel)).size;
    const apparent = apparentBytes(p);
    return apparent === null ? null : { residueBytes, apparentBytes: apparent };
  } catch {
    return null; // @silent-fallback-ok — unknown projection, reported as null
  }
}

/** What the checkout's root `node_modules` is, for the report's counts. */
export function nodeModulesKind(p: string): 'real' | 'symlink' | 'none' | 'unknown' {
  try {
    const st = fs.lstatSync(path.join(p, 'node_modules'));
    return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'real' : 'unknown';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unknown';
  }
}

/**
 * True when any command line names the checkout. The path counts when a
 * delimiter precedes it: start, whitespace, a quote, `=`, `/` (file:// URLs) or
 * `:` (PATH-style lists); also the `.worktrees/<slug>` token with any prefix
 * (relative, `~`, another spelling of the home). More matches only keep more.
 */
function commandsName(commands: string[], p: string, real: string): boolean {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = (x: string) => new RegExp(`(^|[\\s'"=/:])${esc(x)}(/|[\\s'":]|$)`);
  const rel = new RegExp(`(^|[\\s'"=/:~.])\\.worktrees/${esc(path.basename(real))}(/|[\\s'":]|$)`);
  const patterns = [names(real), names(p), rel];
  return commands.some((c) => patterns.some((re) => re.test(c)));
}

const defaultReadGit: ReadGit = (args, cwd) =>
  SafeGitExecutor.readSync(args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    operation: 'src/monitoring/agentWorktreeGit.ts',
    // The agent home IS a checkout of the instar source tree, so every read the
    // reaper makes (worktree list, status, cherry, rev-parse) trips the
    // SourceTreeGuard without these. readSync still rejects any destructive shape,
    // so the flags only widen the SOURCE-TREE bypass for genuine reads.
    sourceTreeReadOk: true,
    sourceTreeWorktreeManagerOk: true,
  });

/**
 * Resolve the canonical default branch ref that exists locally, preferring the
 * upstream remote. Returns null when none resolve (→ callers treat merged as
 * unknown and KEEP).
 */
export function resolveBaseRef(readGit: ReadGit, repo: string): string | null {
  for (const ref of ['JKHeadley/main', 'upstream/main', 'origin/main', 'main']) {
    try {
      readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], repo);
      return ref;
    } catch { /* try next */ }
    try {
      readGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], repo);
      return ref;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * True when EVERY commit unique to `branchSha` already has an equivalent patch
 * in `baseRef` — i.e. the branch's content is in the default branch. Uses
 * `git cherry` (patch-id equivalence), which catches fast-forward, merge-commit,
 * rebased, and single-commit-squash merges. A multi-commit squash-merge is NOT
 * detected (its commits' individual patch-ids differ from the squashed commit) →
 * reported NOT merged → KEPT. Conservative by design: it never false-positives
 * "merged", so the reaper never deletes unmerged work.
 */
export function isBranchMerged(readGit: ReadGit, repo: string, baseRef: string, branchSha: string): boolean {
  let out: string;
  try {
    out = readGit(['-C', repo, 'cherry', baseRef, branchSha], repo);
  } catch {
    return false; // cannot determine → treat as unmerged (KEEP)
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true; // no commits ahead of base ⇒ merged
  return lines.every((l) => l.startsWith('-'));
}

/** Run `gh` and return stdout, or null on ANY failure (gh missing, not authed,
 *  not a GitHub repo, timeout). Null is the conservative signal → caller keeps. */
export type RunGh = (args: string[], cwd: string) => string | null;

const defaultRunGh: RunGh = (args, cwd) => {
  try {
    // Funnel through withSyncOp so the in-flight marker sees this blocking spawn
    // (event-loop-resilience spec): the reaper runs in-process on a timer, and a
    // bounded gh call must not read as a "stuck" event loop to the watchdogs.
    return withSyncOp(() => execFileSync('gh', args, { cwd, encoding: 'utf-8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return null; // @silent-fallback-ok — gh unavailable ⇒ no PR signal ⇒ KEEP (conservative)
  }
};

/**
 * Fetch a map of `headRefName → headRefOid` for MERGED PRs, to detect
 * MULTI-COMMIT squash-merges that `git cherry` (patch-id) cannot — the
 * disk-accumulation root cause: a multi-commit branch squash-merged into one
 * commit on main has different commit SHAs/patch-ids, so cherry reports it
 * UNMERGED and the worktree is kept forever. A merged PR is the authoritative
 * "the content is in main" signal; pairing it with an EXACT head-OID match (in
 * the caller) ensures a branch with commits ADDED AFTER the merge is still kept.
 *
 * ONE `gh` call per sweep (bounded `--limit`); fail-safe to an EMPTY map on any
 * error so the reaper degrades to exactly today's cherry-only behavior (KEEP).
 */
export function fetchMergedPrHeadOids(repo: string, opts?: { runGh?: RunGh; limit?: number }): Map<string, string> {
  const runGh = opts?.runGh ?? defaultRunGh;
  const limit = opts?.limit ?? 500;
  const map = new Map<string, string>();
  const out = runGh(['pr', 'list', '--state', 'merged', '--json', 'headRefName,headRefOid', '--limit', String(limit)], repo);
  if (!out) return map; // conservative: no signal
  let arr: unknown;
  try { arr = JSON.parse(out); } catch { return map; }
  if (!Array.isArray(arr)) return map;
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const name = (row as { headRefName?: unknown }).headRefName;
    const oid = (row as { headRefOid?: unknown }).headRefOid;
    if (typeof name === 'string' && typeof oid === 'string' && name && oid) {
      // Latest merged PR for a (reused) branch name wins — gh returns newest first.
      if (!map.has(name)) map.set(name, oid);
    }
  }
  return map;
}

/**
 * Build the production git/fs-backed deps for the AgentWorktreeReaper.
 * `worktreesDir` bounds which `git worktree list` entries are considered (the
 * agent's `.worktrees/`); the main checkout and any out-of-tree worktrees are
 * excluded.
 */
export function makeAgentWorktreeReaperDeps(opts: {
  instarRepo: string;
  worktreesDir: string;
  readGit?: ReadGit;
  /** Override the process-cwd scanner (testing). Returns the set of worktree
   *  ROOT paths that currently have a live process cwd inside them. */
  cwdRoots?: () => Set<string> | null;
  /** Override the inbound-link index builder (testing). null = scan failed. */
  inboundLinks?: () => Promise<Set<string> | null>;
  /** Override the running-process command-line scan (testing). null = scan failed. */
  commandLines?: () => string[] | null;
  /** When true (default), `isMerged` falls back to GitHub merged-PR state to
   *  detect multi-commit squash-merges that `git cherry` cannot. Fail-safe:
   *  any gh error degrades to cherry-only (KEEP). Set false to disable the
   *  network call entirely (the legacy cherry-only behavior). */
  githubMergeCheck?: boolean;
  /** Override the merged-PR map source (testing). Returns headRefName→headRefOid. */
  mergedPrMap?: () => Map<string, string>;
  /** Where gate records go before a checkout is removed. Default: `<agent home>/.instar/instar-dev-decisions-archive`. */
  gateRecordArchiveDir?: string;
  now?: () => number;
}): AgentWorktreeReaperDeps {
  const readGit = opts.readGit ?? defaultReadGit;
  const gateRecordArchiveDir = opts.gateRecordArchiveDir
    ?? path.join(path.dirname(opts.worktreesDir), '.instar', 'instar-dev-decisions-archive');
  const repo = opts.instarRepo;
  const githubMergeCheck = opts.githubMergeCheck ?? true;
  const worktreesReal = (() => { try { return fs.realpathSync(opts.worktreesDir); } catch { return opts.worktreesDir; } })();
  const within = (p: string): boolean => {
    const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })();
    return real === worktreesReal || real.startsWith(worktreesReal + path.sep);
  };

  // Process-cwd scan, memoized for a short TTL so a single reap pass runs `lsof`
  // ONCE, not once per worktree. Maps every process cwd under `.worktrees/` to
  // its worktree root (the immediate child dir). lsof failure ⇒ empty set (fall
  // back to lock files; the reaper still ships dark + dry-run + reviewed).
  const defaultCwdRoots = (): Set<string> | null => {
    const roots = new Set<string>();
    let out: string;
    // lint-allow-blocking-scan: AgentWorktreeReaper ships dark + dry-run + reviewed
    // (off by default), so this full-cwd `lsof` is not on any live agent's hot path;
    // bounded by a 15s timeout. Async conversion is tracked as a post-mortem
    // follow-up (docs/postmortems/2026-06-07-server-temporarily-down.md, root cause #4).
    try {
      out = execFileSync('lsof', ['-w', '-d', 'cwd', '-Fn'], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
    } catch { return null; } // @silent-fallback-ok — no cwd signal ⇒ isInUse keeps every checkout (disk-steward §4)
    for (const line of out.split('\n')) {
      if (line.charCodeAt(0) !== 110 /* 'n' */) continue;
      const p = line.slice(1);
      if (!p.startsWith(worktreesReal + path.sep)) continue;
      const rest = p.slice(worktreesReal.length + 1);
      const slug = rest.split(path.sep)[0];
      if (slug) roots.add(path.join(worktreesReal, slug));
    }
    return roots;
  };
  const cwdRootsFn = opts.cwdRoots ?? defaultCwdRoots;
  let cwdCache: Set<string> | null = null;
  let cwdCacheAt = 0;
  const cwdRootsCached = (): Set<string> | null => {
    const t = Date.now();
    if (cwdCacheAt === 0 || t - cwdCacheAt > 10_000) { cwdCache = cwdRootsFn(); cwdCacheAt = t; }
    return cwdCache;
  };

  // Every running process's command line, memoized like the cwd scan. null =
  // the scan failed (treated as in use by isInUse).
  const commandLinesFn = opts.commandLines ?? ((): string[] | null => {
    try {
      // lint-allow-blocking-scan: the reaper's pass is already synchronous and off by default (like its lsof scan above); memoized 10 s, bounded 15 s.
      return withSyncOp(() => execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }))
        .split('\n').filter(Boolean);
    } catch {
      return null; // @silent-fallback-ok — no process list ⇒ isInUse reports in use (KEEP)
    }
  });
  let commandCache: string[] | null = null;
  let commandCacheAt = 0;
  const commandLinesCached = (): string[] | null => {
    const t = Date.now();
    if (commandCacheAt === 0 || t - commandCacheAt > 10_000) { commandCache = commandLinesFn(); commandCacheAt = t; }
    return commandCache;
  };

  // Inbound-link index, rebuilt by preparePass at the start of every pass and
  // before each snapshot. undefined = never built, null = the scan failed:
  // both keep every checkout.
  let inboundLinks: Set<string> | null | undefined;
  let skippedForeignDirs: string[] = [];
  let prepareSeq = 0;
  let appliedSeq = 0;
  const inboundLinksFn = opts.inboundLinks ?? (async (): Promise<Set<string> | null> => {
    const idx = await buildInboundLinkIndex(path.dirname(opts.worktreesDir), opts.worktreesDir);
    skippedForeignDirs = idx?.skippedForeign ?? [];
    if (skippedForeignDirs.length) console.warn(`[agent-worktree-reaper] link scan skipped ${skippedForeignDirs.length} folder(s) owned by another account: ${skippedForeignDirs.slice(0, 3).join(', ')}`);
    return idx ? idx.linked : null;
  });

  // Merged-PR map (headRefName→headRefOid), cached for a short TTL so a single
  // reap pass makes ONE `gh` call, not one per worktree. The map only fixes the
  // multi-commit-squash blind spot in `git cherry`; it is consulted lazily (only
  // when cherry says unmerged) so a fully cherry-detectable repo never calls gh.
  const mergedPrMapFn = opts.mergedPrMap ?? (() => fetchMergedPrHeadOids(repo));
  let prMapCache: Map<string, string> | null = null;
  let prMapCacheAt = 0;
  const mergedPrMapCached = (): Map<string, string> => {
    const t = Date.now();
    if (!prMapCache || t - prMapCacheAt > 60_000) { prMapCache = mergedPrMapFn(); prMapCacheAt = t; }
    return prMapCache;
  };

  return {
    preparePass: async (): Promise<void> => {
      // Last-started wins, never last-finished: an older walk that ends late
      // must not replace a newer index that saw a fresh link.
      const startedAt = ++prepareSeq;
      let next: Set<string> | null;
      try { next = await inboundLinksFn(); }
      catch { next = null; } // @silent-fallback-ok — failed index ⇒ isInUse keeps every checkout
      if (startedAt >= appliedSeq) { appliedSeq = startedAt; inboundLinks = next; }
    },

    listWorktrees: (): WorktreeEnumeration<WorktreeInfo> => {
      let porcelain: string;
      // REPORT the failure as a state, do not swallow it. `catch { return [] }`
      // here made an enumeration FAILURE indistinguishable from "this agent has no
      // worktrees", so a mis-wired `repo` produced a permanent clean bill of health
      // (2026-07-29: `reclaimable: 0` reported against 73 real worktrees because
      // `git -C <repo>` was failing outright).
      //
      // Returning `{ ok: false }` rather than throwing is the structural half: a
      // caller cannot reach the list without narrowing on `ok`, so "forgot to
      // handle failure" is a compile error instead of a silent zero.
      try { porcelain = readGit(['-C', repo, 'worktree', 'list', '--porcelain'], repo); }
      catch (err) {
        // @silent-fallback-ok — this is a typed failure result, not a fallback:
        // the caller records the failure event/history and enters on-blind posture.
        return {
          ok: false,
          error: summarizeEnumerationError(
            new Error(`worktree enumeration failed for repo "${repo}": ${err instanceof Error ? err.message : String(err)}`),
          ),
        };
      }
      const out: WorktreeInfo[] = [];
      let cur: Partial<WorktreeInfo> = {};
      for (const line of porcelain.split('\n')) {
        if (line.startsWith('worktree ')) {
          cur = { path: line.slice('worktree '.length).trim() };
        } else if (line.startsWith('HEAD ')) {
          cur.headSha = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        } else if (line.startsWith('detached')) {
          cur.branch = null;
        } else if (line.trim() === '') {
          if (cur.path && within(cur.path)) {
            out.push({ path: cur.path, branch: cur.branch ?? null, headSha: cur.headSha ?? '' });
          }
          cur = {};
        }
      }
      if (cur.path && within(cur.path)) {
        out.push({ path: cur.path, branch: cur.branch ?? null, headSha: cur.headSha ?? '' });
      }
      return { ok: true, worktrees: out };
    },

    isClean: (p: string): boolean => {
      // ANY change — tracked, untracked, or ignored — is dirty, because even a
      // marker name may hold unique bytes. The one exception is the commit gate's
      // own records: removeWorktree archives those before anything is deleted.
      // FAIL-CLOSED on any error: cannot determine cleanliness → treat as dirty
      // (KEEP). This is the deletion-safe direction (spec
      // worktree-reaper-untracked-blindspot, convergence BLOCKER): a transient
      // `git status` failure must never make a worktree look reapable.
      try {
        const work = statusLines(readGit(statusArgs(p), p)).filter((line) => !isUntrackedGateRecord(line));
        if (classifyPorcelain(work.join('\n'), REAPER_RESIDUE_DENYLIST)) return false;
        // Archived residue is like a gate record: removeWorktree archives it first.
        return readGit(ignoredArgs(p), p).split('\0').filter(Boolean).every((rel) => classifyIgnoredEntry(rel, p, readGit) !== 'work');
      }
      catch { return false; }
    },

    isMerged: (info: WorktreeInfo): boolean => {
      const base = resolveBaseRef(readGit, repo);
      if (!base || !info.headSha) return false;
      // 1) Patch-id equivalence (fast, offline): fast-forward / merge / rebase /
      //    single-commit-squash. Never false-positives "merged".
      if (isBranchMerged(readGit, repo, base, info.headSha)) return true;
      // 2) Multi-commit squash-merge: `git cherry` cannot see it (SHAs differ).
      //    Consult GitHub merged-PR state — but require an EXACT head-OID match so
      //    a branch with commits ADDED AFTER the merge is still KEPT (those would
      //    be unmerged work). Fail-safe: an empty/missing map ⇒ KEEP.
      if (githubMergeCheck && info.branch) {
        const oid = mergedPrMapCached().get(info.branch);
        if (oid && oid === info.headSha) return true;
      }
      return false;
    },

    isInUse: (p: string): boolean => {
      // A live session lock or a git index lock means in-flight work — KEEP.
      for (const lock of ['.session.lock', path.join('.git', 'index.lock')]) {
        try { if (fs.existsSync(path.join(p, lock))) return true; } catch { /* ignore */ }
      }
      // A running process whose cwd is inside the worktree — KEEP.
      let real: string;
      try {
        real = fs.realpathSync(p);
        const cwds = cwdRootsCached();
        if (cwds === null || cwds.has(real)) return true;
      } catch { real = p; }
      // Another checkout or a pipeline folder links into this one — KEEP. An
      // index that was never built or failed to build keeps every checkout.
      if (!inboundLinks || inboundLinks.has(real)) return true;
      // A running process started from files inside the worktree (e.g.
      // `node <worktree>/dist/...` launched elsewhere) — KEEP. An unreadable
      // process list reads as in use (disk-steward §4).
      const commands = commandLinesCached();
      if (commands === null) return true;
      return commandsName(commands, p, real);
    },

    currentBranch: (p: string): string | null => {
      // The LIVE checked-out branch, read at RECLAIM time to close the enumerate→reclaim
      // TOCTOU. Format matches listWorktrees' info.branch (short name, no refs/heads/).
      // FAIL-CLOSED: any error → null, which cannot equal a real info.branch, so the
      // reclaimRaceGuard KEEPS (never reap on an unreadable live branch).
      try {
        const b = (readGit(['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD'], p) ?? '').trim();
        return b && b !== 'HEAD' ? b : null; // 'HEAD' = detached → null
      } catch {
        // @silent-fallback-ok: fail-closed — an unreadable live branch returns null,
        // which can never equal a real info.branch, so the reclaim guard KEEPS (never
        // reaps on an uncertain branch). The delete-safe direction, not a swallowed bug.
        return null;
      }
    },

    hasActiveBuildMarker: (p: string): boolean => {
      // Belt-and-suspenders: an in-flight builder's explicit "don't reap me" claim.
      // FAIL-CLOSED: an error reading the marker is treated as PRESENT (KEEP), the
      // deletion-safe direction.
      try { return fs.existsSync(path.join(p, '.instar-build-active')); }
      catch {
        // @silent-fallback-ok: fail-closed — an fs error reading the marker is treated
        // as PRESENT (KEEP), the delete-safe direction. Not a swallowed bug.
        return true;
      }
    },

    removeWorktree: (p: string): void => {
      // Deliberately NOT --force: the non-forced form refuses to remove a worktree
      // with uncommitted changes or a lock, so it can never destroy in-flight work.
      // The SourceTreeGuard mirrors this — it allows `worktree remove` against the
      // source tree only without --force (see isAllowedWorktreeManagerSubcommand).
      // Gate records go to the archive first; if that fails this throws and the
      // reaper keeps the checkout.
      const manifest = preserveGateRecords(p, gateRecordArchiveDir, readGit);
      // FINAL RE-CHECK (spec reaper-generated-files-regenerable §4), right before
      // the irreversible remove: the residue must be exactly what was archived, and
      // no process may have started in the checkout. The process lists are read
      // FRESH here (never the 10 s memo isInUse uses). A throw keeps the checkout.
      recheckResidueManifest(p, manifest, readGit);
      const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })(); // @silent-fallback-ok — unresolvable ⇒ compare the literal path
      const cwds = cwdRootsFn();
      if (cwds === null) throw new Error('final re-check: working-folder scan failed');
      if (cwds.has(real) || cwds.has(p)) throw new Error('final re-check: a process now works inside the checkout');
      const commands = commandLinesFn();
      if (commands === null) throw new Error('final re-check: process list unreadable');
      if (commandsName(commands, p, real)) throw new Error('final re-check: a running process names the checkout');
      SafeGitExecutor.execSync(['-C', repo, 'worktree', 'remove', p], {
        timeout: 60_000,
        operation: 'src/monitoring/agentWorktreeGit.ts:removeWorktree',
        sourceTreeWorktreeManagerOk: true,
      });
    },

    // Report-only measurements (spec reaper-generated-files-regenerable §5).
    projectReclaim: (p: string) => projectReclaim(p, readGit),
    nodeModulesKind: (p: string) => nodeModulesKind(p),
    archiveBytes: () => apparentBytes(gateRecordArchiveDir),

    now: opts.now,
  };
}
