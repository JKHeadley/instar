/**
 * Dependency cache per lockfile hash (docs/specs/feedback-triage-and-execution.md §4 step 3).
 *
 * Built by trusted code from the BASE SHA's manifests only — no script from any feedback branch
 * ever runs during install (`--ignore-scripts`). Then only a pinned allow-list of native modules
 * is built: copied from the agent home when the module version and Node ABI match (no network),
 * otherwise rebuilt inside the sandbox runtime with network limited to the npm registry, GitHub
 * release-asset hosts and nodejs.org. Session workspaces link `node_modules` to the cache, which
 * the confinement policy makes read-only. The two most recent hashes (plus any in use) are kept.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SafeGitExecutor } from '../../core/SafeGitExecutor.js';
import { removeAttemptTree } from './attemptFs.js';
import { NATIVE_REBUILD_ALLOWLIST, NATIVE_REBUILD_NETWORK, CONFINED_COMMAND_TIMEOUT_MS, buildSandboxRuntimeSettings, confinedEnv } from './executePolicy.js';
import type { ConfinedRunner } from './ConfinedRunner.js';

const execFileAsync = promisify(execFile);

export interface DepsCachePort {
  /** Ensure the cache for `baseSha` exists; returns its directory (holding node_modules). */
  ensure(sourceRepoPath: string, baseSha: string): Promise<{ ok: true; dir: string; hash: string } | { ok: false; reason: string }>;
  /** Evict all but the two most recent caches and any in `inUse`. */
  evict(inUse: Set<string>): number;
  /** Total bytes across caches (for the summary). */
  sizeBytes(): number;
}

export interface DepsCacheOptions {
  root: string;
  agentHome: string;
  trashRoot: string;
  runner: ConfinedRunner;
  /** Read a file at a commit in the trusted checkout (null when absent). */
  readAtCommit?: (sourceRepoPath: string, sha: string, file: string) => string | null;
  /** List files under a path at a commit. */
  listAtCommit?: (sourceRepoPath: string, sha: string, dir: string) => string[];
  /** Run the trusted install (unconfined, base-SHA manifests only, no scripts). */
  install?: (dir: string, tool: 'pnpm' | 'npm') => Promise<void>;
  hasPnpm?: () => boolean;
  testRunnerHoldersFile: string;
}

