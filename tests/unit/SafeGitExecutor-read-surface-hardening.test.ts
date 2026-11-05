// safe-git-allow: this is a test file for SafeGitExecutor; direct git+fs usage is for fixture setup and for checking what git wrote.
/**
 * EVO-029 — docs/specs/safe-git-read-surface-hardening.md.
 *
 * The read surfaces must mean read: nothing the caller passes (arguments, a
 * pre-verb `-c`, `opts.env`) may make git write or run a program. Each case
 * below drives the REAL surface against REAL git in a sandbox repository and
 * then checks that what the form would have written is absent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SafeGitExecutor,
  SafeGitExecutorError,
  classifyGitInvocation,
  READ_SURFACE_CONFIG_ADMITTED,
} from '../../src/core/SafeGitExecutor.js';
import { HARDENED_GIT_CONFIG } from '../../src/feedback-factory/execute/executorPorts.js';
import { GitStateManager } from '../../src/core/GitStateManager.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

function mkdtemp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: sanitizedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '--initial-branch=main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, 'dd.txt'), '--x\n'); // a line `grep -e --` matches
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'y\n');
  git(dir, 'commit', '-q', '-am', 'two');
}

/** Run fn; return the thrown error's message, or null if it did not throw. */
function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

let auditDir: string;
let repo: string;
let bare: string;
const opts = () => ({ cwd: repo, operation: 'test-evo029' });
/** A shell command that creates the named marker file inside the sandbox. */
const touch = (name: string) => `touch ${path.join(repo, name)}`;
const exists = (name: string) => fs.existsSync(path.join(repo, name));

beforeAll(() => {
  auditDir = mkdtemp('evo029-audit-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
});
afterAll(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  rmrf(auditDir);
});
beforeEach(() => {
  repo = mkdtemp('evo029-repo-');
  initRepo(repo);
  bare = mkdtemp('evo029-bare-');
  git(bare, 'init', '-q', '--bare', '--initial-branch=main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main', '--tags');
});
afterEach(() => {
  rmrf(repo);
  rmrf(bare);
});

