// safe-git-allow: this is the test file for SafeGitExecutor; direct git+fs usage is for fixture setup only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SafeGitExecutor,
  SafeGitExecutorError,
  DESTRUCTIVE_GIT_VERBS,
  READONLY_GIT_VERBS,
  _internal,
} from '../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError } from '../../src/core/SourceTreeGuard.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

// ── fixture helpers ───────────────────────────────────────────────

function mkSandbox(prefix = 'sge-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function initRepo(dir: string): void {
  // env: sanitizedGitEnv() drops GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
  // so a pre-push-triggered test run can't redirect these git ops into
  // the parent repo. vitest-setup strips them globally; this is belt-and-
  // suspenders.
  const env = sanitizedGitEnv();
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore', env });
  fs.writeFileSync(path.join(dir, 'seed'), 'seed');
  execFileSync('git', ['add', 'seed'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'ignore', env });
}

function makeFakeInstarSource(): string {
  // A sandbox with the marker file → assertNotInstarSourceTree returns true (layer a).
  const dir = mkSandbox('sge-fake-instar-');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, '.instar-source-tree'), 'marker');
  return dir;
}

// Disable real audit log writes during tests; use a tmp dir.
let auditDir: string;
beforeAll(() => {
  auditDir = mkSandbox('sge-audit-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
});
afterAll(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  rmrf(auditDir);
});

// ── execSync ──────────────────────────────────────────────────────