export function defaultReadAtCommit(sourceRepoPath: string, sha: string, file: string): string | null {
  try { return SafeGitExecutor.readSync(['show', `${sha}:${file}`], { cwd: sourceRepoPath, operation: 'feedback-execute read base manifest', sourceTreeReadOk: true, maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; } // @silent-fallback-ok: an absent manifest at the base SHA is simply not part of the install
}

export function defaultListAtCommit(sourceRepoPath: string, sha: string, dir: string): string[] {
  try {
    return SafeGitExecutor.readSync(['ls-tree', '-r', '--name-only', sha, '--', dir], { cwd: sourceRepoPath, operation: 'feedback-execute list base manifests', sourceTreeReadOk: true })
      .split('\n').filter(Boolean);
  } catch { return []; } // @silent-fallback-ok: no workspace packages at the base SHA
}

export class DepsCache implements DepsCachePort {
  constructor(private readonly opts: DepsCacheOptions) {}

  private read(src: string, sha: string, file: string): string | null { return (this.opts.readAtCommit ?? defaultReadAtCommit)(src, sha, file); }

  async ensure(sourceRepoPath: string, baseSha: string): Promise<{ ok: true; dir: string; hash: string } | { ok: false; reason: string }> {
    const pnpmLock = this.read(sourceRepoPath, baseSha, 'pnpm-lock.yaml');
    const npmLock = this.read(sourceRepoPath, baseSha, 'package-lock.json');
    const pkg = this.read(sourceRepoPath, baseSha, 'package.json');
    if (!pkg || (!pnpmLock && !npmLock)) return { ok: false, reason: 'lockfile-missing-at-base' };
    const tool: 'pnpm' | 'npm' = pnpmLock && (this.opts.hasPnpm ?? defaultHasPnpm)() ? 'pnpm' : 'npm';
    const lock = tool === 'pnpm' ? pnpmLock! : npmLock;
    if (!lock) return { ok: false, reason: 'lockfile-missing-at-base' };
    const hash = createHash('sha256').update(`${tool}\n${process.versions.modules}\n${pkg}\n${lock}`).digest('hex').slice(0, 20);
    const dir = path.join(this.opts.root, hash);
    if (fs.existsSync(path.join(dir, '.ready'))) return { ok: true, dir, hash };
    removeAttemptTree(dir, this.opts.trashRoot, 'feedback-execute discard partial deps cache');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    try {
      // Base-SHA manifests only.
      fs.writeFileSync(path.join(dir, 'package.json'), pkg);
      fs.writeFileSync(path.join(dir, tool === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'), lock);
      for (const extra of ['pnpm-workspace.yaml', '.npmrc']) {
        const text = this.read(sourceRepoPath, baseSha, extra);
        if (text !== null) fs.writeFileSync(path.join(dir, extra), text);
      }
      for (const file of (this.opts.listAtCommit ?? defaultListAtCommit)(sourceRepoPath, baseSha, 'packages')) {
        if (!file.endsWith('/package.json') || file.split('/').includes('..')) continue;
        const text = this.read(sourceRepoPath, baseSha, file);
        if (text === null) continue;
        fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
      }
      await (this.opts.install ?? defaultInstall)(dir, tool);
      await this.buildNatives(dir, sourceRepoPath, baseSha);
      fs.writeFileSync(path.join(dir, '.ready'), JSON.stringify({ hash, tool, builtAt: new Date().toISOString(), nodeAbi: process.versions.modules }));
      return { ok: true, dir, hash };
    } catch (error) {
      try { removeAttemptTree(dir, this.opts.trashRoot, 'feedback-execute discard failed deps cache'); } catch { /* @silent-fallback-ok: the next ensure() discards a partial cache before rebuilding */ }
      return { ok: false, reason: `deps-install-failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}` };
    }
  }

  /** Copy a same-version, same-ABI binary from the agent home; otherwise rebuild confined with a narrow network allowlist. */
  private async buildNatives(dir: string, sourceRepoPath: string, baseSha: string): Promise<void> {
    const needRebuild: string[] = [];
    for (const mod of NATIVE_REBUILD_ALLOWLIST) {
      const cacheMod = path.join(dir, 'node_modules', mod);
      if (!fs.existsSync(cacheMod)) continue;
      const homeMod = path.join(this.opts.agentHome, 'node_modules', mod);
      const version = (p: string) => { try { return (JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')) as { version?: string }).version ?? null; } catch { return null; } };
      const binRel = mod === 'better-sqlite3' ? path.join('build', 'Release', 'better_sqlite3.node') : null;
      if (!binRel) continue; // sqlite-vec ships prebuilt platform packages through the lockfile.
      const homeBin = path.join(homeMod, binRel);
      if (version(homeMod) && version(homeMod) === version(cacheMod) && fs.existsSync(homeBin)) {
        const target = path.join(fs.realpathSync(cacheMod), binRel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(homeBin, target);
        continue;
      }
      needRebuild.push(mod);
    }
    if (needRebuild.length === 0) return;
    const fixScript = this.read(sourceRepoPath, baseSha, 'scripts/fix-better-sqlite3.cjs');
    if (fixScript) {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'fix-better-sqlite3.cjs'), fixScript);
    }
    const tmp = path.join(dir, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const settings = buildSandboxRuntimeSettings({
      workspace: dir, tmpDir: tmp, depsCache: dir, agentHome: this.opts.agentHome, publishClone: path.join(dir, '.no-publish-clone'),
      testRunnerHoldersFile: this.opts.testRunnerHoldersFile,
    }, { network: NATIVE_REBUILD_NETWORK });
    // The cache is the rebuild's own working tree here (it is read-only only to attempt commands).
    settings.filesystem.denyWrite = settings.filesystem.denyWrite.filter((p) => p !== dir);
    const command = `npm rebuild ${needRebuild.join(' ')}${fixScript ? ' && node scripts/fix-better-sqlite3.cjs' : ''}`;
    const result = await this.opts.runner.run({ command, cwd: dir, settings, env: confinedEnv(process.env, { TMPDIR: tmp }), timeoutMs: CONFINED_COMMAND_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error(`native rebuild failed (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''})`);
  }

  evict(inUse: Set<string>): number {
    let entries: Array<{ name: string; mtime: number }> = [];
    try {
      entries = fs.readdirSync(this.opts.root).filter((n) => /^[0-9a-f]{20}$/.test(n)).map((name) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(this.opts.root, name, '.ready')).mtimeMs; } catch { mtime = 0; } // @silent-fallback-ok: an unready cache sorts oldest and is evicted first
        return { name, mtime };
      });
    } catch { return 0; } // @silent-fallback-ok: no cache root yet
    entries.sort((a, b) => b.mtime - a.mtime);
    let removed = 0;
    for (const entry of entries.slice(2)) {
      if (inUse.has(entry.name)) continue;
      removeAttemptTree(path.join(this.opts.root, entry.name), this.opts.trashRoot, 'feedback-execute deps cache eviction');
      removed++;
    }
    return removed;
  }

  sizeBytes(): number {
    let total = 0;
    const stack = [this.opts.root];
    let visited = 0;
    while (stack.length > 0 && visited < 500_000) {
      const current = stack.pop()!;
      let names: string[] = [];
      try { names = fs.readdirSync(current); } catch { continue; } // @silent-fallback-ok: an unreadable directory adds nothing to the reported size
      for (const name of names) {
        visited++;
        const full = path.join(current, name);
        let st: fs.Stats;
        try { st = fs.lstatSync(full); } catch { continue; } // @silent-fallback-ok: vanished between readdir and lstat
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(full); else total += st.size;
      }
    }
    return total;
  }
}

function defaultHasPnpm(): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return dirs.some((d) => { try { fs.accessSync(path.join(d, 'pnpm'), fs.constants.X_OK); return true; } catch { return false; } });
}

async function defaultInstall(dir: string, tool: 'pnpm' | 'npm'): Promise<void> {
  const args = tool === 'pnpm' ? ['install', '--frozen-lockfile', '--ignore-scripts'] : ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  await execFileAsync(tool, args, { cwd: dir, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024, env: confinedEnv(process.env, {}) });
}
