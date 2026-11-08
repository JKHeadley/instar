// safe-git-allow: this is a test file for SafeGitExecutor; direct git+fs usage is for fixture setup only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SafeGitExecutor,
  SafeGitExecutorError,
  DESTRUCTIVE_GIT_VERBS,
  READONLY_GIT_VERBS,
  SOURCE_TREE_READ_TIER_VERBS,
  GIT_VERB_CLASSES,
  classifyGitInvocation,
  _internal,
} from '../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError } from '../../src/core/SourceTreeGuard.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

// Frozen copies of the two lists as they stood before the table existed, plus
// the changes each later spec made. Written out on purpose: the other tests in
// this file read the table they check, so only this copy can catch a verb that
// was dropped or moved from one class to another.
const FROZEN_WRITE_VERBS = [
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'fetch', 'gc', 'init',
  'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'submodule', 'switch',
  'tag', 'update-ref', 'merge-tree', 'commit-tree', 'worktree', 'prune', 'notes', 'replace', 'filter-branch',
  'remote', 'config', 'format-patch',
  'reflog', // EVO-028: its write shapes were already accepted
  // EVO-029: write-tree always writes; seven read verbs with a write or
  // program-running form became shape, so a write surface may be asked to run them.
  'write-tree', 'symbolic-ref', 'hash-object', 'interpret-trailers', 'fsck', 'grep', 'ls-remote', 'help',
];
const FROZEN_READ_VERBS = [
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'describe',
  'name-rev', 'blame', 'cat-file', 'cherry', 'grep', 'shortlog', 'count-objects', 'fsck', 'var', 'version',
  '--version', 'help', 'interpret-trailers', 'check-ref-format', 'symbolic-ref', 'show-ref',
  'for-each-ref', 'merge-base', 'reflog', 'hash-object', 'config', 'remote', 'branch', 'worktree', 'format-patch',
  'stash',
  'check-ignore', // EVO-028
  // EVO-029: write-tree left the read list.
];

// One read-shaped and one non-read argument list per shape-checked verb.
// `write` runs on a write surface; `refused` runs nowhere. A `shape` verb with
// no entry here fails the test below.
const SHAPE_EXAMPLES: Record<string, { read: string[]; write?: string[]; refused?: string[] }> = {
  branch: { read: ['--list'], write: ['new-branch'], refused: ['--edit-description'] },
  remote: { read: ['get-url', 'origin'], write: ['add', 'origin', 'x'] },
  worktree: { read: ['list'], write: ['add', '../wt'] },
  config: { read: ['--get', 'user.name'], write: ['user.name', 'X'], refused: ['--edit'] },
  'format-patch': { read: ['-1', '--stdout'], write: ['-1'] },
  stash: { read: ['list'], write: ['push'] },
  reflog: { read: ['show'], write: ['expire', '--expire=now', '--all'] },
  'symbolic-ref': { read: ['--short', 'HEAD'], write: ['HEAD', 'refs/heads/x'] },
  'hash-object': { read: ['f.txt'], write: ['-w', 'f.txt'] },
  'interpret-trailers': { read: ['--trailer', 'A: b', 'msg'], write: ['--in-place', 'msg'] },
  fsck: { read: ['--full'], write: ['--lost-found'] },
  grep: { read: ['-n', '-e', 'x'], refused: ['-Oless', 'x'] },
  'ls-remote': { read: ['--tags', 'origin'], refused: ['--upload-pack=x', 'origin'] },
  help: { read: ['-a'], refused: ['commit'] },
};

function mkSandbox(prefix = 'sge-vc-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function initRepo(dir: string): void {
  const env = sanitizedGitEnv();
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore', env });
  fs.writeFileSync(path.join(dir, 'seed'), 'seed');
  execFileSync('git', ['add', 'seed'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'ignore', env });
}

// SourceTreeGuard reads the origin URL, so this makes a sandbox count as instar source.
function promoteToSourceTree(dir: string): void {
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/dawn/instar.git'], {
    cwd: dir,
    stdio: 'ignore',
    env: sanitizedGitEnv(),
  });
}

let auditDir: string;
beforeAll(() => {
  auditDir = mkSandbox('sge-vc-audit-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
});
afterAll(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  rmrf(auditDir);
});

