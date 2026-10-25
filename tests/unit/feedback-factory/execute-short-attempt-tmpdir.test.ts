// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Wall 3 of the executor's confined session (measured live on the Mac Studio, 2026-10-19,
 * Claude Code 2.1.303): with the attempt temp directory under the agent home (83 bytes),
 * CLAUDE_CODE_TMPDIR was too long for Claude Code's sandbox temp override, its per-call cwd file
 * fell back to /tmp/claude-<uid> (not allowed by the policy) and EVERY confined Bash call exited 1,
 * failing the canary's session-git-status probe. With a short, real-path directory
 * (/private/tmp/fb-probe02, 22 bytes) git and echo exited 0 and the system-temp canary write
 * stayed refused. These tests pin the shape that works.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SHORT_ATTEMPT_TMP_RE, ensurePrivateAttemptTmpDir, removeAttemptTree, shortAttemptTmpDir, shortTmpRealRoot } from '../../../src/feedback-factory/execute/attemptFs.js';
import { FeedbackExecutorService } from '../../../src/feedback-factory/execute/FeedbackExecutorService.js';
import { buildClaudeSandboxSettings, buildSandboxRuntimeSettings } from '../../../src/feedback-factory/execute/executePolicy.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'execute-short-attempt-tmpdir.test.ts' });
});

describe('shortAttemptTmpDir', () => {
  it('is a short real path under the system temp root: ≤ 30 bytes (Claude Code honours the override only then)', () => {
    const dir = shortAttemptTmpDir('cluster-some-very-long-initiative-identifier-0123456789', 1);
    expect(path.dirname(dir)).toBe(shortTmpRealRoot());
    expect(SHORT_ATTEMPT_TMP_RE.test(path.basename(dir))).toBe(true);
    expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(30);
    expect(dir).toBe(fs.existsSync(path.dirname(dir)) ? path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir)) : dir); // already real
  });

  it('is stable per (initiative, attempt) and distinct across attempts and initiatives', () => {
    expect(shortAttemptTmpDir('i-1', 1, '/t')).toBe(shortAttemptTmpDir('i-1', 1, '/t'));
    expect(shortAttemptTmpDir('i-1', 1, '/t')).not.toBe(shortAttemptTmpDir('i-1', 2, '/t'));
    expect(shortAttemptTmpDir('i-1', 1, '/t')).not.toBe(shortAttemptTmpDir('i-2', 1, '/t'));
    expect(path.basename(shortAttemptTmpDir('i-1', 1, '/t', '/h'))).toMatch(SHORT_ATTEMPT_TMP_RE);
  });

  it('the executor uses it for every attempt path reader (one derivation, never a stored string)', () => {
    const paths = FeedbackExecutorService.prototype.attemptPaths.call({ opts: { paths: { agentHome: '/h' } } }, { initiativeId: 'init-x', attempt: 3 });
    expect(paths.tmpDir).toBe(shortAttemptTmpDir('init-x', 3, shortTmpRealRoot(), '/h'));
    // Scoped to the agent home: a second executor on the same host never shares the directory.
    expect(shortAttemptTmpDir('init-x', 3, '/t', '/h')).not.toBe(shortAttemptTmpDir('init-x', 3, '/t', '/other-home'));
    expect(paths.workspace.startsWith('/h/.worktrees/feedback-')).toBe(true);
    expect(paths.workspace.endsWith('-a3')).toBe(true);
    expect(paths.tmpDir.startsWith('/h/')).toBe(false);
  });

  // This test used to assert `denyWrite` still contained '/tmp' and '/private/tmp' while the attempt
  // temp sits inside them — "allows the temp dir AND denies the shared roots around it". That
  // combination is not what the sandbox runtime does: its README states that for WRITES `denyWrite`
  // takes precedence over `allowWrite` (the reverse of reads, where `allowRead` wins). So the deny on
  // the ancestor won and the attempt could not write its own temp:
  //   EPERM: operation not permitted, mkdir '/private/tmp/fb-8ac70c2cde/HH0KfR7JCSG9zBDVFZQSa'
  // thrown by vitest's config resolution. That is the `base-unit-smoke` failure that latched the
  // feedback executor for three days (2026-10-22 … 2026-10-25, five consecutive 24h latches), and
  // THIS test is why it shipped: it asserted the broken pairing as the intended policy.
  it('the policy allows the temp dir for real: no denyWrite entry is an ancestor of it, and the shared temp stays unwritable', () => {
    const tmpDir = shortAttemptTmpDir('init-x', 1, '/private/tmp');
    const p = { workspace: '/h/.worktrees/w', publishClone: '/h/.worktrees/w-publish', tmpDir, depsCache: '/h/.worktrees/.feedback-deps/x', agentHome: '/h', testRunnerHoldersFile: '/u/.instar/h.json', homeDir: '/u' };
    const rt = buildSandboxRuntimeSettings(p);
    expect(rt.filesystem.allowWrite).toContain(tmpDir);
    expect(rt.filesystem.allowRead).toContain(tmpDir);
    // The real invariant: an allow is worthless if a deny sits above it.
    for (const denied of rt.filesystem.denyWrite) {
      expect(tmpDir === denied || tmpDir.startsWith(`${denied}/`)).toBe(false);
    }
    // And the shared temp itself is STILL not writable — because writes are allowlist-based and it
    // is never in allowWrite. That, not the deny entry, is what keeps it closed.
    expect(rt.filesystem.allowWrite).not.toContain('/tmp');
    expect(rt.filesystem.allowWrite).not.toContain('/private/tmp');
    // The other shared temp roots, which no attempt path sits under, stay denied.
    expect(rt.filesystem.denyWrite).toEqual(expect.arrayContaining(['/var/tmp']));
    const cc = buildClaudeSandboxSettings({ paths: p, agentHomeChildren: ['.worktrees'] }) as { env: { TMPDIR: string }; permissions: { allow: string[] } };
    expect(cc.env.TMPDIR).toBe(tmpDir);
    expect(cc.permissions.allow).toContain(`Edit(/${tmpDir}/**)`.replace('//', '/' + '/'));
  });
});

