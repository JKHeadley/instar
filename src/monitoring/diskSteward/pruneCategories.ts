/**
 * Disk Steward — the two cleanup categories (spec docs/specs/disk-steward.md §3.6).
 * Runs inside the prune child, never on the server's event loop. Each category
 * has a planner and an executor; every doubt skips. Only two tool-owned caches
 * are ever touched: npm's cache (through npm itself, bound to the measured
 * root) and entries directly under Xcode's DerivedData.
 *
 * Accepted risk, stated in the spec: npm and Xcode take part in no lock, so a
 * build that starts between the last process check and a deletion can fail and
 * need a rerun. Nothing authored is lost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

const execFileP = promisify(execFile);
export const GiB = 1024 ** 3;

export type CategoryId = 'npm-cache' | 'derived-data';

export interface CategoryResult {
  category: CategoryId;
  plannedBytes: number;
  plannedItems: number;
  removedItems: number;
  bytesFreed: number;
  skipped?: string;
  error?: string;
}

export interface ProcessRow { elapsedSec: number; command: string }

export interface PruneSeams {
  /** Every process, with elapsed time; null when the list cannot be read (⇒ busy). */
  processes(): Promise<ProcessRow[] | null>;
  /** Run a command without a shell; rejects on non-zero exit or timeout. */
  run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string }>;
  /** Size of a folder in bytes (du -sk), null when unreadable. */
  sizeOf(p: string, timeoutMs: number): Promise<number | null>;
  /** Device id of a path's volume, null when unreadable. */
  devOf(p: string): number | null;
  readdir(p: string): string[] | null;
  lstat(p: string): fs.Stats | null;
  realpath(p: string): string | null;
  remove(p: string): Promise<void>;
  now(): number;
  home: string;
  platform: NodeJS.Platform;
}

/** ps elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseElapsed(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
}

/** §3.6: an npm-family install or fetch that started in the last 30 min. */
const NPM_BUSY = [
  /\b(npm|pnpm|yarn)(\.cmd)?\s+(install|i|ci|add|update|exec|x)\b/,
  /\bnpx\b/,
  /npm-cli\.js\s+(install|i|ci|exec|x)\b/,
];
export function npmBusy(rows: readonly ProcessRow[]): boolean {
  return rows.some((r) => r.elapsedSec <= 30 * 60 && NPM_BUSY.some((re) => re.test(r.command)));
}

const XCODE_BUSY = ['xcodebuild', 'XCBBuildService', 'swift-build', 'Xcode', 'SourceKitService'];
export function xcodeBusy(rows: readonly ProcessRow[]): boolean {
  return rows.some((r) => {
    const exe = r.command.split(/\s+/)[0] ?? '';
    const base = path.basename(exe);
    return XCODE_BUSY.includes(base) || /\/Xcode\.app\/Contents\/MacOS\/Xcode\b/.test(r.command);
  });
}

function result(category: CategoryId, partial: Partial<CategoryResult> = {}): CategoryResult {
  return { category, plannedBytes: 0, plannedItems: 0, removedItems: 0, bytesFreed: 0, ...partial };
}