describe('GIT_VERB_CLASSES — the one table', () => {
  it('derives both exported sets from the table', () => {
    const write = [...GIT_VERB_CLASSES].filter(([, c]) => c !== 'read').map(([v]) => v);
    const read = [...GIT_VERB_CLASSES].filter(([, c]) => c !== 'write').map(([v]) => v);
    expect([...DESTRUCTIVE_GIT_VERBS].sort()).toEqual(write.sort());
    expect([...READONLY_GIT_VERBS].sort()).toEqual(read.sort());
  });

  it('pins membership against a frozen copy of the lists', () => {
    expect([...DESTRUCTIVE_GIT_VERBS].sort()).toEqual([...FROZEN_WRITE_VERBS].sort());
    expect([...READONLY_GIT_VERBS].sort()).toEqual([...FROZEN_READ_VERBS].sort());
  });

  it('names every verb once in the raw table entries', () => {
    const verbs = _internal.GIT_VERB_CLASS_ENTRIES.map(([v]) => v);
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(verbs.length).toBe(GIT_VERB_CLASSES.size);
  });

  it('marks as shape exactly the verbs isReadOnlyShape decides', () => {
    const listed = execFileSync('git', ['--list-cmds=main'], { encoding: 'utf-8', env: sanitizedGitEnv() })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    // Also walks git's own commands, so a switch case with no table row fails too.
    for (const verb of new Set([...GIT_VERB_CLASSES.keys(), ...listed])) {
      const decided = _internal.isReadOnlyShape(verb, []) !== null;
      expect({ verb, decided }).toEqual({ verb, decided: GIT_VERB_CLASSES.get(verb) === 'shape' });
    }
  });

  it('classifies every read and write verb by its table class', () => {
    for (const [verb, cls] of GIT_VERB_CLASSES) {
      if (cls === 'shape') continue;
      expect({ verb, got: classifyGitInvocation(verb, []) }).toEqual({ verb, got: cls });
    }
  });

  it('classifies both shapes of every shape verb', () => {
    const shapeVerbs = [...GIT_VERB_CLASSES].filter(([, c]) => c === 'shape').map(([v]) => v);
    expect(shapeVerbs.sort()).toEqual(Object.keys(SHAPE_EXAMPLES).sort());
    for (const verb of shapeVerbs) {
      const ex = SHAPE_EXAMPLES[verb];
      expect(ex.write ?? ex.refused).toBeDefined();
      expect({ verb, got: classifyGitInvocation(verb, ex.read) }).toEqual({ verb, got: 'read' });
      if (ex.write) expect({ verb, got: classifyGitInvocation(verb, ex.write) }).toEqual({ verb, got: 'write' });
      if (ex.refused) expect({ verb, got: classifyGitInvocation(verb, ex.refused) }).toEqual({ verb, got: 'refused' });
    }
  });

  it('answers unclassified for every other git command on this machine', () => {
    const all = execFileSync('git', ['--list-cmds=main'], { encoding: 'utf-8', env: sanitizedGitEnv() })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    // A git that lists nothing would make this loop pass empty.
    expect(all.length).toBeGreaterThan(50);
    const outside = all.filter((v) => !GIT_VERB_CLASSES.has(v));
    expect(outside.length).toBeGreaterThan(0);
    for (const verb of outside) {
      expect({ verb, got: classifyGitInvocation(verb, []) }).toEqual({ verb, got: 'unclassified' });
    }
  });
});

