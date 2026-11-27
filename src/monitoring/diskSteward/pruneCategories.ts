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

/** `context-archive`: the per-topic transcript archive (context-budget-layered-summaries §9.7). */
export type CategoryId = 'npm-cache' | 'derived-data' | 'context-archive';

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
  /**
   * Size with a lower bound on timeout (§3.7a): `du -k -d 1` prints each child as
   * it finishes, so a timed-out walk still reports the children it summed.
   * null when nothing at all was read.
   */
  sizeAtLeast?(p: string, timeoutMs: number): Promise<{ bytes: number; complete: boolean } | null>;
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

/**
 * §3.6: npm is busy when something is writing its cache.
 * - An install-family command that started in the last 30 min (install, ci,
 *   add, update): these write the cache for their whole run.
 * - An `npx` / `npm exec` only in its first 2 minutes: it fetches while it
 *   starts, then runs from the cache. Every agent session starts a long-lived
 *   `npm exec @playwright/mcp@latest`; with sessions starting every few
 *   minutes, a 30-minute window kept npm "busy" around the clock and the cache
 *   was never cleaned (fb-eb8372d8-043).
 * A fetch that runs longer is still caught by {@link npmCacheWriting}.
 */
const NPM_INSTALL_BUSY = [
  /\b(npm|pnpm|yarn)(\.cmd)?\s+(install|i|ci|add|update)\b/,
  /npm-cli\.js\s+(install|i|ci)\b/,
];
const NPM_EXEC_BUSY = [
  /\b(npm|pnpm|yarn)(\.cmd)?\s+(exec|x)\b/,
  /\bnpx\b/,
  /npm-cli\.js\s+(exec|x)\b/,
];
export const NPM_EXEC_START_WINDOW_SEC = 120;
export function npmBusy(rows: readonly ProcessRow[]): boolean {
  return rows.some((r) =>
    (r.elapsedSec <= 30 * 60 && NPM_INSTALL_BUSY.some((re) => re.test(r.command)))
    || (r.elapsedSec <= NPM_EXEC_START_WINDOW_SEC && NPM_EXEC_BUSY.some((re) => re.test(r.command))));
}

/**
 * The cache's own state: npm writes each fetched blob to `_cacache/tmp/` and
 * moves it into place when done. An entry there changed in the last 2 minutes
 * means a write is in progress, whatever process is doing it. Older entries are
 * leftovers from interrupted fetches and are not a writer. Unreadable ⇒ busy.
 */
export const NPM_CACHE_WRITE_WINDOW_MS = 120_000;
export function npmCacheWriting(seams: Pick<PruneSeams, 'readdir' | 'lstat' | 'now'>, cacache: string): boolean {
  const tmp = path.join(cacache, 'tmp');
  if (!seams.lstat(tmp)) return false;
  const names = seams.readdir(tmp);
  if (names === null) return true;
  const cutoff = seams.now() - NPM_CACHE_WRITE_WINDOW_MS;
  for (const n of names) {
    const st = seams.lstat(path.join(tmp, n));
    if (!st) continue; // @silent-fallback-ok — vanished between readdir and lstat: a write that just finished
    if (st.mtimeMs >= cutoff) return true;
  }
  return false;
}

/**
 * Xcode build tools and the Xcode app. SourceKitService is not here: it is the
 * toolchain's indexing/editor XPC service, stays up for hours with no build
 * (20 h on the Studio, 2026-11-18), and kept DerivedData "busy" forever
 * (fb-eb8372d8-043). An open Xcode still counts, because it may build at any time.
 */
const XCODE_BUSY = ['xcodebuild', 'XCBBuildService', 'swift-build', 'Xcode'];
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
    if (npmBusy(rows) || npmCacheWriting(seams, cacache)) return result('npm-cache', { ...planned, skipped: 'npm-busy' });
  }
  let error: string | undefined;
  try {
    await seams.run('npm', ['cache', 'clean', '--force', '--cache', root], opts.budgetMs);
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  // What was freed is measured, not inferred from npm's exit status: `npm cache
  // clean` can delete nearly everything and still exit non-zero (fb-eecd4dde-608,
  // 13.7 GB -> 0.34 GB recorded as 0). The breaker and the audit read this number.
  const after = seams.lstat(cacache) ? await seams.sizeOf(cacache, Math.min(opts.budgetMs, 300_000)) : 0;
  if (after === null) {
    // Unmeasurable after: a clean exit keeps the old answer (all of it); an error claims nothing.
    return result('npm-cache', error ? { ...planned, error } : { ...planned, removedItems: 1, bytesFreed: size });
  }
  const bytesFreed = Math.max(0, size - after);
  return result('npm-cache', { ...planned, removedItems: bytesFreed > 0 ? 1 : 0, bytesFreed, ...(error ? { error } : {}) });
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
    sizeAtLeast: async (p, timeoutMs) => {
      let out = '';
      let complete = true;
      try {
        out = (await execFileP('du', ['-k', '-d', '1', p], { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })).stdout;
      } catch (e) {
        // Timed out or a folder was unreadable: keep what du printed before it stopped.
        out = String((e as { stdout?: unknown }).stdout ?? '');
        complete = false;
      }
      return parseDuDepth1(out, p, complete);
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

/**
 * `du -k -d 1 <p>` output → bytes. The line for `p` itself is the total; without
 * it (the walk was stopped) the children printed so far are summed: a lower bound.
 */
export function parseDuDepth1(out: string, p: string, completeRun: boolean): { bytes: number; complete: boolean } | null {
  let total: number | null = null;
  let children = 0;
  let any = false;
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    any = true;
    const kb = Number(m[1]);
    if (m[2].replace(/\/+$/, '') === p.replace(/\/+$/, '')) total = kb;
    else children += kb;
  }
  if (total !== null) return { bytes: total * 1024, complete: completeRun };
  return any ? { bytes: children * 1024, complete: false } : null;
}