describe('removeAttemptTree across devices', () => {
  it('falls back to removing in place when the move into the trash fails EXDEV (tmpfs /tmp on Linux)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-tree-'));
    dirs.push(base);
    const target = path.join(base, 'fb-0123456789');
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'x'), 'x');
    const trash = path.join(base, 'trash');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { const e = new Error('EXDEV') as NodeJS.ErrnoException; e.code = 'EXDEV'; throw e; });
    removeAttemptTree(target, trash, 'test');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('any other rename failure still propagates (nothing is deleted outside the trash on an unknown error)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-tree-'));
    dirs.push(base);
    const target = path.join(base, 'fb-abcdefabcd');
    fs.mkdirSync(target);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; });
    expect(() => removeAttemptTree(target, path.join(base, 'trash'), 'test')).toThrow(/EPERM/);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('ensurePrivateAttemptTmpDir (second-pass review: a predictable name under a sticky root)', () => {
  const mk = () => { const base = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-tmp-')); dirs.push(base); return base; };

  it('creates a fresh 0700 directory owned by us', () => {
    const base = mk(); const dir = path.join(base, 'fb-0123456789');
    ensurePrivateAttemptTmpDir(dir, path.join(base, 'trash'));
    const st = fs.lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('a pre-existing directory owned by ANOTHER uid is refused, untouched', () => {
    const base = mk(); const dir = path.join(base, 'fb-0123456789');
    fs.mkdirSync(dir, { mode: 0o755 }); fs.writeFileSync(path.join(dir, 'planted'), 'x');
    const foreignExpectation = (process.getuid?.() ?? 0) + 1; // our uid is not the expected one
    expect(() => ensurePrivateAttemptTmpDir(dir, path.join(base, 'trash'), foreignExpectation)).toThrow(/confinement-tmpdir-foreign-owner/);
    expect(fs.existsSync(path.join(dir, 'planted'))).toBe(true);
  });

  it('a pre-existing directory we own (crash leftover) is replaced by an empty private one', () => {
    const base = mk(); const dir = path.join(base, 'fb-0123456789');
    fs.mkdirSync(dir, { mode: 0o755 }); fs.writeFileSync(path.join(dir, 'leftover'), 'x');
    ensurePrivateAttemptTmpDir(dir, path.join(base, 'trash'));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a symlink or a plain file at the path is refused', () => {
    const base = mk();
    const target = path.join(base, 'elsewhere'); fs.mkdirSync(target);
    const link = path.join(base, 'fb-aaaaaaaaaa'); fs.symlinkSync(target, link);
    expect(() => ensurePrivateAttemptTmpDir(link, path.join(base, 'trash'))).toThrow(/confinement-tmpdir-not-a-directory/);
    const file = path.join(base, 'fb-bbbbbbbbbb'); fs.writeFileSync(file, '');
    expect(() => ensurePrivateAttemptTmpDir(file, path.join(base, 'trash'))).toThrow(/confinement-tmpdir-not-a-directory/);
  });
});