describe('EVO-029 disconfirmation set: read forms that wrote or ran a program on main', () => {
  it('refuses hash-object -w and writes no blob', () => {
    fs.writeFileSync(path.join(repo, 'h.txt'), 'unique-evo029\n');
    const oid = git(repo, 'hash-object', 'h.txt').trim();
    expect(thrown(() => SafeGitExecutor.readSync(['hash-object', '-w', 'h.txt'], opts()))).toContain('execSync');
    expect(thrown(() => git(repo, 'cat-file', '-e', oid))).not.toBeNull();
  });

  it('refuses write-tree, symbolic-ref with two operands, fsck --lost-found', () => {
    expect(thrown(() => SafeGitExecutor.readSync(['write-tree'], opts()))).toContain('execSync');
    expect(thrown(() => SafeGitExecutor.readSync(['symbolic-ref', 'refs/heads/zz', 'refs/heads/main'], opts()))).toContain('execSync');
    expect(thrown(() => git(repo, 'symbolic-ref', 'refs/heads/zz'))).not.toBeNull();
    expect(thrown(() => SafeGitExecutor.readSync(['fsck', '--lost-found'], opts()))).toContain('execSync');
    expect(fs.existsSync(path.join(repo, '.git', 'lost-found'))).toBe(false);
  });

  it('refuses --output on log, show, diff and reflog show, and writes no file', () => {
    for (const args of [
      ['log', '-1', '--output=o1.txt'],
      ['show', '--output=o2.txt'],
      ['diff', 'HEAD~1', '--output=o3.txt'],
      ['reflog', 'show', '--output=o4.txt'],
      ['log', '-1', '--outp=o5.txt'],
    ]) {
      expect({ args, err: thrown(() => SafeGitExecutor.readSync(args, opts())) }).toMatchObject({ err: expect.stringContaining('execSync') });
    }
    for (const f of ['o1.txt', 'o2.txt', 'o3.txt', 'o4.txt', 'o5.txt']) expect(exists(f)).toBe(false);
  });

  it('refuses format-patch without --stdout, including when --stdout is a value or a path', () => {
    for (const args of [
      ['-1'],
      ['--subject-prefix', '--stdout', 'HEAD~1'],
      ['HEAD~1', '--', '--stdout'],
      ['-1', '--stdout', '-o', 'out'],
    ]) {
      expect({ args, got: classifyGitInvocation('format-patch', args) }).toEqual({ args, got: 'write' });
      expect(thrown(() => SafeGitExecutor.readSync(['format-patch', ...args], opts()))).not.toBeNull();
    }
    expect(fs.readdirSync(repo).filter((f) => f.endsWith('.patch'))).toEqual([]);
  });

  it('refuses interpret-trailers --in-place and its abbreviation, file unchanged', () => {
    fs.writeFileSync(path.join(repo, 'msg'), 'subject\n');
    for (const flag of ['--in-place', '--in-pl']) {
      expect(thrown(() => SafeGitExecutor.readSync(['interpret-trailers', flag, '--trailer', 'A: b', 'msg'], opts()))).toContain('execSync');
    }
    expect(fs.readFileSync(path.join(repo, 'msg'), 'utf-8')).toBe('subject\n');
  });

  it('refuses remote -v add and config k --list, nothing written', () => {
    expect(thrown(() => SafeGitExecutor.readSync(['remote', '-v', 'add', 'evil', 'http://x'], opts()))).toContain('execSync');
    expect(git(repo, 'remote').trim()).toBe('origin');
    expect(thrown(() => SafeGitExecutor.readSync(['config', 'probe.key', '--list'], opts()))).toContain('execSync');
    expect(thrown(() => SafeGitExecutor.readSync(['config', '--fil', '--get', 'pwn.key', 'evil'], opts()))).toContain('execSync');
    expect(thrown(() => git(repo, 'config', '--get', 'probe.key'))).not.toBeNull();
    expect(exists('--get')).toBe(false);
  });

  it('refuses branch write forms that the old check called read', () => {
    git(repo, 'branch', '--set-upstream-to=origin/main');
    for (const args of [
      ['--unset-up'],
      ['-uzz9'],
      ['--format', '--list', 'newb'],
      ['--sort', '-l', 'newc'],
      ['-vd', 'x'],
      ['-l', 'newd'],
    ]) {
      expect({ args, got: classifyGitInvocation('branch', args) }).toEqual({ args, got: 'write' });
      expect(thrown(() => SafeGitExecutor.readSync(['branch', ...args], opts()))).not.toBeNull();
    }
    expect(git(repo, 'config', '--get', 'branch.main.merge').trim()).toBe('refs/heads/main');
    expect(git(repo, 'branch', '--list', 'new*').trim()).toBe('');
  });

  it('refuses the program-running forms on every surface and runs nothing', () => {
    const cases: string[][] = [
      ['grep', `-O${touch('m-grep')}`, 'x'],
      ['grep', '-e', '--', `-O${touch('m-grep2')}`],
      ['ls-remote', `--upload-pack=${touch('m-up')}; false`, bare],
      ['ls-remote', `--exec=${touch('m-exec')}; false`, bare],
      ['ls-remote', '-o', '--', `--upload-pack=${touch('m-o')}; false`, bare],
      ['help', 'commit'],
      ['config', '--edit'],
      ['config', '-ze'],
      ['branch', '--edit-desc'],
    ];
    for (const args of cases) {
      for (const surface of ['readSync', 'readStream', 'execSync', 'spawn', 'run'] as const) {
        const msg = thrown(() => (SafeGitExecutor[surface] as (a: string[], o: unknown) => unknown)(args, opts()));
        expect({ args, surface, msg }).toMatchObject({ msg: expect.stringContaining('refused on every surface') });
      }
    }
    for (const m of ['m-grep', 'm-grep2', 'm-up', 'm-exec', 'm-o']) expect(exists(m)).toBe(false);
  });

  it('refuses a -c that names a program, and a caller env that names one', () => {
    expect(thrown(() => SafeGitExecutor.readSync(['-c', `core.fsmonitor=${touch('m-fsm')}; false`, 'status'], opts()))).toContain('-c core.fsmonitor=');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'changed\n');
    expect(
      thrown(() => SafeGitExecutor.readSync(['diff'], { ...opts(), env: { ...process.env, GIT_EXTERNAL_DIFF: `sh -c '${touch('m-ext')}'` } })),
    ).toContain('env GIT_EXTERNAL_DIFF');
    expect(exists('m-fsm')).toBe(false);
    expect(exists('m-ext')).toBe(false);
  });
});