/** npm cache: only above the size limit, only while nothing npm-family is installing, bound to the measured root. */
export async function pruneNpmCache(seams: PruneSeams, opts: { dryRun: boolean; maxGiB: number; budgetMs: number; agentHomeDev: number | null }): Promise<CategoryResult> {
  let root: string;
  try {
    root = (await seams.run('npm', ['config', 'get', 'cache'], 30_000)).stdout.trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result('npm-cache', /ENOENT/.test(msg) ? { skipped: 'not-installed' } : { skipped: 'npm-config-unreadable', error: msg.slice(0, 200) });
  }
  if (!root || !path.isAbsolute(root)) return result('npm-cache', { skipped: 'npm-config-unreadable' });
  const cacache = path.join(root, '_cacache');
  if (!seams.lstat(cacache)) return result('npm-cache', { skipped: 'no-cache' });
  if (opts.agentHomeDev !== null && seams.devOf(cacache) !== opts.agentHomeDev) return result('npm-cache', { skipped: 'other-volume' });
  const size = await seams.sizeOf(cacache, Math.min(opts.budgetMs, 300_000));
  if (size === null) return result('npm-cache', { skipped: 'size-unreadable' });
  if (size <= opts.maxGiB * GiB) return result('npm-cache', { plannedBytes: 0, skipped: 'under-limit' });
  const planned = { plannedBytes: size, plannedItems: 1 };
  if (opts.dryRun) return result('npm-cache', { ...planned, skipped: 'dry-run' });
  for (let read = 0; read < 2; read++) {
    const rows = await seams.processes();
    if (rows === null) return result('npm-cache', { ...planned, skipped: 'process-list-unreadable' });
    if (npmBusy(rows)) return result('npm-cache', { ...planned, skipped: 'npm-busy' });
  }
  try {
    await seams.run('npm', ['cache', 'clean', '--force', '--cache', root], opts.budgetMs);
  } catch (e) {
    return result('npm-cache', { ...planned, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
  }
  return result('npm-cache', { ...planned, removedItems: 1, bytesFreed: size });
}

/** Xcode DerivedData: entries older than 24 h, contained, never while an Xcode build tool runs. */
export async function pruneDerivedData(seams: PruneSeams, opts: { dryRun: boolean; budgetMs: number; agentHomeDev: number | null }): Promise<CategoryResult> {
  if (seams.platform !== 'darwin') return result('derived-data', { skipped: 'not-macos' });
  const dd = path.join(seams.home, 'Library', 'Developer', 'Xcode', 'DerivedData');
  const ddStat = seams.lstat(dd);
  if (!ddStat) return result('derived-data', { skipped: 'not-installed' });
  // A relocated (symlinked) DerivedData could point anywhere: refuse it.
  if (ddStat.isSymbolicLink() || !ddStat.isDirectory()) return result('derived-data', { skipped: 'derived-data-not-a-plain-folder' });
  const ddReal = seams.realpath(dd);
  if (!ddReal) return result('derived-data', { skipped: 'not-installed' });
  if (opts.agentHomeDev !== null && seams.devOf(ddReal) !== opts.agentHomeDev) return result('derived-data', { skipped: 'other-volume' });
  const started = seams.now();
  const cutoff = started - 24 * 3_600_000;
  const names = seams.readdir(ddReal);
  if (names === null) return result('derived-data', { skipped: 'unreadable' });
  const candidates: Array<{ p: string; bytes: number }> = [];
  for (const name of names) {
    if (seams.now() - started > opts.budgetMs) break;
    // Only folders named the way Xcode names them: `<Name>-<28 lowercase letters>` or `*.noindex`.
    if (!/^.+-[a-z]{28}$/.test(name) && !/\.noindex$/.test(name)) continue;
    const p = path.join(ddReal, name);
    const st = seams.lstat(p);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    if (seams.realpath(p) !== p || path.dirname(p) !== ddReal) continue;
    const newest = Math.max(
      st.mtimeMs,
      ...['Logs/Build', 'Index.noindex'].map((sub) => seams.lstat(path.join(p, sub))?.mtimeMs ?? 0),
    );
    if (newest > cutoff) continue;
    const bytes = await seams.sizeOf(p, 120_000);
    if (bytes === null) continue;
    candidates.push({ p, bytes });
  }
  const plannedBytes = candidates.reduce((a, c) => a + c.bytes, 0);
  const planned = { plannedBytes, plannedItems: candidates.length };
  if (opts.dryRun || candidates.length === 0) return result('derived-data', { ...planned, ...(opts.dryRun ? { skipped: 'dry-run' } : {}) });
  let removedItems = 0;
  let bytesFreed = 0;
  for (const c of candidates) {
    if (seams.now() - started > opts.budgetMs) return result('derived-data', { ...planned, removedItems, bytesFreed, skipped: 'budget' });
    const rows = await seams.processes();
    if (rows === null) return result('derived-data', { ...planned, removedItems, bytesFreed, skipped: 'process-list-unreadable' });
    if (xcodeBusy(rows)) return result('derived-data', { ...planned, removedItems, bytesFreed, skipped: 'xcode-busy' });
    const st = seams.lstat(c.p);
    if (!st || st.isSymbolicLink() || seams.realpath(c.p) !== c.p) continue; // changed since planning
    try {
      await seams.remove(c.p);
      removedItems++;
      bytesFreed += c.bytes;
    } catch (e) {
      return result('derived-data', { ...planned, removedItems, bytesFreed, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  return result('derived-data', { ...planned, removedItems, bytesFreed });
}

/** Production seams. */
export function realPruneSeams(): PruneSeams {
  return {
    processes: async () => {
      try {
        const { stdout } = await execFileP('ps', ['-axww', '-o', 'etime=,command='], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
        return stdout.split('\n').filter(Boolean).map((line) => {
          const t = line.trim();
          const sp = t.indexOf(' ');
          return { elapsedSec: parseElapsed(sp < 0 ? t : t.slice(0, sp)), command: sp < 0 ? '' : t.slice(sp + 1).trim() };
        });
      } catch {
        return null; // @silent-fallback-ok — unreadable process list ⇒ categories skip as busy
      }
    },
    run: async (cmd, args, timeoutMs) => {
      const { stdout } = await execFileP(cmd, args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return { stdout };
    },
    sizeOf: async (p, timeoutMs) => {
      try {
        const { stdout } = await execFileP('du', ['-sk', p], { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1024 * 1024 });
        const kb = Number(stdout.trim().split(/\s+/)[0]);
        return Number.isFinite(kb) ? kb * 1024 : null;
      } catch {
        return null; // @silent-fallback-ok — unmeasurable ⇒ not planned
      }
    },
    devOf: (p) => { try { return fs.statSync(p).dev; } catch { return null; } }, // @silent-fallback-ok — unknown volume ⇒ other-volume skip
    readdir: (p) => { try { return fs.readdirSync(p); } catch { return null; } }, // @silent-fallback-ok — unreadable ⇒ category skips
    lstat: (p) => { try { return fs.lstatSync(p); } catch { return null; } }, // @silent-fallback-ok — absent ⇒ not a candidate
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } }, // @silent-fallback-ok — unresolvable ⇒ not contained ⇒ skipped
    remove: (p) => SafeFsExecutor.safeRm(p, { recursive: true, force: true, operation: 'src/monitoring/diskSteward/pruneCategories.ts:derived-data' }),
    now: () => Date.now(),
    home: os.homedir(),
    platform: process.platform,
  };
}
