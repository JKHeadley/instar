/**
 * Read-only git for the owned-repository registry (docs/specs/no-data-loss-on-machine-death.md §0, §1.3).
 *
 * Every call goes through SafeGitExecutor.readStream: the one funnel, which refuses any verb or
 * form that is not a read, and audits each call. It is an ASYNC child process (never on the
 * server's main thread) with a timeout and an output cap. `GIT_OPTIONAL_LOCKS=0` so it never takes
 * `.git/index.lock`. Only the inventory's fixed discovery and history queries are admitted.
 * In particular, Git status can run content filters configured by the discovered repository.
 */
import { SafeGitExecutor } from '../../core/SafeGitExecutor.js';

export type GitReadResult = { ok: true; stdout: string } | { ok: false; error: string };
export type GitReader = (cwd: string, args: readonly string[], opts?: { timeoutMs?: number; maxBuffer?: number }) => Promise<GitReadResult>;

const FIXED_QUERIES = [
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  ['remote', '-v'],
  ['ls-files', '--others', '--directory', '-z'],
  ['ls-files', '--others', '--directory', '-z', '--ignored', '--exclude-standard'],
  ['log', '--max-parents=0', '--all', '--format=%H'],
  ['log', '--no-walk', '--branches', '--decorate-refs=refs/heads/', '--format=%H %ct %D'],
];

function inventoryQuery(args: readonly string[]): boolean {
  if (FIXED_QUERIES.some((query) => args.length === query.length && query.every((arg, i) => args[i] === arg))) return true;
  if (args[0] !== 'log' || args[1] !== '--branches' || args.at(-1) !== '--format=%H %ct') return false;
  if (args.length === 3) return true;
  return args.length >= 5 && args[2] === '--not'
    && args.slice(3, -1).every((arg) => /^--remotes=[^\s]+$/u.test(arg));
}

/** The read-only git runner the registry uses. Never throws. */
export const readGit: GitReader = (cwd, args, opts) => new Promise((resolve) => {
  if (!inventoryQuery(args)) {
    resolve({ ok: false, error: 'git query is outside the owned repository inventory' });
    return;
  }
  const command = args[0] === 'log'
    ? ['log', '--no-show-signature', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
    : args;
  const max = opts?.maxBuffer ?? 32 * 1024 * 1024;
  let settled = false;
  const done = (r: GitReadResult) => { if (!settled) { settled = true; resolve(r); } };
  let child;
  try {
    child = SafeGitExecutor.readStream(['--no-pager', '-c', 'core.fsmonitor=false', ...command], {
      cwd,
      operation: 'src/monitoring/ownedRepos/repoGit.ts',
      sourceTreeReadOk: true,
      timeout: opts?.timeoutMs ?? 20_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' },
    });
  } catch (e) {
    done({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    return;
  }
  const out: Buffer[] = [];
  let size = 0;
  let err = '';
  child.stdout?.on('data', (b: Buffer) => {
    size += b.length;
    if (size > max) { child.kill('SIGKILL'); done({ ok: false, error: 'git output over the cap' }); return; }
    out.push(b);
  });
  child.stderr?.on('data', (b: Buffer) => { if (err.length < 2000) err += b.toString('utf8'); });
  child.on('error', (e) => done({ ok: false, error: e.message.slice(0, 200) }));
  child.on('close', (code, signal) => {
    if (code === 0) done({ ok: true, stdout: Buffer.concat(out).toString('utf8') });
    else done({ ok: false, error: (err.split('\n')[0] || `git exited ${code ?? signal}`).slice(0, 200) });
  });
});