describe('SafeGitExecutor surfaces agree on a verb', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkSandbox();
    initRepo(sandbox);
  });
  afterEach(() => rmrf(sandbox));

  function messageOf(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(SafeGitExecutorError);
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  }

  it('refuses an unclassified verb with one message on every surface', () => {
    const opts = { cwd: sandbox, operation: 'test-unclassified' };
    const args = ['daemon', '--help'];
    const messages = [
      messageOf(() => SafeGitExecutor.execSync(args, opts)),
      messageOf(() => SafeGitExecutor.spawn(args, opts)),
      messageOf(() => SafeGitExecutor.readSync(args, opts)),
      messageOf(() => SafeGitExecutor.readStream(args, opts)),
      messageOf(() => SafeGitExecutor.run(args, opts)),
    ];
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toContain("'daemon'");
    expect(messages[0]).toContain('not classified');
    expect(messages[0]).not.toMatch(/use SafeGitExecutor\./);
  });

  it('refuses an unclassified verb with the same message on a source tree', () => {
    const opts = { cwd: sandbox, operation: 'test-unclassified-source-tree' };
    const args = ['daemon', '--help'];
    const expected = messageOf(() => SafeGitExecutor.readSync(args, opts));
    promoteToSourceTree(sandbox);
    const messages = [
      messageOf(() => SafeGitExecutor.execSync(args, opts)),
      messageOf(() => SafeGitExecutor.spawn(args, opts)),
      messageOf(() => SafeGitExecutor.readSync(args, opts)),
      messageOf(() => SafeGitExecutor.readStream(args, opts)),
      messageOf(() => SafeGitExecutor.run(args, opts)),
    ];
    expect(new Set(messages)).toEqual(new Set([expected]));
  });

  it('still runs the source-tree guard first for a classified verb', () => {
    promoteToSourceTree(sandbox);
    const opts = { cwd: sandbox, operation: 'test-classified-source-tree' };
    expect(() => SafeGitExecutor.execSync(['status'], opts)).toThrow(SourceTreeGuardError);
  });

  it('runs check-ignore through readSync and refuses it on execSync', () => {
    fs.writeFileSync(path.join(sandbox, '.gitignore'), 'ignored.txt\n');
    const opts = { cwd: sandbox, operation: 'test-check-ignore' };
    const out = SafeGitExecutor.readSync(['check-ignore', 'ignored.txt'], opts);
    expect(out.trim()).toBe('ignored.txt');
    expect(SafeGitExecutor.readSync(['check-ignore', '-q', 'ignored.txt'], opts)).toBe('');
    expect(messageOf(() => SafeGitExecutor.execSync(['check-ignore', 'ignored.txt'], opts))).toContain(
      'use SafeGitExecutor.readSync',
    );
  });

  it('keeps check-ignore exit codes readable, so not-ignored and broken stay distinct', () => {
    fs.writeFileSync(path.join(sandbox, '.gitignore'), 'ignored.txt\n');
    const statusOf = (cwd: string, target: string): unknown => {
      try {
        SafeGitExecutor.readSync(['check-ignore', target], { cwd, operation: 'test-check-ignore-exit' });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status;
      }
    };
    expect(statusOf(sandbox, 'ignored.txt')).toBe(0);
    expect(statusOf(sandbox, 'not-ignored.txt')).toBe(1);
    const notARepo = mkSandbox('sge-vc-norepo-');
    try {
      expect(statusOf(notARepo, 'x')).toBe(128);
    } finally {
      rmrf(notARepo);
    }
  });

  it('admits check-ignore on a source tree only with sourceTreeReadOk', () => {
    expect(SOURCE_TREE_READ_TIER_VERBS.has('check-ignore')).toBe(true);
    fs.writeFileSync(path.join(sandbox, '.gitignore'), 'ignored.txt\n');
    promoteToSourceTree(sandbox);
    const opts = { cwd: sandbox, operation: 'test-check-ignore-source-tree' };
    expect(() => SafeGitExecutor.readSync(['check-ignore', 'ignored.txt'], opts)).toThrow(SourceTreeGuardError);
    const out = SafeGitExecutor.readSync(['check-ignore', 'ignored.txt'], { ...opts, sourceTreeReadOk: true });
    expect(out.trim()).toBe('ignored.txt');
  });

  it('routes reflog through run by shape', () => {
    const opts = { cwd: sandbox, operation: 'test-reflog-run' };
    expect(SafeGitExecutor.run(['reflog'], opts)).toContain('seed');
    SafeGitExecutor.run(['reflog', 'expire', '--expire=now', '--all'], opts);
    expect(SafeGitExecutor.run(['reflog'], opts).trim()).toBe('');
  });

  it('sends a non-read reflog form through execSync', () => {
    const opts = { cwd: sandbox, operation: 'test-reflog-head' };
    const spy = vi.spyOn(SafeGitExecutor, 'execSync');
    try {
      SafeGitExecutor.run(['reflog', 'HEAD'], opts);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('routes run on the verb past a pre-verb flag (EVO-029 item 1)', () => {
    const opts = { cwd: sandbox, operation: 'test-preverb' };
    // An admitted -c on a read reaches readSync and runs.
    expect(typeof SafeGitExecutor.run(['-c', 'core.fsmonitor=false', 'status', '--porcelain'], opts)).toBe('string');
    // A write behind a pre-verb flag now reaches execSync and commits.
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sandbox, encoding: 'utf-8', env: sanitizedGitEnv() });
    SafeGitExecutor.run(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'm'], opts);
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sandbox, encoding: 'utf-8', env: sanitizedGitEnv() });
    expect(after).not.toBe(before);
  });
});