describe('EVO-029: read forms callers use still run', () => {
  it('runs the read forms through readSync', () => {
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    const reads: string[][] = [
      ['symbolic-ref', '--short', 'HEAD'],
      ['symbolic-ref', 'HEAD'],
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      ['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      ['remote'],
      ['remote', '-v'],
      ['remote', 'get-url', 'origin'],
      ['config', '--get', 'user.name'],
      ['config', '--get-regexp', '^user\\.'],
      ['config', 'get', 'user.name'],
      ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
      ['ls-remote', '--tags', 'origin', 'refs/tags/v*'],
      ['format-patch', '-1', '--stdout'],
      ['log', '-1', '--output-indicator-new=+'],
      ['grep', '-n', '-e', 'x'],
      ['grep', '-m1', 'x'],
      ['stash', 'list', '-1'],
      ['branch', '--list', 'ma*'],
      ['branch', '--show-current'],
      ['hash-object', 'f.txt'],
      ['fsck', '--full'],
      ['help', '-a'],
    ];
    for (const args of reads) {
      const err = thrown(() => SafeGitExecutor.readSync(args, opts()));
      // ls-remote --tags with no tags exits 0; --exit-code with a match exits 0.
      expect({ args, err }).toEqual({ args, err: null });
    }
  });

  it('admits every HARDENED_GIT_CONFIG pair and nothing broader', () => {
    const pairs: string[] = [];
    for (let i = 0; i < HARDENED_GIT_CONFIG.length; i += 2) {
      expect(HARDENED_GIT_CONFIG[i]).toBe('-c');
      pairs.push(HARDENED_GIT_CONFIG[i + 1]);
    }
    for (const p of pairs) expect(READ_SURFACE_CONFIG_ADMITTED.has(p)).toBe(true);
    expect(READ_SURFACE_CONFIG_ADMITTED.size).toBe(pairs.length);
    expect(thrown(() => SafeGitExecutor.readSync([...HARDENED_GIT_CONFIG, 'rev-parse', 'HEAD'], opts()))).toBeNull();
    const child = SafeGitExecutor.readStream([...HARDENED_GIT_CONFIG, 'rev-parse', 'HEAD'], opts());
    child.kill();
  });

  it('refuses -c values outside the list by key, never echoing the value', () => {
    for (const pair of ['core.fsmonitor=secretcmd', 'Core.FsMonitor=false', 'core.fsmonitor', 'protocol.file.allow=always', 'user.name=x']) {
      const msg = thrown(() => SafeGitExecutor.readSync(['-c', pair, 'status'], opts()));
      expect(msg).toContain('is not admitted on a read surface');
      expect(msg).not.toContain('secretcmd');
      // The write surfaces keep accepting any -c.
    }
    expect(thrown(() => SafeGitExecutor.execSync(['-c', 'user.name=x', 'commit', '--allow-empty', '-q', '-m', 'w'], opts()))).toBeNull();
  });

  it('judges only the env keys a caller adds or changes', () => {
    expect(thrown(() => SafeGitExecutor.readSync(['status'], { ...opts(), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }))).toBeNull();
    for (const key of ['HOME', 'PATH', 'GIT_TRACE', 'GIT_EXTERNAL_DIFF']) {
      const env = { ...process.env, [key]: path.join(repo, 'elsewhere') };
      expect({ key, msg: thrown(() => SafeGitExecutor.readSync(['status'], { ...opts(), env })) }).toMatchObject({
        msg: expect.stringContaining(`env ${key} is not admitted`),
      });
    }
    expect(exists('elsewhere')).toBe(false);
  });
});

describe('EVO-029: classification details', () => {
  it('scans past -- for --output and consumes values whatever they look like', () => {
    expect(classifyGitInvocation('log', ['--', '--output'])).toBe('write');
    expect(classifyGitInvocation('grep', ['-e', 'x', '--', 'file'])).toBe('read');
    expect(classifyGitInvocation('grep', ['-e', '--', '-O'])).toBe('refused');
    expect(classifyGitInvocation('grep', ['--open'])).toBe('refused');
  });

  it('does not admit abbreviations of write options', () => {
    expect(classifyGitInvocation('symbolic-ref', ['--del', 'HEAD'])).toBe('write');
    expect(classifyGitInvocation('fsck', ['--lost'])).toBe('write');
    expect(classifyGitInvocation('config', ['--unse', 'x'])).toBe('write');
    expect(classifyGitInvocation('ls-remote', ['--upload', 'x'])).toBe('refused');
    expect(classifyGitInvocation('ls-remote', ['--exe', 'x'])).toBe('refused');
  });

  it('routes run on the verb past pre-verb flags', () => {
    const head = () => git(repo, 'rev-parse', 'HEAD');
    const before = head();
    SafeGitExecutor.run(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'm'], opts());
    expect(head()).not.toBe(before);
    expect(thrown(() => SafeGitExecutor.run(['-C', repo, 'status'], opts()))).toBeNull();
    // A -C directory spelled like a verb no longer moves the cut.
    const statusDir = path.join(repo, 'status');
    fs.mkdirSync(statusDir);
    expect(thrown(() => SafeGitExecutor.run(['-C', 'status', 'log', '-1'], opts()))).toBeNull();
    expect(thrown(() => SafeGitExecutor.run(['branch', '--list', 'x*'], opts()))).toBeNull();
    expect(thrown(() => SafeGitExecutor.run(['--frobnicate', 'status'], opts()))).toContain('unrecognized pre-verb flag');
  });

  it('resolves relative -C, --git-dir and --work-tree the way git does', async () => {
    const { _internal } = await import('../../src/core/SafeGitExecutor.js');
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    const t1 = _internal.extractVerbAndTargets(['-C', 'a', '-C', 'b', 'status'], repo).targets;
    expect(t1).toContain(path.join(repo, 'a', 'b'));
    // git applies every -C before a relative --git-dir, wherever it sits.
    const t2 = _internal.extractVerbAndTargets(['--git-dir=x/.git', '-C', 'a', 'status'], repo).targets;
    expect(t2).toContain(path.join(repo, 'a', 'x', '.git'));
    const t3 = _internal.extractVerbAndTargets(['--work-tree', 'w', '-C', 'a', 'status'], repo).targets;
    expect(t3).toContain(path.join(repo, 'a', 'w'));
  });

  it('refuses everything run would send on to a surface with the same refusal', () => {
    const msg = thrown(() => SafeGitExecutor.run(['grep', '-Oless', 'x'], opts()));
    expect(msg).toContain('refused on every surface');
    expect(() => SafeGitExecutor.run(['grep', '-Oless', 'x'], opts())).toThrow(SafeGitExecutorError);
  });
});

