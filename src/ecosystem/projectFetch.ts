/**
 * Fetching a watched project (docs/specs/ecosystem-idea-pipeline.md §3). Trusted code only:
 * a bare, blobless clone outside the agent home, with the executor's hardened git config plus
 * the settings it lacks. There is no worktree, so nothing checks out and no hook or instruction
 * file can load. Every command runs from a neutral scratch directory with --git-dir, so a clone
 * never becomes a working directory. Nothing from a clone is ever executed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { HARDENED_GIT_CONFIG } from '../feedback-factory/execute/executorPorts.js';
import { REPO_NAME_RE, type EvidenceRef, type Maturity } from './types.js';

const execFileAsync = promisify(execFile);

export const CLONE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const CLONE_TIMEOUT_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 60_000;

const GIT_CONFIG: readonly string[] = [
  ...HARDENED_GIT_CONFIG,
  '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
  '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C',
  };
}

export class CloneTooLarge extends Error { constructor() { super('clone over the size cap'); this.name = 'CloneTooLarge'; } }

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    }
  };
  try { walk(dir); } catch { /* @silent-fallback-ok: a file git is still writing; the next poll measures it */ }
  return total;
}

export interface FetchOptions {
  scratchRoot?: string;
  /** Test only, set by test code and never from config: the sole exception to https and GitHub. */
  testOnlyRepoUrl?: (repo: string) => string | null;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface ProjectCheckout {
  dir: string;
  head(): Promise<string>;
  commitExists(commit: string): Promise<boolean>;
  changedFiles(from: string, to: string): Promise<string[]>;
  listFiles(commit: string): Promise<string[]>;
  read(commit: string, file: string, maxChars: number): Promise<{ text: string; truncated: boolean } | null>;
  firstAddedAgeDays(commit: string, file: string, nowMs: number): Promise<number | null>;
  verifyEvidence(commit: string, ref: EvidenceRef): Promise<boolean>;
  remove(): void;
}

export function repoUrl(repo: string, opts: FetchOptions = {}): string {
  const fixture = opts.testOnlyRepoUrl?.(repo);
  if (fixture) return fixture;
  if (!REPO_NAME_RE.test(repo)) throw new Error(`not a repository name: ${repo.slice(0, 80)}`);
  return `https://github.com/${repo}.git`;
}

function configFor(url: string): string[] {
  return url.startsWith('https://') ? [...GIT_CONFIG] : [...GIT_CONFIG, '-c', 'protocol.file.allow=always'];
}

/** The remote HEAD, so "nothing new" is known rather than assumed. */
export async function remoteHead(repo: string, opts: FetchOptions = {}): Promise<string> {
  const url = repoUrl(repo, opts);
  const { stdout } = await execFileAsync('git', [...configFor(url), 'ls-remote', url, 'HEAD'], { env: gitEnv(), cwd: os.tmpdir(), timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  const sha = stdout.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('remote HEAD unreadable');
  return sha;
}

export function runGitNetwork(args: string[], opts: { cwd: string; timeoutMs: number; maxBytes?: number; watchDir?: string; operation: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = SafeGitExecutor.spawn(args, { cwd: opts.cwd, env: gitEnv(), operation: opts.operation, stdio: ['ignore', 'ignore', 'pipe'], timeout: opts.timeoutMs });
    let stderr = '';
    let tooLarge = false;
    child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-400); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    timer.unref?.();
    const size = opts.watchDir && opts.maxBytes ? setInterval(() => {
      if (dirBytes(opts.watchDir!) > opts.maxBytes!) { tooLarge = true; child.kill('SIGKILL'); }
    }, 5_000) : null;
    size?.unref?.();
    child.on('error', (e) => { clearTimeout(timer); if (size) clearInterval(size); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (size) clearInterval(size);
      if (tooLarge) reject(new CloneTooLarge());
      else if (code === 0) resolve();
      else reject(new Error(`git ${args.find((a) => a === 'clone' || a === 'fetch') ?? ''} failed: ${stderr.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240)}`));
    });
  });
}

export async function cloneProject(repo: string, opts: FetchOptions = {}): Promise<ProjectCheckout> {
  const url = repoUrl(repo, opts);
  const root = opts.scratchRoot ?? os.tmpdir();
  const parent = fs.mkdtempSync(path.join(root, 'instar-ecosystem-'));
  const dir = path.join(parent, 'repo.git');
  try {
    await runGitNetwork(
      [...configFor(url), 'clone', '--bare', '--filter=blob:none', '--no-recurse-submodules', '--quiet', url, dir],
      { cwd: parent, timeoutMs: opts.timeoutMs ?? CLONE_TIMEOUT_MS, maxBytes: opts.maxBytes ?? CLONE_MAX_BYTES, watchDir: parent, operation: 'ecosystem-ideas clone project' },
    );
  } catch (error) {
    SafeFsExecutor.safeRmSync(parent, { recursive: true, force: true, operation: 'ecosystem-ideas remove failed clone' });
    throw error;
  }
  const base = [...configFor(url), `--git-dir=${dir}`];
  const git = async (args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> => {
    const { stdout } = await execFileAsync('git', [...base, ...args], { env: gitEnv(), cwd: parent, timeout: READ_TIMEOUT_MS, maxBuffer });
    return stdout;
  };
  return {
    dir,
    head: async () => (await git(['rev-parse', 'HEAD'])).trim(),
    commitExists: async (commit) => {
      try { await git(['cat-file', '-e', `${commit}^{commit}`]); return true; } catch { return false; }
    },
    changedFiles: async (from, to) => (await git(['diff', '--name-only', '--no-renames', '--diff-filter=AMR', from, to])).split('\n').filter(Boolean),
    listFiles: async (commit) => (await git(['ls-tree', '-r', '--name-only', commit])).split('\n').filter(Boolean),
    read: async (commit, file, maxChars) => {
      try {
        const text = await git(['show', `${commit}:${file}`], Math.max(16 * 1024 * 1024, maxChars * 4));
        if (text.includes('\u0000')) return null;
        return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
      } catch { return null; }
    },
    firstAddedAgeDays: async (commit, file, nowMs) => {
      try {
        const out = (await git(['log', '--diff-filter=A', '--format=%at', '-1', commit, '--', file])).trim();
        const at = Number(out) * 1000;
        return Number.isFinite(at) && at > 0 ? Math.max(0, (nowMs - at) / 86_400_000) : null;
      } catch { return null; }
    },
    verifyEvidence: async (commit, ref) => {
      try {
        const text = await git(['show', `${commit}:${ref.path}`]);
        return ref.startLine <= text.split('\n').length;
      } catch { return false; }
    },
    remove: () => SafeFsExecutor.safeRmSync(parent, { recursive: true, force: true, operation: 'ecosystem-ideas remove clone' }),
  };
}

const TEXT_RE = /\.(md|mdx|txt|rst|adoc|ts|tsx|js|mjs|cjs|py|go|rs|swift|java|kt|rb|sh|json|ya?ml|toml)$/i;
const SKIP_RE = /(^|\/)(node_modules|vendor|dist|build|\.git|third_party|__snapshots__|fixtures|assets|locales|i18n)\//i;
const LOCK_RE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock)$/;

/** Baseline order: changelog, then README, then docs. Diff order: same, then code. Reproducible, so a cursor can resume. */
export function orderFiles(files: string[], baseline: boolean): string[] {
  const rank = (f: string): number => {
    const lower = f.toLowerCase();
    const name = lower.split('/').pop() ?? lower;
    if (/^(changelog|addenda|history|news|release)/.test(name) && !lower.includes('/')) return 0;
    if (/^(changelog|addenda|release)/.test(name)) return 1;
    if (/^readme/.test(name) && !lower.includes('/')) return 2;
    if (/^(architecture|design|setup|claude|agents)/.test(name) && /\.mdx?$/.test(name)) return 3;
    if (lower.startsWith('docs/') || lower.startsWith('doc/')) return 4;
    if (/\.mdx?$/.test(name)) return 5;
    return 6;
  };
  return files
    .filter((f) => TEXT_RE.test(f) && !SKIP_RE.test(f) && !LOCK_RE.test(f))
    .filter((f) => !baseline || rank(f) <= 5)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Computed from the project's history and tree, never taken from its own description. */
export async function maturityOf(checkout: ProjectCheckout, commit: string, refs: EvidenceRef[], allFiles: string[], nowMs: number): Promise<{ maturity: Maturity; ageDays: number | null }> {
  const first = refs[0]?.path ?? '';
  const ageDays = first ? await checkout.firstAddedAgeDays(commit, first, nowMs) : null;
  const codeRefs = refs.filter((r) => !/\.(mdx?|txt|rst|adoc)$/i.test(r.path));
  if (codeRefs.length === 0) return { maturity: 'prose-only', ageDays };
  const stems = codeRefs.map((r) => (r.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase()).filter((s) => s.length > 2);
  const tested = allFiles.some((f) => {
    const lower = f.toLowerCase();
    return /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.|_test\./.test(lower) && stems.some((s) => lower.includes(s));
  });
  return { maturity: tested ? 'tested-in-their-code' : 'in-code-untested', ageDays };
}