describe('SafeGitExecutor.execSync — source-tree guard', () => {
  let fakeInstar: string;
  let benignSandbox: string;
  beforeEach(() => {
    fakeInstar = makeFakeInstarSource();
    benignSandbox = mkSandbox();
    initRepo(benignSandbox);
  });
  afterEach(() => {
    rmrf(fakeInstar);
    rmrf(benignSandbox);
  });

  it('throws SourceTreeGuardError when cwd is the instar source', () => {
    expect(() =>
      SafeGitExecutor.execSync(['add', '-A'], { cwd: fakeInstar, operation: 'test' }),
    ).toThrow(SourceTreeGuardError);
  });

  it('succeeds when cwd is a benign tmpdir', () => {
    fs.writeFileSync(path.join(benignSandbox, 'newfile'), 'x');
    expect(() =>
      SafeGitExecutor.execSync(['add', '-A'], { cwd: benignSandbox, operation: 'test' }),
    ).not.toThrow();
  });

  it('blocks bypass via -C <instar source> while opts.cwd is benign', () => {
    expect(() =>
      SafeGitExecutor.execSync(['-C', fakeInstar, 'add', '-A'], {
        cwd: benignSandbox,
        operation: 'test-bypass',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass when opts.cwd is the instar source even with -C tmpdir', () => {
    expect(() =>
      SafeGitExecutor.execSync(['-C', benignSandbox, 'add', '-A'], {
        cwd: fakeInstar,
        operation: 'test-bypass-2',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass via --git-dir=<instar>/.git', () => {
    const gitDir = path.join(fakeInstar, '.git');
    expect(() =>
      SafeGitExecutor.execSync([`--git-dir=${gitDir}`, 'add', '-A'], {
        cwd: benignSandbox,
        operation: 'test-git-dir-bypass',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass via --work-tree=<instar>', () => {
    expect(() =>
      SafeGitExecutor.execSync([`--work-tree=${fakeInstar}`, 'add', '-A'], {
        cwd: benignSandbox,
        operation: 'test-work-tree-bypass',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('blocks bypass via symlink to the instar source', () => {
    const linkParent = mkSandbox();
    const link = path.join(linkParent, 'shadow');
    fs.symlinkSync(fakeInstar, link);
    try {
      expect(() =>
        SafeGitExecutor.execSync(['-C', link, 'add', '-A'], {
          cwd: benignSandbox,
          operation: 'test-symlink-bypass',
        }),
      ).toThrow(SourceTreeGuardError);
    } finally {
      rmrf(linkParent);
    }
  });

  it('throws on read-only verb (typo / wrong-method protection)', () => {
    expect(() =>
      SafeGitExecutor.execSync(['status'], { cwd: benignSandbox, operation: 'wrong-method' }),
    ).toThrow(SafeGitExecutorError);
  });

  it('throws on ambiguous verb in read-only shape', () => {
    expect(() =>
      SafeGitExecutor.execSync(['branch', '--list'], {
        cwd: benignSandbox,
        operation: 'wrong-method-2',
      }),
    ).toThrow(SafeGitExecutorError);
  });

  it('accepts ambiguous verb in destructive shape (branch <name>)', () => {
    expect(() =>
      SafeGitExecutor.execSync(['branch', 'newbranch'], {
        cwd: benignSandbox,
        operation: 'create-branch',
      }),
    ).not.toThrow();
  });
});

describe('SafeGitExecutor.readStream — read-only funnel', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox('sge-read-stream-');
    initRepo(sandbox);
  });
  afterEach(() => rmrf(sandbox));

  it('streams stdout for a classified read-only verb', async () => {
    const child = SafeGitExecutor.readStream(['ls-tree', '-r', '-z', 'HEAD'], {
      cwd: sandbox,
      operation: 'test-read-stream',
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    expect(stdout).toContain('\tseed\0');
  });

  it('rejects a destructive verb before spawn', () => {
    expect(() => SafeGitExecutor.readStream(['reset', '--hard'], {
      cwd: sandbox,
      operation: 'test-read-stream-block',
    })).toThrow(SafeGitExecutorError);
  });

  it('kills a hung read-only stream at the requested timeout', async () => {
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    const fakeGit = path.join(bin, 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\nexec sleep 60\n');
    fs.chmodSync(fakeGit, 0o755);
    const child = SafeGitExecutor.readStream(['ls-tree', '-z', 'HEAD'], {
      cwd: sandbox,
      operation: 'test-read-stream-timeout',
      timeout: 25,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_code, sig) => resolve(sig));
    });
    expect(signal).toBe('SIGKILL');
  });
});

// ── readAsync ─────────────────────────────────────────────────────

/**
 * Tier 1 — the async read path's AUDIT PARITY and WALL-CLOCK BOUND.
 *
 * WHY THESE EXIST. Round-two review found that the worktree reaper's converted
 * read path consumed `readStream`, which hands back a live child: the funnel
 * emitted `allowed` at spawn and never learned how the read ENDED. A failed read
 * — the kind that gates an IRREVERSIBLE worktree delete — was recorded as
 * `allowed` with NO failure row, while `readSync` records
 * `denied: subprocess-error`. The spec claimed the two paths audit identically.
 * These tests are what make that claim checkable rather than asserted.
 *
 * Both are DISCRIMINATING: verified by reverting the fix and watching them fail
 * (the audit case reports no denied row; the wall-clock case never settles and
 * times out). That check is the point — the adversarial reviewer showed that
 * seven of nine earlier fixes on this branch could be reverted with the whole
 * suite still green.
 */
describe('SafeGitExecutor.readAsync — non-blocking read with audit parity', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox('sge-read-async-');
    initRepo(sandbox);
  });
  afterEach(() => rmrf(sandbox));

  const auditRows = (): Array<Record<string, unknown>> => {
    const f = path.join(auditDir, 'destructive-ops.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('resolves with full stdout on a clean read', async () => {
    const out = await SafeGitExecutor.readAsync(['ls-tree', '-r', '-z', 'HEAD'], {
      cwd: sandbox,
      operation: 'test-read-async',
    });
    expect(out).toContain('\tseed\0');
  });

  it('rejects a destructive verb before spawn, with the same denied row as readSync', () => {
    const before = auditRows().length;
    expect(() => SafeGitExecutor.readAsync(['reset', '--hard'], {
      cwd: sandbox,
      operation: 'test-read-async-block',
    })).toThrow(SafeGitExecutorError);
    const added = auditRows().slice(before);
    expect(added.some((r) => r.outcome === 'denied'
      && String(r.reason ?? '').includes('destructive-verb-via-readAsync'))).toBe(true);
  });

  it('AUDITS A FAILED READ as denied — the row readStream could not emit', async () => {
    // A read-only verb against a path that is not a repo: git exits non-zero. The
    // blocking path records `denied: subprocess-error`; before this fix the async
    // path recorded only the spawn-time `allowed` and NOTHING about the failure.
    const notARepo = mkSandbox('sge-read-async-norepo-');
    try {
      const before = auditRows().length;
      await expect(SafeGitExecutor.readAsync(['rev-parse', '--verify', 'HEAD'], {
        cwd: notARepo,
        operation: 'test-read-async-failure-audit',
      })).rejects.toThrow();
      const added = auditRows().slice(before)
        .filter((r) => r.operation === 'test-read-async-failure-audit');
      expect(added.some((r) => r.outcome === 'denied'
        && String(r.reason ?? '').startsWith('subprocess-error:'))).toBe(true);
      // And it must NOT also claim the read was allowed — that is the misleading
      // row the old path left behind.
      expect(added.some((r) => r.outcome === 'allowed' && r.reason === undefined)).toBe(false);
    } finally {
      rmrf(notARepo);
    }
  });

  it("the failure row carries GIT'S OWN reason, not just the exit code", async () => {
    // Round-four precision finding: the async failure row existed (that was the
    // round-three fix) but recorded only `exited 128`, while the blocking path
    // records git's own `fatal: …`. On a read that gates an irreversible delete,
    // "it failed" without "why" is a materially weaker trail — and the spec
    // claimed the two paths emit the same evidence.
    const notARepo = mkSandbox('sge-read-async-stderr-');
    try {
      const before = auditRows().length;
      await expect(SafeGitExecutor.readAsync(['rev-parse', '--verify', 'no-such-ref'], {
        cwd: notARepo,
        operation: 'test-read-async-stderr-detail',
      })).rejects.toThrow();
      const row = auditRows().slice(before)
        .find((r) => r.operation === 'test-read-async-stderr-detail' && r.outcome === 'denied');
      expect(row).toBeDefined();
      // Not merely the exit code: git's own explanation is present.
      expect(String(row!.reason ?? '')).toMatch(/fatal:|not a git repository/i);
    } finally {
      rmrf(notARepo);
    }
  });

  it('rejects rather than truncates when output exceeds maxBuffer', async () => {
    // A truncated `git status --porcelain` reads as CLEAN, which would authorise a
    // delete — so the bound must reject, never truncate.
    await expect(SafeGitExecutor.readAsync(['ls-tree', '-r', '-z', 'HEAD'], {
      cwd: sandbox,
      operation: 'test-read-async-maxbuffer',
      maxBuffer: 4,
    })).rejects.toThrow(/exceeded 4 bytes/);
  });

  it('SETTLES when the child exits but a grandchild holds stdout open', async () => {
    // THE WEDGE, reproduced — and it IS reproducible under the test runner.
    // The fake git backgrounds a sleeper that inherits stdout, then exits 0. The
    // child is gone, but `close` waits for every stdio pipe to close, so it never
    // fires and only the independent wall-clock bound settles this promise.
    //
    // ROUND-FOUR CORRECTION. An earlier version of this test was DELETED on the
    // stated grounds that the wedge "does not reproduce under the test runner,
    // where `close` still fires". That diagnosis was wrong, and the wrong lesson
    // went into the spec as durable methodology. The real defect was the deleted
    // test's own LOOSE assertion (`/exited|wall-clock bound/`), which passed on
    // either branch. The assertion below names ONLY the deadline, which is what
    // makes it discriminate: with the timer removed this times out instead.
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    const fakeGit = path.join(bin, 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\nsleep 120 &\nexit 0\n');
    fs.chmodSync(fakeGit, 0o755);
    await expect(SafeGitExecutor.readAsync(['ls-tree', '-z', 'HEAD'], {
      cwd: sandbox,
      operation: 'test-read-async-wallclock',
      timeout: 1_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })).rejects.toThrow(/exceeded wall-clock bound/);
  }, 30_000);

  it('CONTROL: a child killed at its own timeout rejects with the exit-code message', async () => {
    // NOT evidence for the wall-clock bound — a CONTROL, and now a TIGHT one. Here
    // git itself is the sleeper, so the child-level SIGKILL closes the pipes and
    // `close` fires; the deadline never runs. Asserting the exit-code message
    // (rather than a disjunction that accepts either) is what keeps this test
    // honest about which mechanism it is exercising.
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    const fakeGit = path.join(bin, 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\nexec sleep 120\n');
    fs.chmodSync(fakeGit, 0o755);
    await expect(SafeGitExecutor.readAsync(['ls-tree', '-z', 'HEAD'], {
      cwd: sandbox,
      operation: 'test-read-async-killed',
      timeout: 20,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })).rejects.toThrow(/exited null \(SIGKILL\)/);
  }, 20_000);
});

// ── env handling ──────────────────────────────────────────────────

describe('SafeGitExecutor — env denylist', () => {
  it('strips GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / etc from caller env', () => {
    const sanitized = _internal.sanitizeEnv({
      GIT_DIR: '/evil',
      GIT_WORK_TREE: '/evil',
      GIT_INDEX_FILE: '/evil',
      GIT_OBJECT_DIRECTORY: '/evil',
      GIT_CONFIG_PARAMETERS: 'evil',
      GIT_CEILING_DIRECTORIES: '/',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      GIT_NAMESPACE: 'evil',
      GIT_COMMON_DIR: '/evil',
      GIT_CONFIG_KEY_0: 'core.editor',
      GIT_CONFIG_VALUE_0: 'rm -rf /',
      GIT_CONFIG_COUNT: '1',
      KEEP_ME: 'safe',
    });
    expect(sanitized.GIT_DIR).toBeUndefined();
    expect(sanitized.GIT_WORK_TREE).toBeUndefined();
    expect(sanitized.GIT_INDEX_FILE).toBeUndefined();
    expect(sanitized.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(sanitized.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(sanitized.GIT_CEILING_DIRECTORIES).toBeUndefined();
    expect(sanitized.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBeUndefined();
    expect(sanitized.GIT_NAMESPACE).toBeUndefined();
    expect(sanitized.GIT_COMMON_DIR).toBeUndefined();
    expect(sanitized.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(sanitized.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(sanitized.GIT_CONFIG_COUNT).toBeUndefined();
    expect(sanitized.KEEP_ME).toBe('safe');
  });

  it('injects GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_SYSTEM=/dev/null + GIT_CONFIG_NOSYSTEM=1', () => {
    const sanitized = _internal.sanitizeEnv({});
    expect(sanitized.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(sanitized.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(sanitized.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('the injected GIT_CONFIG_GLOBAL beats caller-supplied values', () => {
    const sanitized = _internal.sanitizeEnv({
      GIT_CONFIG_GLOBAL: '/tmp/evil',
      GIT_CONFIG_SYSTEM: '/tmp/evil',
    });
    expect(sanitized.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(sanitized.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });
});

// ── per-agent identity isolation (Phase-3 Inc-P3a) ────────────────
//
// The Caroline-class gap 1 fix: a repo with its OWN local user.name +
// user.email (every agent worktree/home) is authoritative — inherited
// GIT_AUTHOR_*/GIT_COMMITTER_* env vars from the spawning shell must NOT
// override it inside the funnel. Repos WITHOUT local identity keep the
// long-standing host-identity fallback so non-agent installs don't break.

describe('SafeGitExecutor — per-agent identity isolation (Inc-P3a)', () => {
  let agentRepo: string; // local identity set (initRepo does this)
  let bareIdentityRepo: string; // git repo, NO local identity
  let notARepo: string;
  beforeEach(() => {
    _internal._resetLocalIdentityCacheForTest();
    agentRepo = mkSandbox('sge-agent-');
    initRepo(agentRepo);
    bareIdentityRepo = mkSandbox('sge-noident-');
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: bareIdentityRepo, stdio: 'ignore', env: sanitizedGitEnv(),
    });
    notARepo = mkSandbox('sge-norepo-');
  });
  afterEach(() => {
    _internal._resetLocalIdentityCacheForTest();
    rmrf(agentRepo);
    rmrf(bareIdentityRepo);
    rmrf(notARepo);
  });

  it('repoHasLocalIdentity: true for a repo with local user.name+email, false otherwise', () => {
    expect(_internal.repoHasLocalIdentity(agentRepo)).toBe(true);
    expect(_internal.repoHasLocalIdentity(bareIdentityRepo)).toBe(false);
    expect(_internal.repoHasLocalIdentity(notARepo)).toBe(false);
  });

  it('strips inherited GIT_AUTHOR_*/GIT_COMMITTER_* when the target repo has a local identity', () => {
    const sanitized = _internal.sanitizeEnv(
      {
        GIT_AUTHOR_NAME: 'Caroline',
        GIT_AUTHOR_EMAIL: 'caroline@other.example',
        GIT_COMMITTER_NAME: 'Caroline',
        GIT_COMMITTER_EMAIL: 'caroline@other.example',
      },
      agentRepo,
    );
    expect(sanitized.GIT_AUTHOR_NAME).toBeUndefined();
    expect(sanitized.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(sanitized.GIT_COMMITTER_NAME).toBeUndefined();
    expect(sanitized.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it('preserves caller identity env vars when the target repo has NO local identity (legacy fallback)', () => {
    const sanitized = _internal.sanitizeEnv(
      { GIT_AUTHOR_NAME: 'Host Person', GIT_AUTHOR_EMAIL: 'host@example.com' },
      bareIdentityRepo,
    );
    // Current (pre-P3a) behavior must be unchanged on this side of the
    // boundary: supplied identity is retained so commits still work with
    // global config neutralized to /dev/null.
    expect(sanitized.GIT_AUTHOR_NAME).toBe('Host Person');
    expect(sanitized.GIT_AUTHOR_EMAIL).toBe('host@example.com');
  });

  it('CAROLINE REPLAY: a commit through the funnel with a polluted env lands as the repo-local agent identity', () => {
    // The exact incident shape: the spawning shell exports another
    // principal's identity; the agent's repo has its own local identity.
    fs.writeFileSync(path.join(agentRepo, 'work.txt'), 'phase-3');
    execFileSync('git', ['add', 'work.txt'], { cwd: agentRepo, stdio: 'ignore', env: sanitizedGitEnv() });
    SafeGitExecutor.execSync(['commit', '-m', 'agent work'], {
      cwd: agentRepo,
      operation: 'inc-p3a-test-commit',
      env: {
        GIT_AUTHOR_NAME: 'Caroline',
        GIT_AUTHOR_EMAIL: 'caroline@other.example',
        GIT_COMMITTER_NAME: 'Caroline',
        GIT_COMMITTER_EMAIL: 'caroline@other.example',
      },
    });
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: agentRepo, encoding: 'utf-8', env: sanitizedGitEnv(),
    }).trim();
    const committer = execFileSync('git', ['log', '-1', '--format=%cn <%ce>'], {
      cwd: agentRepo, encoding: 'utf-8', env: sanitizedGitEnv(),
    }).trim();
    // initRepo sets the local identity to T <t@t.com> — the agent identity.
    expect(author).toBe('T <t@t.com>');
    expect(committer).toBe('T <t@t.com>');
    expect(author).not.toContain('Caroline');
  });

  it('local-identity verdict is cached per directory and resettable for tests', () => {
    expect(_internal.repoHasLocalIdentity(bareIdentityRepo)).toBe(false);
    // Add local identity AFTER the first (cached) read — stale verdict holds…
    execFileSync('git', ['config', 'user.name', 'Late Agent'], { cwd: bareIdentityRepo, stdio: 'ignore', env: sanitizedGitEnv() });
    execFileSync('git', ['config', 'user.email', 'late@instar.local'], { cwd: bareIdentityRepo, stdio: 'ignore', env: sanitizedGitEnv() });
    expect(_internal.repoHasLocalIdentity(bareIdentityRepo)).toBe(false);
    // …until the cache is reset.
    _internal._resetLocalIdentityCacheForTest();
    expect(_internal.repoHasLocalIdentity(bareIdentityRepo)).toBe(true);
  });
});

// ── readSync ──────────────────────────────────────────────────────

describe('SafeGitExecutor.readSync', () => {
  let benignSandbox: string;
  let fakeInstar: string;
  beforeEach(() => {
    benignSandbox = mkSandbox();
    initRepo(benignSandbox);
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benignSandbox);
    rmrf(fakeInstar);
  });

  it('runs read-only verb successfully against benign cwd', () => {
    const out = SafeGitExecutor.readSync(['status', '--porcelain'], {
      cwd: benignSandbox,
      operation: 'test-status',
    });
    expect(typeof out).toBe('string');
  });

  it('throws on destructive verb in args[0]', () => {
    expect(() =>
      SafeGitExecutor.readSync(['add', '-A'], {
        cwd: benignSandbox,
        operation: 'misuse',
      }),
    ).toThrow(SafeGitExecutorError);
  });

  it('throws on ambiguous verb in destructive shape (branch <name>)', () => {
    expect(() =>
      SafeGitExecutor.readSync(['branch', 'newbranch'], {
        cwd: benignSandbox,
        operation: 'misuse',
      }),
    ).toThrow(SafeGitExecutorError);
  });

  it('accepts ambiguous verb in read-only shape (branch --list)', () => {
    expect(() =>
      SafeGitExecutor.readSync(['branch', '--list'], {
        cwd: benignSandbox,
        operation: 'list',
      }),
    ).not.toThrow();
  });

  it('extracts verb from -C <dir> form (args[1])', () => {
    expect(() =>
      SafeGitExecutor.readSync(['-C', benignSandbox, 'status', '--porcelain'], {
        cwd: benignSandbox,
        operation: 'with-C',
      }),
    ).not.toThrow();
  });

  it('blocks read against the instar source tree (defense-in-depth)', () => {
    expect(() =>
      SafeGitExecutor.readSync(['status', '--porcelain'], {
        cwd: fakeInstar,
        operation: 'read-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
  });
});

// ── verb sets ─────────────────────────────────────────────────────

describe('verb classification sets', () => {
  it('DESTRUCTIVE_GIT_VERBS and READONLY_GIT_VERBS overlap only on shape-checked verbs', () => {
    const overlap = [...DESTRUCTIVE_GIT_VERBS].filter((v) => READONLY_GIT_VERBS.has(v));
    // Allowed overlap: ambiguous verbs that are shape-checked at runtime.
    expect(overlap.sort()).toEqual(
      ['branch', 'config', 'format-patch', 'remote', 'stash', 'worktree'].sort(),
    );
  });
});

// ── spawn ─────────────────────────────────────────────────────────

describe('SafeGitExecutor.spawn', () => {
  let benignSandbox: string;
  let fakeInstar: string;
  beforeEach(() => {
    benignSandbox = mkSandbox();
    initRepo(benignSandbox);
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benignSandbox);
    rmrf(fakeInstar);
  });

  it('returns a ChildProcess and the guard fires before spawn', () => {
    expect(() =>
      SafeGitExecutor.spawn(['add', '-A'], {
        cwd: fakeInstar,
        operation: 'spawn-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
  });

  it('spawn against benign cwd returns a child process', async () => {
    fs.writeFileSync(path.join(benignSandbox, 'a'), 'a');
    const child = SafeGitExecutor.spawn(['add', '-A'], {
      cwd: benignSandbox,
      operation: 'spawn-ok',
    });
    expect(child).toBeDefined();
    await new Promise((resolve) => child.on('exit', resolve));
  });
});

// ── Incident-B regression ─────────────────────────────────────────

describe('Incident-B regression', () => {
  it('a fixture invoking add -A against the instar source is blocked', () => {
    const fakeInstar = makeFakeInstarSource();
    try {
      // Simulating exactly tests/e2e/branch-lifecycle.test.ts's prior pattern:
      //   execFileSync('git', ['add', '-A'], { cwd: <instar source root> })
      // After migration, this becomes:
      //   SafeGitExecutor.execSync(['add', '-A'], { cwd: <root>, operation: '...' })
      // Either way, the guard must throw.
      expect(() =>
        SafeGitExecutor.execSync(['add', '-A'], {
          cwd: fakeInstar,
          operation: 'incident-b-regression',
        }),
      ).toThrow(SourceTreeGuardError);
    } finally {
      rmrf(fakeInstar);
    }
  });
});