// Long options git 2.50.1 prints in `git <verb> -h`, reviewed for options that
// write or run a program (docs/specs/safe-git-read-surface-hardening.md, section 4).
// A newer git that adds an option fails here and names it: review it against the
// manual page, then add it here or add a refusal (spec decision 14).
const REVIEWED_READ_OPTIONS: Record<string, string[]> = {
  'status': ['--ahead-behind', '--branch', '--column', '--find-renames', '--ignore-submodules', '--ignored', '--long', '--no-renames', '--null', '--porcelain', '--renames', '--short', '--show-stash', '--untracked-files', '--verbose'],
  'ls-files': ['--abbrev', '--cached', '--debug', '--deduplicate', '--deleted', '--directory', '--empty-directory', '--eol', '--error-unmatch', '--exclude', '--exclude-from', '--exclude-per-directory', '--exclude-standard', '--format', '--full-name', '--ignored', '--killed', '--modified', '--others', '--recurse-submodules', '--resolve-undo', '--sparse', '--stage', '--unmerged', '--with-tree'],
  'ls-tree': ['--abbrev', '--format', '--full-name', '--full-tree', '--long', '--name-only', '--name-status', '--object-only'],
  // --textconv and --filters run programs named by repository config: the config boundary (section 4).
  'cat-file': ['--batch', '--batch-all-objects', '--batch-check', '--batch-command', '--buffer', '--filter', '--filters', '--follow-symlinks', '--mailmap', '--path', '--textconv', '--unordered', '--use-mailmap'],
  'check-ignore': ['--index', '--no-index', '--non-matching', '--quiet', '--stdin', '--verbose'],
  'show-ref': ['--abbrev', '--branches', '--dereference', '--exclude-existing', '--exists', '--hash', '--head', '--quiet', '--tags', '--verify'],
  'for-each-ref': ['--color', '--contains', '--count', '--exclude', '--format', '--ignore-case', '--include-root-refs', '--merged', '--no-contains', '--no-merged', '--omit-empty', '--perl', '--points-at', '--python', '--shell', '--sort', '--stdin', '--tcl'],
  'merge-base': ['--all', '--fork-point', '--independent', '--is-ancestor', '--octopus'],
  'blame': ['--abbrev', '--color-by-age', '--color-lines', '--contents', '--ignore-rev', '--ignore-revs-file', '--incremental', '--line-porcelain', '--minimal', '--porcelain', '--progress', '--root', '--score-debug', '--show-email', '--show-name', '--show-number', '--show-stats'],
  'shortlog': ['--committer', '--email', '--group', '--numbered', '--pretty', '--summary'],
  'count-objects': ['--human-readable', '--verbose'],
  'describe': ['--abbrev', '--all', '--always', '--broken', '--candidates', '--contains', '--debug', '--dirty', '--exact-match', '--exclude', '--first-parent', '--long', '--match', '--tags'],
  'name-rev': ['--all', '--always', '--annotate-stdin', '--exclude', '--name-only', '--refs', '--tags', '--undefined'],
  'check-ref-format': ['--branch', '--normalize'],
  'cherry': ['--abbrev', '--verbose'],
};

describe('EVO-029 canary: git-version drift on the parse-options read verbs', () => {
  it('finds no long option that was not reviewed', () => {
    const unreviewed: string[] = [];
    for (const [verb, reviewed] of Object.entries(REVIEWED_READ_OPTIONS)) {
      let help = '';
      try {
        help = execFileSync('git', [verb, '-h'], { encoding: 'utf-8', env: sanitizedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        // `git <verb> -h` exits 129 and prints usage on stdout.
        help = String((err as { stdout?: string }).stdout ?? '');
      }
      expect({ verb, printedUsage: help.length > 0 }).toEqual({ verb, printedUsage: true });
      const seen = new Set((help.match(/--(\[no-\])?[a-z][a-z0-9-]*/g) ?? []).map((o) => o.replace('[no-]', '')));
      for (const opt of seen) if (!reviewed.includes(opt)) unreviewed.push(`git ${verb} ${opt}`);
    }
    expect(unreviewed).toEqual([]);
  });
});

describe('EVO-029: the never-run update-index call is gone', () => {
  it('still counts a file modified in the same second as the last commit', () => {
    // GitStateManager runs git in its state dir; the sandbox repo stands in for one.
    fs.writeFileSync(path.join(repo, 'f.txt'), 'z\n'); // same length as "y\n", same second
    const mgr = new GitStateManager(repo);
    const status = mgr.status();
    expect(status.modified).toBeGreaterThanOrEqual(1);
  });
});
