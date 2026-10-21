// safe-git-allow: test file — drives real git (bare remote + clones) in
//   per-test tmpdirs to exercise the release push path; cleanup is the tmpdir.

/**
 * Tests for scripts/lib/release-local-steps.mjs — the post-publish decisions of
 * scripts/release-local.mjs, against real git repos:
 *   - a push refused by a hook (remote did not move) fails at once, no rebase;
 *   - a push rejected because main moved rebases and retries, tag follows;
 *   - commit and tag go up atomically (a refused tag leaves main untouched);
 *   - every gate base ref that exists is refreshed, and a stale one that
 *     cannot be refreshed is a failure;
 *   - a non-zero `npm publish` is resolved against the registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  refreshGateBaseRefs,
  pushReleaseAtomically,
  pushTagThenMain,
  publishedStateAfterFailure,
  workingTreeReleaseCut,
  remoteTagSha,
  viewRetryDelayMs,
  npmPendingNotice,
  smokeFailureVerdict,
  npmAheadOfMain,
  unfinishedReleaseMessage,
  consumedFragmentsAt,
  bumpVersionJson,
  fragmentReleasedIn,
  remoteTagAheadOf,
  inflightRefusal,
  shouldClearInflightOnFailure,
  isReleaseCutCommit,
  otpRequirement,
  ciRunState,
  ciGateAction,
  activePublishRuns,
  ACTIVE_RUN_STATUSES,
  dirtyToolFilesOnly,
} from '../../scripts/lib/release-local-steps.mjs';

type R = { status: number; stdout: string; stderr: string };

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 't';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 't@t';
  return env;
}
const ENV = cleanEnv();

function runner(cwd: string, calls: string[][] = []) {
  return (cmd: string, args: string[]): R => {
    calls.push([cmd, ...args]);
    const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf-8' });
    return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

describe('release-local push + ref refresh (real git)', () => {
  let tmp: string;
  let bare: string;
  let clone: string;
  let other: string;
  const g = (cwd: string, ...args: string[]) => {
    const r = runner(cwd)('git', args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-local-steps-'));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');
    other = path.join(tmp, 'other');
    g(tmp, 'init', '--bare', '--initial-branch=main', bare);
    g(tmp, 'clone', '-q', bare, clone);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'base');
    g(clone, 'push', '-q', 'origin', 'HEAD:main');
    g(tmp, 'clone', '-q', bare, other);
    // The release commit, made locally and not yet pushed.
    fs.writeFileSync(path.join(clone, 'version.txt'), '1.0.1\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'chore: release v1.0.1 [skip ci]');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('pushes commit and tag together on the first attempt', () => {
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res).toMatchObject({ ok: true, attempts: 1 });
    const head = g(clone, 'rev-parse', 'HEAD');
    expect(g(bare, 'rev-parse', 'main')).toBe(head);
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(head);
  });

  it('a hook refusal (remote did not move) fails at once with the hook output — no rebase, no retry', () => {
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\necho "HOOK SAYS NO" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const calls: string[][] = [];
    const res = pushReleaseAtomically({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.reason).toContain('fast-forward');
    expect(res.output).toContain('HOOK SAYS NO');
    expect(calls.filter((c) => c[1] === 'push')).toHaveLength(1);
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
  });

  /** Another publisher's release cut lands on main (no code). */
  function otherReleaseCut() {
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.5' }, null, 2) + '\n');
    fs.mkdirSync(path.join(other, 'upgrades'), { recursive: true });
    fs.writeFileSync(path.join(other, 'upgrades', '1.0.5.md'), '# notes\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'chore: release v1.0.5 [skip ci]');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
  }
  /** A code merge lands on main. */
  function otherCodeMerge() {
    fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'concurrent merge');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
  }

  it('main moved by a CODE commit: refuses to rebase — the tag would cover code npm never got', () => {
    otherCodeMerge();
    const before = g(bare, 'rev-parse', 'main');
    const calls: string[][] = [];
    const res = pushReleaseAtomically({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('main-moved-with-code');
    expect(res.attempts).toBe(1);
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    expect(runner(bare)('git', ['rev-parse', '--verify', '--quiet', 'refs/tags/v1.0.1']).status).not.toBe(0);
  });

  it('main moved ONLY by another release cut: rebases and retries; the tag follows the rebased commit', () => {
    otherReleaseCut();
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    const head = g(clone, 'rev-parse', 'HEAD');
    expect(g(bare, 'rev-parse', 'main')).toBe(head);
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(head);
    expect(g(bare, 'log', '-1', '--format=%s', 'main^')).toBe('chore: release v1.0.5 [skip ci]');
  });

  it('isReleaseCutCommit: a real cut yes; a code commit, a merge and a root commit no', () => {
    otherReleaseCut();
    g(clone, 'fetch', '-q', 'origin', 'main');
    expect(isReleaseCutCommit(runner(clone), 'origin/main')).toBe(true);
    expect(isReleaseCutCommit(runner(clone), 'HEAD')).toBe(false); // version.txt is not a cut
    expect(isReleaseCutCommit(runner(clone), 'HEAD~1')).toBe(false); // root commit
    g(clone, 'merge', '-q', '--no-edit', 'origin/main');
    expect(isReleaseCutCommit(runner(clone), 'HEAD')).toBe(false); // merge commit
  });

  it('--keep-tag-on-published resume: tag stays on the published commit, main gets the rebased release commit', () => {
    otherCodeMerge();
    g(clone, 'tag', 'v1.0.1');
    const published = g(clone, 'rev-parse', 'HEAD');
    const res = pushTagThenMain({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(published);
    const main = g(bare, 'rev-parse', 'main');
    expect(main).not.toBe(published);
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.1 [skip ci]');
    expect(g(bare, 'log', '-1', '--format=%s', 'main^')).toBe('concurrent merge');
  });

  it('--keep-tag-on-published: a hook refusal on the main push still stops at once', () => {
    g(clone, 'tag', 'v1.0.1');
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    // Refuse only the main push (the tag push goes first and is allowed).
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read l lsha r rsha; do case "$r" in refs/heads/main) echo "HOOK SAYS NO" >&2; exit 1;; esac; done\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    const calls: string[][] = [];
    const res = pushTagThenMain({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('fast-forward');
    expect(res.output).toContain('HOOK SAYS NO');
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
  });

  it('--keep-tag-on-published refuses when the local tag is not on HEAD', () => {
    g(clone, 'tag', 'v1.0.1', 'HEAD~1');
    const res = pushTagThenMain({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('not on HEAD');
  });

  it('is atomic: when the tag is refused, main is not updated either', () => {
    // Someone already holds v1.0.1 on the remote, on a different commit.
    g(other, 'tag', 'v1.0.1');
    g(other, 'push', '-q', 'origin', 'v1.0.1');
    const before = g(bare, 'rev-parse', 'main');
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('stale tracking ref + hook refusal: classified as a refusal at once (no rebase), not as "main moved"', () => {
    // An extra commit so the tracking ref can be made stale.
    fs.writeFileSync(path.join(other, 'c.txt'), 'c\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'older main tip');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
    g(clone, 'fetch', '-q', 'origin', 'main');
    g(clone, 'rebase', '-q', 'origin/main'); // our release commit now sits on the real tip
    g(clone, 'update-ref', 'refs/remotes/origin/main', g(clone, 'rev-parse', 'HEAD~2')); // stale
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\necho "HOOK SAYS NO" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const calls: string[][] = [];
    const res = pushReleaseAtomically({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.reason).toContain('fast-forward');
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
  });

  it('names the race: the remote already has the tag on a commit that is NOT the release cut', () => {
    g(other, 'tag', 'v1.0.1');
    g(other, 'push', '-q', 'origin', 'v1.0.1');
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('tag-exists');
    expect(res.reason).toContain('already has tag v1.0.1');
    expect(res.reason).toContain('is NOT a release cut');
    expect(res.reason).toContain('publish.yml run, or an earlier --keep-tag-on-published run of this tool');
    expect(remoteTagSha(runner(clone), 'origin', 'v1.0.1')).toBe(g(other, 'rev-parse', 'HEAD'));
    // the temporary ref used to inspect the remote tag is cleaned up
    expect(runner(clone)('git', ['rev-parse', '--verify', '--quiet', 'refs/release-local/remote-tag']).status).not.toBe(0);
  });

  it('after a keep-tag run, a plain --push-only rerun is told it was probably our own earlier run', () => {
    // A real release cut for 1.0.1 (package.json + guide), published and tagged
    // by an earlier --keep-tag-on-published run; then main moved and the
    // release commit was rebased off the tag.
    fs.writeFileSync(path.join(clone, 'version.txt'), '');
    g(clone, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.1' }, null, 2) + '\n');
    fs.mkdirSync(path.join(clone, 'upgrades'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'upgrades', '1.0.1.md'), '# notes\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'chore: release v1.0.1 [skip ci]');
    g(clone, 'tag', 'v1.0.1');
    g(clone, 'push', '-q', 'origin', 'v1.0.1');
    otherCodeMerge();
    g(clone, 'fetch', '-q', 'origin', 'main');
    g(clone, 'rebase', '-q', 'origin/main'); // HEAD now differs from the tag
    g(clone, 'tag', '-d', 'v1.0.1');
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('tag-exists');
    expect(res.reason).toContain('That commit IS the release cut for v1.0.1');
    expect(res.reason).toContain('re-run with --push-only --keep-tag-on-published');
  });

  it('--keep-tag-on-published is resumable: tag already pushed, HEAD rebased off it → main push only', () => {
    otherCodeMerge();
    g(clone, 'tag', 'v1.0.1');
    const published = g(clone, 'rev-parse', 'HEAD');
    // First run: tag pushed, then the MAIN push refused by a hook after the rebase.
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read l lsha r rsha; do case "$r" in refs/heads/main) [ -f "$BLOCK_FILE" ] && { echo "HOOK SAYS NO" >&2; exit 1; };; esac; done\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    const block = path.join(tmp, 'BLOCK');
    fs.writeFileSync(block, '');
    ENV.BLOCK_FILE = block;
    try {
      const first = pushTagThenMain({ run: runner(clone), remote: 'origin', version: '1.0.1' });
      expect(first.ok).toBe(false);
      expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(published);
      // The recovery text names the exact re-run and the by-hand push.
      expect(first.reason).toContain('--push-only --keep-tag-on-published --remote origin');
      expect(first.reason).toContain('git push origin HEAD:main');
      // HEAD has moved off the tag (rebased) — the old code refused a re-run here.
      fs.rmSync(block);
      const second = pushTagThenMain({ run: runner(clone), remote: 'origin', version: '1.0.1' });
      expect(second).toMatchObject({ ok: true });
      expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(published);
      expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.1 [skip ci]');
    } finally {
      delete ENV.BLOCK_FILE;
    }
  });

  it('refreshes every existing gate base ref and skips ones that do not exist', () => {
    fs.writeFileSync(path.join(other, 'c.txt'), 'c\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'moved');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
    const res = refreshGateBaseRefs(runner(clone));
    expect(res).toMatchObject({ ok: true, refreshed: ['origin/main'], failed: [] });
    expect(g(clone, 'rev-parse', 'origin/main')).toBe(g(bare, 'rev-parse', 'main'));
  });

  it('fetches each gate base ref from ITS OWN remote, not from the release remote', () => {
    // upstream points at the real remote; JKHeadley does not exist. If every
    // ref were fetched from origin, JKHeadley/main would "refresh" fine.
    g(clone, 'remote', 'add', 'upstream', bare);
    g(clone, 'fetch', '-q', 'upstream', 'main');
    const calls: string[][] = [];
    const res = refreshGateBaseRefs(runner(clone, calls));
    expect(res.refreshed).toEqual(['origin/main', 'upstream/main']);
    const fetches = calls.filter((c) => c[1] === 'fetch').map((c) => c.slice(2).filter((x) => x !== '--quiet').join(' '));
    expect(fetches).toEqual(['origin main', 'upstream main']);
  });

  it('fails when a stale preferred base ref exists but cannot be refreshed', () => {
    // pickRef prefers JKHeadley/main over origin/main. A stale one that cannot
    // be fetched would be diffed against, so it must be a failure.
    g(clone, 'remote', 'add', 'JKHeadley', path.join(tmp, 'does-not-exist.git'));
    g(clone, 'update-ref', 'refs/remotes/JKHeadley/main', g(clone, 'rev-parse', 'HEAD~1'));
    const res = refreshGateBaseRefs(runner(clone));
    expect(res.ok).toBe(false);
    expect(res.failed.map((f) => f.ref)).toEqual(['JKHeadley/main']);
    expect(res.refreshed).toEqual(['origin/main']);
  });
});

describe('publishedStateAfterFailure', () => {
  const fake = (r: R) => () => r;
  const noSleep = () => {};
  const E404: R = { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 No match found for version 1.2.3' };
  it('published when the registry returns the version', () => {
    expect(publishedStateAfterFailure({ run: fake({ status: 0, stdout: '1.2.3\n', stderr: '' }), name: 'x', version: '1.2.3', sleep: noSleep })).toBe('published');
  });
  it('absent on E404 — but only after re-querying (registry lag)', () => {
    let n = 0;
    const sleeps: number[] = [];
    const res = publishedStateAfterFailure({ run: () => { n++; return E404; }, name: 'x', version: '1.2.3', sleep: (ms: number) => sleeps.push(ms) });
    expect(res).toBe('absent');
    expect(n).toBe(4); // first answer + 3 re-queries
    expect(sleeps).toEqual([10_000, 10_000, 10_000]); // ~30s by default
  });
  it('an absent that turns published during the re-queries is published', () => {
    const answers: R[] = [E404, E404, { status: 0, stdout: '1.2.3', stderr: '' }];
    let i = 0;
    expect(publishedStateAfterFailure({ run: () => answers[Math.min(i++, answers.length - 1)], name: 'x', version: '1.2.3', sleep: noSleep })).toBe('published');
  });
  it('a TIMED-OUT publish that still reads absent is UNKNOWN, never absent', () => {
    expect(publishedStateAfterFailure({ run: fake(E404), name: 'x', version: '1.2.3', timedOut: true, sleep: noSleep })).toBe('unknown');
    expect(publishedStateAfterFailure({ run: fake(E404), name: 'x', version: '1.2.3', timedOut: false, sleep: noSleep })).toBe('absent');
  });
  it('unknown on a network or auth error — never treated as absent, and not re-queried as if absent', () => {
    let n = 0;
    expect(publishedStateAfterFailure({ run: () => { n++; return { status: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }; }, name: 'x', version: '1.2.3', sleep: noSleep })).toBe('unknown');
    expect(n).toBe(1);
    expect(publishedStateAfterFailure({ run: fake({ status: 0, stdout: '1.2.2', stderr: '' }), name: 'x', version: '1.2.3', sleep: noSleep })).toBe('unknown');
  });
  it('asks the registry online (not the npm cache) for exactly name@version', () => {
    const calls: string[][] = [];
    publishedStateAfterFailure({
      run: (c: string, a: string[]) => { calls.push([c, ...a]); return { status: 0, stdout: '1.2.3', stderr: '' }; },
      name: 'instar', version: '1.2.3', npmArgs: ['--userconfig', '/x'], sleep: noSleep,
    });
    expect(calls).toEqual([['npm', 'view', 'instar@1.2.3', 'version', '--prefer-online', '--userconfig', '/x']]);
  });
});

describe('otpRequirement (preflight, before anything is mutated)', () => {
  it('reads the account 2FA mode', () => {
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'auth-and-writes', pending: false } }))).toBe('required');
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'auth-only', pending: false } }))).toBe('not-required');
    expect(otpRequirement(JSON.stringify({ tfa: false }))).toBe('not-required');
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'auth-and-writes', pending: true } }))).toBe('not-required');
  });
  it('anything it cannot read is unknown, never not-required', () => {
    expect(otpRequirement(null)).toBe('unknown');
    expect(otpRequirement('not json')).toBe('unknown');
    expect(otpRequirement(JSON.stringify({ error: { code: 'E403' } }))).toBe('unknown');
    expect(otpRequirement(JSON.stringify({ name: 'x' }))).toBe('unknown');
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'something-new' } }))).toBe('unknown');
  });
});

describe('ciRunState (publish.yml runs for the merge being released)', () => {
  it('queued or in-progress runs are active', () => {
    expect(ciRunState(JSON.stringify([{ databaseId: 1, status: 'queued' }, { databaseId: 2, status: 'completed' }]))).toEqual({ state: 'active', ids: [1] });
    expect(ciRunState(JSON.stringify([{ databaseId: 3, status: 'in_progress' }]))).toEqual({ state: 'active', ids: [3] });
  });
  it('only completed runs (or none) are clear', () => {
    expect(ciRunState('[]')).toEqual({ state: 'clear', ids: [] });
    expect(ciRunState(JSON.stringify([{ databaseId: 2, status: 'completed' }]))).toEqual({ state: 'clear', ids: [] });
  });
  it('a failed or unreadable gh query is unknown, never clear', () => {
    expect(ciRunState(null).state).toBe('unknown');
    expect(ciRunState('gh: not logged in').state).toBe('unknown');
    expect(ciRunState('{}').state).toBe('unknown');
  });
});

describe('activePublishRuns (ANY publish.yml run, not just this commit)', () => {
  const gh = (answers: Record<string, R>) => {
    const calls: string[][] = [];
    const run = (c: string, a: string[]): R => {
      calls.push([c, ...a]);
      const status = a[a.indexOf('--status') + 1];
      return answers[status] ?? { status: 0, stdout: '[]', stderr: '' };
    };
    return { run, calls };
  };

  it('a run queued for a DIFFERENT (earlier) merge is active — it would publish main when it gets a runner', () => {
    const { run, calls } = gh({
      queued: { status: 0, stdout: JSON.stringify([{ databaseId: 77, status: 'queued', headSha: 'aaaaaaa-earlier-merge' }]), stderr: '' },
    });
    expect(activePublishRuns(run, 'o/r')).toEqual({ state: 'active', ids: [77] });
    // never filtered to one commit
    expect(calls.every((c) => !c.includes('--commit'))).toBe(true);
    // one query per active status
    expect(calls.map((c) => c[c.indexOf('--status') + 1])).toEqual(ACTIVE_RUN_STATUSES);
    expect(calls.every((c) => c.includes('--workflow') && c.includes('publish.yml') && c.includes('o/r'))).toBe(true);
  });

  it('an in-progress run for another sha is active too', () => {
    const { run } = gh({ in_progress: { status: 0, stdout: JSON.stringify([{ databaseId: 5, status: 'in_progress', headSha: 'bbb' }]), stderr: '' } });
    expect(activePublishRuns(run, 'o/r').state).toBe('active');
  });

  it('all empty → clear; ANY failed or unreadable query → unknown (never clear)', () => {
    expect(activePublishRuns(gh({}).run, 'o/r')).toEqual({ state: 'clear', ids: [] });
    expect(activePublishRuns(gh({ waiting: { status: 1, stdout: '', stderr: 'HTTP 502' } }).run, 'o/r').state).toBe('unknown');
    expect(activePublishRuns(gh({ requested: { status: 0, stdout: 'not json', stderr: '' } }).run, 'o/r').state).toBe('unknown');
    expect(activePublishRuns(gh({}).run, null as unknown as string).state).toBe('unknown');
  });
});

describe('ACTIVE_RUN_STATUSES are values the installed gh accepts', () => {
  let ghOk = false;
  try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); ghOk = true; } catch { ghOk = false; }
  it.skipIf(!ghOk)('gh run list accepts every status we query (an invalid one fails every query)', () => {
    const help = spawnSync('gh', ['run', 'list', '--status', 'definitely-not-a-status'], { encoding: 'utf-8' });
    const m = /valid values are \{([^}]+)\}/.exec(`${help.stderr}${help.stdout}`);
    expect(m, 'gh did not print its valid --status values').not.toBeNull();
    const valid = m![1].split('|');
    for (const st of ACTIVE_RUN_STATUSES) expect(valid).toContain(st);
  });
});

describe('npm publish cannot hang on web auth with stdin closed (installed npm)', () => {
  // Echo #2224 round 2 item 3: auth-type web prints a URL and polls. Verify,
  // against the npm actually installed here, that its otplease rethrows EOTP
  // at once when stdin is not a TTY — even for a web-OTP challenge.
  let npmDir: string | null = null;
  try {
    const npmBin = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf-8' }).trim();
    const real = fs.realpathSync(npmBin);
    const dir = path.resolve(path.dirname(real), '..');
    if (fs.existsSync(path.join(dir, 'lib', 'utils', 'auth.js'))) npmDir = dir;
  } catch { npmDir = null; }

  it.skipIf(!npmDir)('otplease rethrows a web-OTP EOTP immediately when stdin is not a TTY', () => {
    const script = `
      const { otplease } = require(${JSON.stringify(path.join(npmDir ?? '', 'lib', 'utils', 'auth.js'))});
      const t0 = Date.now();
      otplease({ config: { get: () => 'web' } }, {}, async () => {
        const e = new Error('otp'); e.code = 'EOTP';
        e.body = { authUrl: 'https://example.invalid/auth', doneUrl: 'https://example.invalid/done' };
        throw e;
      }).then(() => { console.log('RESOLVED'); process.exit(3); },
              (e) => { console.log('REJECTED ' + e.code + ' ' + (Date.now() - t0)); process.exit(0); });
      setTimeout(() => { console.log('HUNG'); process.exit(4); }, 5000);
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    expect(r.stdout).toMatch(/^REJECTED EOTP \d+/m);
    expect(r.status).toBe(0);
  });
});

describe('dirtyToolFilesOnly (--dry-run --allow-dirty-tool-files)', () => {
  it('accepts only the tool\'s own files', () => {
    expect(dirtyToolFilesOnly(' M scripts/release-local.mjs\n?? scripts/lib/release-local-steps.mjs\n M CONTRIBUTING.md\n').ok).toBe(true);
  });
  it('parses real porcelain, including a first line whose leading space was trimmed', () => {
    // The real dry run hit this: the script trims git status output, so
    // ' M CONTRIBUTING.md' arrived as 'M CONTRIBUTING.md' and was misread as 'ONTRIBUTING.md'.
    const trimmed = ' M CONTRIBUTING.md\n M scripts/lint-no-direct-destructive.js\n?? scripts/release-local.mjs'.trim();
    const v = dirtyToolFilesOnly(trimmed);
    expect(v.paths).toEqual(['CONTRIBUTING.md', 'scripts/lint-no-direct-destructive.js', 'scripts/release-local.mjs']);
    expect(v.ok).toBe(true);
  });
  it('refuses anything else — notably package.json and upgrades/, which the dry run restores from HEAD', () => {
    const a = dirtyToolFilesOnly(' M scripts/release-local.mjs\n M package.json\n');
    expect(a.ok).toBe(false);
    expect(a.others).toEqual(['package.json']);
    expect(dirtyToolFilesOnly('?? upgrades/next/x.md\n').ok).toBe(false);
    expect(dirtyToolFilesOnly(' M src/core/x.ts\n').ok).toBe(false);
    expect(dirtyToolFilesOnly('R  scripts/release-local.mjs -> scripts/other.mjs\n').ok).toBe(false);
    expect(dirtyToolFilesOnly('').ok).toBe(false);
  });
});

describe('npm "Validating" review — an accepted publish that is not visible yet is PENDING', () => {
  it('the notice says what is happening, how to check, and never to re-publish', () => {
    const n = npmPendingNotice('instar', '1.3.1360');
    expect(n).toContain('"Validating" review');
    expect(n).toContain('https://www.npmjs.com/package/instar?activeTab=versions');
    expect(n).toContain('Do NOT publish again');
    expect(n).toContain('npm view instar@1.3.1360 version');
  });
  it('--push-only adds the never-published caveat; the smoke path (an accepted upload) does not', () => {
    const po = npmPendingNotice('instar', '1.3.1360', { pushOnly: true });
    expect(po).toContain('was never published (for example the publish step itself failed)');
    expect(po).toContain('do not use --push-only; re-run release-local normally');
    // The two instructions carry their conditions, so they cannot read as contradictory (Echo, #2228).
    expect(po.split('\n').at(-1)).toMatch(/^Otherwise \(published, still in review\): Do NOT publish again\./);
    expect(po.indexOf('was never published')).toBeLessThan(po.indexOf('Otherwise (published, still in review)'));
    expect(npmPendingNotice('instar', '1.3.1360')).not.toContain('never published');
    expect(npmPendingNotice('instar', '1.3.1360')).not.toContain('Otherwise (published, still in review)');
    expect(npmPendingNotice('instar', '1.3.1360').split('\n').at(-1)).toMatch(/^Do NOT publish again\./);
    expect(smokeFailureVerdict('absent', 'instar', '1.3.1360').message).not.toContain('never published');
  });
  it('smoke failed + not visible (absent or unknown) → pending, with the notice', () => {
    for (const st of ['absent', 'unknown'] as const) {
      const v = smokeFailureVerdict(st, 'instar', '1.3.1360');
      expect(v.pending).toBe(true);
      expect(v.message).toContain('not visible on npm yet');
      expect(v.message).toContain('Do NOT publish again');
    }
  });
  it('smoke failed + visible → a real smoke failure, not pending', () => {
    const v = smokeFailureVerdict('published', 'instar', '1.3.1360');
    expect(v.pending).toBe(false);
    expect(v.message).toContain('IS visible on npm');
    expect(v.message).not.toContain('Validating');
  });
});

describe('viewRetryDelayMs (INSTAR_RELEASE_LOCAL_VIEW_DELAY_MS)', () => {
  it('unset or empty means the default — an empty string is NOT zero', () => {
    expect(viewRetryDelayMs(undefined)).toBe(10_000);
    expect(viewRetryDelayMs('')).toBe(10_000);
    expect(viewRetryDelayMs('  ')).toBe(10_000);
  });
  it('can only shorten the wait: capped at the default; junk or negative means the default', () => {
    expect(viewRetryDelayMs('0')).toBe(0);
    expect(viewRetryDelayMs('2500')).toBe(2500);
    expect(viewRetryDelayMs('600000')).toBe(10_000);
    expect(viewRetryDelayMs('abc')).toBe(10_000);
    expect(viewRetryDelayMs('-5')).toBe(10_000);
  });
});

describe('ciGateAction', () => {
  it('a real run stops on active and on unknown; only an explicit override proceeds unverified', () => {
    expect(ciGateAction({ state: 'clear', dryRun: false, allowUnverified: false })).toBe('proceed');
    expect(ciGateAction({ state: 'active', dryRun: false, allowUnverified: false })).toBe('stop');
    expect(ciGateAction({ state: 'active', dryRun: false, allowUnverified: true })).toBe('stop');
    expect(ciGateAction({ state: 'unknown', dryRun: false, allowUnverified: false })).toBe('stop');
    expect(ciGateAction({ state: 'unknown', dryRun: false, allowUnverified: true })).toBe('proceed-unverified');
  });
  it('a dry run warns instead of stopping', () => {
    expect(ciGateAction({ state: 'active', dryRun: true, allowUnverified: false })).toBe('warn');
    expect(ciGateAction({ state: 'unknown', dryRun: true, allowUnverified: false })).toBe('warn');
  });
});

describe('unfinished release: npm ahead of main (1.3.1362 incident)', () => {
  it('npmAheadOfMain compares numerically and ignores junk', () => {
    expect(npmAheadOfMain('1.3.1362', '1.3.1361')).toBe(true);
    expect(npmAheadOfMain('1.3.1000', '1.3.999')).toBe(true);
    expect(npmAheadOfMain('1.3.1361', '1.3.1361')).toBe(false);
    expect(npmAheadOfMain('1.3.1360', '1.3.1361')).toBe(false);
    expect(npmAheadOfMain('', '1.3.1361')).toBe(false);
  });
  it('the refusal names the version and both remedies', () => {
    const m = unfinishedReleaseMessage('instar', '1.3.1362', '1.3.1361', 'origin');
    expect(m).toContain('instar@1.3.1362 is on npm but main\'s package.json is 1.3.1361');
    expect(m).toContain('--push-only --remote origin');
    expect(m).toContain('--reconcile 1.3.1362 --remote origin');
    expect(m).toContain('upgrades/1.3.1362.md verbatim from the tarball');
  });
  it('fragmentReleasedIn: content lines and H2 titles must appear in the guide; the H1 title and comments are ignored', () => {
    const frag = '# A title the assembler replaces\n\n<!-- internal-only -->\n\n## What Changed\n\nFixed the thing.\nSecond line.\n';
    expect(fragmentReleasedIn(frag, '# Upgrade Guide — vNEXT\n\n## What Changed\n\nOther fix.\nFixed the thing.\nSecond line.\n')).toEqual({ ok: true, missing: [] });
    expect(fragmentReleasedIn(frag, '# Upgrade Guide\n\n## What Changed\n\nFixed the thing.\n')).toEqual({ ok: false, missing: ['Second line.'] });
    expect(fragmentReleasedIn('## A Custom Section\n\nFixed the thing.\n', '## What Changed\n\nFixed the thing.\n')).toEqual({ ok: false, missing: ['## A Custom Section'] });
  });
  const realPair = (() => {
    const r = spawnSync('git', ['-C', path.join(__dirname, '..', '..'), 'cat-file', '-e', '7cdc5d571:upgrades/next/threadline-core-push-config-alias.md'], { encoding: 'utf-8' });
    const g2 = spawnSync('git', ['-C', path.join(__dirname, '..', '..'), 'cat-file', '-e', '76d5a6098:upgrades/1.3.1362.md'], { encoding: 'utf-8' });
    return r.status === 0 && g2.status === 0;
  })();
  it.skipIf(!realPair)('fragmentReleasedIn holds on the REAL 1.3.1362 pair (fragment at gitHead 7cdc5d571 vs the released guide)', () => {
    const show = (spec: string) => execFileSync('git', ['-C', path.join(__dirname, '..', '..'), 'show', spec], { encoding: 'utf-8' });
    expect(fragmentReleasedIn(show('7cdc5d571:upgrades/next/threadline-core-push-config-alias.md'), show('76d5a6098:upgrades/1.3.1362.md')).ok).toBe(true);
  });
  it('remoteTagAheadOf finds the highest vX.Y.Z tag ahead of main, numerically', () => {
    const ls = ['abc\trefs/tags/v1.3.135', 'def\trefs/tags/v1.3.1361', 'aaa\trefs/tags/v1.3.1362', 'aaa\trefs/tags/v1.3.1362^{}', 'bbb\trefs/tags/not-a-version'].join('\n');
    expect(remoteTagAheadOf(ls, '1.3.1361')).toBe('1.3.1362');
    expect(remoteTagAheadOf(ls, '1.3.1362')).toBe(null);
    expect(remoteTagAheadOf('', '1.3.1361')).toBe(null);
    // numeric, not string: 1.3.1000 > 1.3.999
    expect(remoteTagAheadOf('a\trefs/tags/v1.3.999\nb\trefs/tags/v1.3.1000', '1.3.999')).toBe('1.3.1000');
  });
  it('inflightRefusal names the version, the worktree and both remedies', () => {
    const m = inflightRefusal({ version: '1.3.1362', startedAt: '2026-10-20T17:40:00Z', worktree: '/w/rel-1362' }, 'origin');
    expect(m).toContain('v1.3.1362 is in flight');
    expect(m).toContain('/w/rel-1362');
    expect(m).toContain('--push-only --remote origin');
    expect(m).toContain('--reconcile 1.3.1362');
    expect(m).toContain('Validating');
  });
  it('shouldClearInflightOnFailure: only this run\'s marker, and only when nothing can have reached npm', () => {
    expect(shouldClearInflightOnFailure({ wroteMarker: true, published: false, publishUnknown: false, npmPending: false })).toBe(true);
    expect(shouldClearInflightOnFailure({ wroteMarker: false, published: false, publishUnknown: false, npmPending: false })).toBe(false);
    expect(shouldClearInflightOnFailure({ wroteMarker: true, published: true, publishUnknown: false, npmPending: false })).toBe(false);
    expect(shouldClearInflightOnFailure({ wroteMarker: true, published: false, publishUnknown: true, npmPending: false })).toBe(false);
    expect(shouldClearInflightOnFailure({ wroteMarker: true, published: false, publishUnknown: false, npmPending: true })).toBe(false);
  });
  it('bumpVersionJson sets package and lock-root versions; a no-op bump is byte-identical', () => {
    const pkg = JSON.stringify({ name: 'instar', version: '1.0.0', dependencies: { a: '^1' } }, null, 2) + '\n';
    expect(bumpVersionJson(pkg, '1.0.0')).toBe(pkg);
    expect(JSON.parse(bumpVersionJson(pkg, '1.0.1')).version).toBe('1.0.1');
    const lock = JSON.stringify({ name: 'instar', version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/a': { version: '1.0.0' } } }, null, 2) + '\n';
    const out = JSON.parse(bumpVersionJson(lock, '1.0.1', { lock: true }));
    expect(out.version).toBe('1.0.1');
    expect(out.packages[''].version).toBe('1.0.1');
    expect(out.packages['node_modules/a'].version).toBe('1.0.0');
  });
});

describe('--reconcile <version>: rebuild a published-but-never-landed cut from npm and land it (real CLI, bare remote, fake registry)', () => {
  const ROOT_REPO = path.join(__dirname, '..', '..');
  let tmp: string;
  let bare: string;
  let clone: string;
  let bin: string;
  let gitHead: string;
  const GUIDE = '# Upgrade Guide — v1.0.1\n\n## What Changed\n\nFixed the thing that broke in 1.0.0.\n\nThe notes npm actually shipped.\n';
  const g = (cwd: string, ...args: string[]) => {
    const r = runner(cwd)('git', args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    fs.writeFileSync(path.join(clone, rel), body);
  };
  const pkg = (v: string) => JSON.stringify({ name: 'instar', version: v }, null, 2) + '\n';
  const lock = (v: string) => JSON.stringify({ name: 'instar', version: v, lockfileVersion: 3, packages: { '': { name: 'instar', version: v } } }, null, 2) + '\n';

  /** npm stand-in: `npm view`, `npm pack` against a fake registry holding 1.0.1. */
  function shim({ latest = '1.0.1', has101 = true, head = () => gitHead, guide = GUIDE } = {}) {
    // (re)build the tarball with the given guide
    const pkgDir = path.join(tmp, 'registry', 'package', 'upgrades');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, '1.0.1.md'), guide);
    execFileSync('tar', ['-czf', path.join(tmp, 'registry', 'instar-1.0.1.tgz'), '-C', path.join(tmp, 'registry'), 'package']);
    const tgzDir = path.join(tmp, 'registry');
    const script = [
      '#!/bin/sh',
      `if [ "$1" = view ] && [ "$2" = instar ] && [ "$3" = version ]; then echo ${latest}; exit 0; fi`,
      `if [ "$1" = view ] && [ "$2" = "instar@1.0.1" ] && [ "$3" = version ]; then ${has101 ? 'echo 1.0.1; exit 0' : 'echo "npm error code E404" >&2; exit 1'}; fi`,
      `if [ "$1" = view ] && [ "$2" = "instar@1.0.1" ] && [ "$3" = gitHead ]; then echo ${head()}; exit 0; fi`,
      `if [ "$1" = pack ] && [ "$2" = "instar@1.0.1" ]; then cp "${tgzDir}/instar-1.0.1.tgz" "$4/"; echo '[{"filename":"instar-1.0.1.tgz"}]'; exit 0; fi`,
      'echo "npm error code E404" >&2; exit 1',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(bin, 'npm'), script);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-local-reconcile-'));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    g(tmp, 'init', '--bare', '--initial-branch=main', bare);
    g(tmp, 'clone', '-q', bare, clone);
    for (const f of ['scripts/release-local.mjs', 'scripts/lib/release-local-steps.mjs', 'scripts/release-cut-diff.mjs']) {
      write(f, fs.readFileSync(path.join(ROOT_REPO, f), 'utf-8'));
    }
    write('package.json', pkg('1.0.0'));
    write('package-lock.json', lock('1.0.0'));
    write('upgrades/1.0.0.md', '# 1.0.0\n');
    write('upgrades/next/consumed.md', '# a fix that shipped in 1.0.1\n\n## What Changed\n\nFixed the thing that broke in 1.0.0.\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'merge: the fix that 1.0.1 was built from');
    gitHead = g(clone, 'rev-parse', 'HEAD'); // what `npm view instar@1.0.1 gitHead` reports
    // After 1.0.1 was published (and never landed), another PR merged with its own fragment.
    write('upgrades/next/later.md', '# a later fix, NOT in 1.0.1\n');
    write('src/later.ts', 'export const later = 1;\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'merge: a later fix');
    g(clone, 'push', '-q', 'origin', 'HEAD:main');
    fs.mkdirSync(path.join(tmp, 'tmpdir'));
    shim(); // also builds the published tarball
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function cli(...args: string[]) {
    const r = spawnSync(process.execPath, [path.join(clone, 'scripts', 'release-local.mjs'), ...args], {
      cwd: clone,
      env: { ...ENV, PATH: `${bin}:${process.env.PATH}`, INSTAR_RELEASE_LOCAL_VIEW_DELAY_MS: '0', TMPDIR: path.join(tmp, 'tmpdir') },
      encoding: 'utf-8',
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }
  const markerPath = () => path.join(clone, '.git', 'release-local-inflight.json');
  const writeMarker = (version: string) => fs.writeFileSync(markerPath(), JSON.stringify({ version, startedAt: '2026-10-20T17:40:00Z', worktree: '/w/rel-x' }));

  it('a real run refuses while THIS clone has a release in flight, even when npm shows no newer version (the Validating case)', () => {
    shim({ latest: '1.0.0' }); // npm still reports the old latest
    writeMarker('1.0.1');
    const before = g(bare, 'rev-parse', 'main');
    const r = cli('--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain('npm shows no unfinished release');
    expect(r.out).toContain('v1.0.1 is in flight');
    expect(r.out).toContain('/w/rel-x');
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    expect(g(clone, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(markerPath())).toBe(true); // a refusal never clears someone else's marker
  });

  it('a real run refuses while the remote has a v* tag ahead of main, even when npm shows no newer version', () => {
    shim({ latest: '1.0.0' });
    g(clone, 'tag', 'v1.0.1');
    g(clone, 'push', '-q', 'origin', 'v1.0.1');
    g(clone, 'tag', '-d', 'v1.0.1');
    const r = cli('--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain("origin has tag v1.0.1 but main's package.json is 1.0.0");
    expect(r.out).toContain('--reconcile 1.0.1');
  });

  it('a real release run refuses while npm is ahead of main, naming the version and both remedies; nothing changes', () => {
    const before = g(bare, 'rev-parse', 'main');
    const r = cli('--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain("instar@1.0.1 is on npm but main's package.json is 1.0.0");
    expect(r.out).toContain('--reconcile 1.0.1 --remote origin');
    expect(r.out).toContain('--push-only --remote origin');
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('--reconcile 1.0.1 rebuilds the cut from the tarball + gitHead and lands it with hooks on', () => {
    // a pre-commit hook proves the commit ran with hooks
    const marker = path.join(tmp, 'precommit-ran');
    const hook = path.join(clone, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    fs.chmodSync(hook, 0o755);
    writeMarker('1.0.1');
    const r = cli('--reconcile', '1.0.1', '--remote', 'origin');
    expect(r.out).toContain('removed 1 fragment(s) consumed at');
    expect(r.status).toBe(0);
    expect(fs.existsSync(markerPath())).toBe(false); // landing clears the marker
    expect(fs.readdirSync(path.join(tmp, 'tmpdir'))).toEqual([]); // the tarball dir is removed
    expect(fs.existsSync(marker)).toBe(true);
    const head = g(clone, 'rev-parse', 'HEAD');
    expect(g(bare, 'rev-parse', 'main')).toBe(head);
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.1 [skip ci]');
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(head);
    expect(g(bare, 'show', 'main:upgrades/1.0.1.md') + '\n').toBe(GUIDE); // verbatim
    const files = g(bare, 'ls-tree', '--name-only', 'main:upgrades/next').split('\n');
    expect(files).toEqual(['later.md']); // consumed fragment gone, the later one kept
    expect(JSON.parse(g(bare, 'show', 'main:package.json')).version).toBe('1.0.1');
    expect(JSON.parse(g(bare, 'show', 'main:package-lock.json')).packages[''].version).toBe('1.0.1');
    expect(g(bare, 'show', 'main:src/later.ts')).toBe('export const later = 1;');
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('refuses to delete a fragment edited on main after the publish (blob differs from gitHead), naming it', () => {
    write('upgrades/next/consumed.md', '# a fix that shipped in 1.0.1\n\n## What Changed\n\nFixed the thing that broke in 1.0.0.\nPLUS an edit made on main after 1.0.1 was built.\n');
    g(clone, 'commit', '-qam', 'edit the fragment after the publish');
    g(clone, 'push', '-q', 'origin', 'HEAD:main');
    const r = cli('--reconcile', '1.0.1', '--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain('upgrades/next/consumed.md changed on main after instar@1.0.1 was built');
    expect(g(clone, 'status', '--porcelain')).toBe('');
    expect(fs.readdirSync(path.join(tmp, 'tmpdir'))).toEqual([]);
  });

  it('refuses to delete a fragment whose text is NOT in the released guide, naming it', () => {
    shim({ guide: '# Upgrade Guide — v1.0.1\n\n## What Changed\n\nSomething else entirely.\n' });
    const r = cli('--reconcile', '1.0.1', '--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain('upgrades/next/consumed.md is not in the released upgrades/1.0.1.md');
    expect(r.out).toContain('Fixed the thing that broke in 1.0.0.');
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('refuses when npm does not have the version; the tree stays clean', () => {
    shim({ has101: false });
    const r = cli('--reconcile', '1.0.1', '--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain('only rebuilds a version npm shows');
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it("refuses when the version's gitHead is not on main's history", () => {
    shim({ head: () => 'deadbeef'.repeat(5) });
    const r = cli('--reconcile', '1.0.1', '--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain("not in main's history");
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('refuses when main is not behind the version (nothing to reconcile)', () => {
    const r = cli('--reconcile', '1.0.0', '--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain('nothing to reconcile');
  });

  it('a hook refusal of the rebuilt commit keeps the rebuilt cut and points at --push-only (the version IS on npm); nothing is pushed', () => {
    const hook = path.join(clone, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "PRECOMMIT SAYS NO" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const before = g(bare, 'rev-parse', 'main');
    const r = cli('--reconcile', '1.0.1', '--remote', 'origin');
    expect(r.status).toBe(1);
    expect(r.out).toContain('PRECOMMIT SAYS NO');
    expect(r.out).toContain('the release commit was NOT made');
    expect(r.out).toContain('--push-only --remote origin');
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    // the rebuilt cut is still in the tree, so --push-only can commit it once the hook passes
    expect(fs.readFileSync(path.join(clone, 'upgrades', '1.0.1.md'), 'utf-8')).toBe(GUIDE);
    fs.writeFileSync(path.join(clone, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const resumed = cli('--push-only', '--remote', 'origin');
    expect(resumed.status).toBe(0);
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.1 [skip ci]');
  });

  it('consumedFragmentsAt lists upgrades/next/ at a commit', () => {
    expect(consumedFragmentsAt(runner(clone), gitHead)).toEqual({ ok: true, paths: ['upgrades/next/consumed.md'] });
    expect(consumedFragmentsAt(runner(clone), 'HEAD').paths.sort()).toEqual(['upgrades/next/consumed.md', 'upgrades/next/later.md']);
  });
});

describe('--push-only resumes a release that failed between publish and commit (real CLI, bare remote)', () => {
  // Echo #2225 blocker. Both failure points leave the SAME state — npm has the
  // version, the release cut is in the working tree, HEAD is still main:
  //   (a) the post-publish smoke test failed;
  //   (b) a pre-commit hook refused the release commit.
  // Each test builds that state, then runs the REAL CLI's --push-only to
  // completion against a bare remote. A PATH shim answers `npm view`.
  const ROOT_REPO = path.join(__dirname, '..', '..');
  let tmp: string;
  let bare: string;
  let clone: string;
  let bin: string;
  const g = (cwd: string, ...args: string[]) => {
    const r = runner(cwd)('git', args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    fs.writeFileSync(path.join(clone, rel), body);
  };
  const pkg = (v: string) => JSON.stringify({ name: 'instar', version: v, dependencies: { a: '^1.0.0' } }, null, 2) + '\n';
  const lock = (v: string) => JSON.stringify({ name: 'instar', version: v, lockfileVersion: 3, packages: { '': { name: 'instar', version: v } } }, null, 2) + '\n';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-local-resume-'));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');
    bin = path.join(tmp, 'bin');
    g(tmp, 'init', '--bare', '--initial-branch=main', bare);
    g(tmp, 'clone', '-q', bare, clone);
    for (const f of ['scripts/release-local.mjs', 'scripts/lib/release-local-steps.mjs', 'scripts/release-cut-diff.mjs']) {
      write(f, fs.readFileSync(path.join(ROOT_REPO, f), 'utf-8'));
    }
    write('package.json', pkg('1.0.0'));
    write('package-lock.json', lock('1.0.0'));
    write('upgrades/1.0.0.md', '# 1.0.0\n');
    write('upgrades/next/fix.md', '# a fix\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'base: a merged fix with its fragment');
    g(clone, 'push', '-q', 'origin', 'HEAD:main');
    // npm shim: instar@1.0.1 is on the registry (it was published).
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = view ] && [ "$2" = "instar@1.0.1" ]; then echo 1.0.1; exit 0; fi\necho "npm error code E404" >&2; exit 1\n');
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** What steps 6-7 leave in the tree: the release cut for 1.0.1, uncommitted. */
  function releaseCutInTree() {
    write('package.json', pkg('1.0.1'));
    write('package-lock.json', lock('1.0.1'));
    fs.renameSync(path.join(clone, 'upgrades/next/fix.md'), path.join(clone, 'upgrades/1.0.1.md'));
  }
  function pushOnly() {
    const r = spawnSync(process.execPath, [path.join(clone, 'scripts', 'release-local.mjs'), '--push-only', '--remote', 'origin'], {
      cwd: clone,
      env: { ...ENV, PATH: `${bin}:${process.env.PATH}`, INSTAR_RELEASE_LOCAL_VIEW_DELAY_MS: '0' },
      encoding: 'utf-8',
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }
  function assertLanded() {
    const head = g(clone, 'rev-parse', 'HEAD');
    expect(g(bare, 'rev-parse', 'main')).toBe(head);
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.1 [skip ci]');
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(head);
    expect(g(clone, 'status', '--porcelain')).toBe('');
  }

  it('(a) smoke failed after publish: --push-only commits the cut (hooks on) and lands it', () => {
    releaseCutInTree(); // publish succeeded, smoke failed → fail() before any commit
    fs.writeFileSync(path.join(clone, '.git', 'release-local-inflight.json'), JSON.stringify({ version: '1.0.1' }));
    const r = pushOnly();
    expect(fs.existsSync(path.join(clone, '.git', 'release-local-inflight.json'))).toBe(false);
    expect(r.out).toContain('exactly the release cut for v1.0.1');
    expect(r.status).toBe(0);
    assertLanded();
  });

  it('(b) a pre-commit hook refused the release commit: --push-only stops while it still refuses, then lands once fixed', () => {
    releaseCutInTree();
    const block = path.join(tmp, 'BLOCK');
    fs.writeFileSync(block, '');
    const hook = path.join(clone, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ -f "${block}" ]; then echo "PRECOMMIT SAYS NO" >&2; exit 1; fi\nexit 0\n`);
    fs.chmodSync(hook, 0o755);
    // The release's own commit is refused (what step 12 hit):
    g(clone, 'add', 'package.json', 'package-lock.json', 'upgrades/');
    expect(runner(clone)('git', ['commit', '-m', 'chore: release v1.0.1 [skip ci]']).status).not.toBe(0);
    const before = g(bare, 'rev-parse', 'main');
    // Resume while the hook still refuses: stops, pushes nothing, keeps the tree.
    const stuck = pushOnly();
    expect(stuck.status).toBe(1);
    expect(stuck.out).toContain('PRECOMMIT SAYS NO');
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    expect(g(clone, 'status', '--porcelain')).not.toBe('');
    // Fix the cause, resume again: lands.
    fs.rmSync(block);
    const r = pushOnly();
    expect(r.status).toBe(0);
    assertLanded();
  });

  it('--push-only clears only the marker for the version it landed', () => {
    releaseCutInTree();
    const m = path.join(clone, '.git', 'release-local-inflight.json');
    fs.writeFileSync(m, JSON.stringify({ version: '9.9.9' }));
    expect(pushOnly().status).toBe(0);
    expect(JSON.parse(fs.readFileSync(m, 'utf-8')).version).toBe('9.9.9');
  });

  it('refuses a dirty tree that is NOT exactly a release cut', () => {
    releaseCutInTree();
    write('scripts/extra.mjs', 'export {};\n');
    const r = pushOnly();
    expect(r.status).toBe(1);
    expect(r.out).toContain('not exactly a release cut');
  });

  it('refuses to commit a cut for a version npm does not show yet — PENDING (npm review), never "nothing was published"', () => {
    write('package.json', pkg('1.0.2'));
    write('package-lock.json', lock('1.0.2'));
    fs.renameSync(path.join(clone, 'upgrades/next/fix.md'), path.join(clone, 'upgrades/1.0.2.md'));
    const before = g(bare, 'rev-parse', 'main');
    const r = pushOnly();
    expect(r.status).toBe(1);
    expect(r.out).toContain('NOT visible on npm');
    expect(r.out).toContain('"Validating" review');
    expect(r.out).toContain('https://www.npmjs.com/package/instar?activeTab=versions');
    expect(r.out).toContain('Do NOT publish again');
    expect(r.out).toContain('do not use --push-only; re-run release-local normally');
    expect(r.out).toContain('--push-only --remote origin');
    expect(r.out).not.toContain('Nothing was published');
    expect(g(clone, 'log', '-1', '--format=%s')).toBe('base: a merged fix with its fragment');
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('a committed release whose version npm does not show yet: --push-only keeps refusing (pending), then lands once npm shows it', () => {
    write('package.json', pkg('1.0.2'));
    write('package-lock.json', lock('1.0.2'));
    fs.renameSync(path.join(clone, 'upgrades/next/fix.md'), path.join(clone, 'upgrades/1.0.2.md'));
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'chore: release v1.0.2 [skip ci]');
    const before = g(bare, 'rev-parse', 'main');
    const pending = pushOnly();
    expect(pending.status).toBe(1);
    expect(pending.out).toContain('refuses until then');
    expect(pending.out).toContain('was never published (for example the publish step itself failed)');
    expect(pending.out).toContain('Otherwise (published, still in review): Do NOT publish again');
    expect(pending.out).toContain('"Validating" review');
    expect(pending.out).not.toContain('Nothing was published');
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    // npm's review finishes: the registry now shows 1.0.2.
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = view ] && [ "$2" = "instar@1.0.2" ]; then echo 1.0.2; exit 0; fi\necho "npm error code E404" >&2; exit 1\n');
    const r = pushOnly();
    expect(r.status).toBe(0);
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.2 [skip ci]');
    expect(g(bare, 'rev-parse', 'v1.0.2^{commit}')).toBe(g(clone, 'rev-parse', 'HEAD'));
  });
});

describe('release-local.mjs wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'release-local.mjs'), 'utf-8');
  it('uses the atomic push, refreshes gate refs before publishing, and resolves a failed publish against npm', () => {
    expect(src).toContain('pushReleaseAtomically({');
    expect(src).toContain('publishedStateAfterFailure({');
    const firstRefresh = src.indexOf('refreshGateBaseRefs(quietRun)');
    const publish = src.indexOf("run('npm', ['publish'");
    expect(firstRefresh).toBeGreaterThan(-1);
    expect(firstRefresh).toBeLessThan(publish);
  });
  it('checks publish.yml runs in preflight AND just before publish, and an unknown answer stops a real run', () => {
    const preflight = src.indexOf("checkCiRuns(slug, 'preflight')");
    const again = src.indexOf("checkCiRuns(SLUG, 'just before publish')");
    const npmCi = src.indexOf("must('npm', ['ci'");
    const publish = src.indexOf("run('npm', ['publish'");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(npmCi);
    expect(again).toBeGreaterThan(npmCi);
    expect(again).toBeLessThan(publish);
    const fn = src.slice(src.indexOf('function checkCiRuns('), src.indexOf('// ── reconcile:'));
    expect(fn).toContain('ciGateAction({ state: verdict.state, dryRun: opts.dryRun, allowUnverified: opts.allowUnverifiedCi })');
    expect(fn.trim().endsWith('fail(what);\n}') || /fail\(what\);\s*\}\s*$/.test(fn)).toBe(true);
  });
  it('decides the OTP question before anything is mutated, and publish can never wait on a prompt', () => {
    const otp = src.indexOf('otpRequirement(');
    const npmCi = src.indexOf("must('npm', ['ci'");
    expect(otp).toBeGreaterThan(-1);
    expect(otp).toBeLessThan(npmCi);
    expect(src).toMatch(/run\('npm', \['publish'[^\n]*\{ noStdin: true, quiet: true, timeoutMs: PUBLISH_TIMEOUT_MS \}/);
    expect(src).toMatch(/const PUBLISH_TIMEOUT_MS = \d+ \* 60 \* 1000;/);
    expect(src).toMatch(/timeout: timeoutMs,/);
  });
  it('passes a CAPTURING runner to the push logic (it reads rev-parse output)', () => {
    expect(src).toContain('pushReleaseAtomically({ run: quietRun,');
    expect(src).not.toMatch(/pushReleaseAtomically\(\{ run(,| ,|: run,)/);
  });
  it('a dry run exercises the npm auth + OTP preflight (warns where a real run stops)', () => {
    const block = src.slice(src.indexOf("step('Preflight: npm auth (npm whoami)')") - 400, src.indexOf('// ── 1-2. install + build'));
    expect(block).not.toMatch(/if \(!opts\.dryRun\) \{\s*step\('Preflight: npm auth/);
    expect(block).toContain("const stopOrWarn = (msg) => { if (opts.dryRun) console.log(");
    expect(block.match(/stopOrWarn\(/g)?.length).toBe(2);
  });
  it('a [skip ci] HEAD does not stop the release — the fragment check decides', () => {
    const pre = src.slice(src.indexOf("if (subject.includes('[skip ci]')) {"), src.indexOf('START_SHA = head;'));
    expect(pre).not.toContain('stopCleanly(');
    expect(pre).not.toContain('fail(');
  });
  it('--keep-tag-on-published prints the reachable-tags note', () => {
    const flow = src.slice(src.indexOf('if (opts.pushOnly) {'), src.indexOf('// ── 0. preflight'));
    expect(flow).toMatch(/if \(opts\.keepTagOnPublished\) \{\s*console\.log\(`\\nNOTE: tag v\$\{version\} is on the published commit, which is NOT in main's history/);
    expect(flow).toContain('release-skip-annotate.mjs');
  });
  it('the dirty-tree preflight tolerates tool files only with the flag, and fails otherwise', () => {
    expect(src).toContain('if (opts.allowDirtyToolFiles && check.ok) {');
    expect(src).toMatch(/if \(opts\.allowDirtyToolFiles && !opts\.dryRun\) \{[^\n]*process\.exit\(2\)/);
  });
  it('between publish and commit, a failure prints the uncommitted-cut recovery (not "keep the commit and tag")', () => {
    const failFn = src.slice(src.indexOf('function fail('), src.indexOf('function stopCleanly('));
    expect(failFn).toMatch(/\} else if \(published && !committed\) \{/);
    expect(failFn.indexOf('published && !committed')).toBeLessThan(failFn.indexOf('} else if (published) {'));
    expect(failFn).toContain('git add package.json package-lock.json upgrades/ && git commit -m "chore: release v${v} [skip ci]"');
    // smoke stays before the commit (publish.yml order), and `committed` is set only after the commit
    const publish = src.indexOf("run('npm', ['publish'");
    const smoke = src.indexOf("run('node', ['scripts/post-publish-smoke.mjs'");
    const commit = src.indexOf("must('git', ['commit', '-m', `chore: release v${VERSION} [skip ci]`]);");
    const flag = src.indexOf('committed = true;', commit);
    expect(publish).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(commit);
    expect(flag).toBeGreaterThan(commit);
    const commitLine = "must('git', ['commit', '-m', `chore: release v${VERSION} [skip ci]`]);";
    expect(src.slice(commit + commitLine.length, flag).trim()).toBe('');
  });
  it('a smoke failure is judged by one registry read and a pending verdict sets npmPending', () => {
    const smoke = src.slice(src.indexOf("const smoke = run('node', ['scripts/post-publish-smoke.mjs', VERSION]);"), src.indexOf('// ── 12. commit'));
    expect(smoke).toContain('smokeFailureVerdict(seen');
    expect(smoke).toContain('if (verdict.pending) npmPending = true;');
    expect(smoke).toContain('retries: 0');
    const failFn = src.slice(src.indexOf('function fail('), src.indexOf('function stopCleanly('));
    const pendingBranch = failFn.slice(failFn.indexOf('if (npmPending)'), failFn.indexOf('} else if (publishUnknown)'));
    expect(pendingBranch).toContain('--push-only');
    expect(pendingBranch).not.toContain('restoreTree');
    expect(pendingBranch).not.toContain('Nothing was published');
    expect(failFn.indexOf('if (npmPending)')).toBeLessThan(failFn.indexOf('} else if (publishUnknown)'));
  });
  it('unknown is pending on the smoke path but publishUnknown in --push-only — deliberately, and both are documented', () => {
    const smoke = src.slice(src.indexOf("const smoke = run('node', ['scripts/post-publish-smoke.mjs', VERSION]);"), src.indexOf('// ── 12. commit'));
    expect(smoke).toContain('deliberately unlike --push-only');
    const flow = src.slice(src.indexOf('if (opts.pushOnly) {'), src.indexOf('// ── 0. preflight'));
    expect(flow.match(/if \((st|state) === 'unknown'\) publishUnknown = true;/g)?.length).toBe(2);
    expect(flow).toContain('deliberately different from the smoke path');
    expect(flow.match(/npmPendingNotice\('instar', [^)]*\{ pushOnly: true \}\)/g)?.length).toBe(2);
  });
  it('the in-flight marker is written after the dry-run exit and right before npm publish; fail() clears it only when safe', () => {
    const dryExit = src.indexOf("stopCleanly('Dry run: tree restored.");
    const write = src.indexOf('writeInflight(VERSION);');
    const publish = src.indexOf("run('npm', ['publish'");
    expect(dryExit).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(dryExit);
    expect(write).toBeLessThan(publish);
    const failFn = src.slice(src.indexOf('function fail('), src.indexOf('function stopCleanly('));
    expect(failFn).toContain('shouldClearInflightOnFailure({ wroteMarker: wroteInflight, published, publishUnknown, npmPending })');
    expect(src).toContain("clearInflight(VERSION);");
  });
  it("the preflight's npm view uses the same npm auth args as --reconcile", () => {
    expect(src).toContain("run('npm', ['view', 'instar', 'version', '--prefer-online', ...npmAuthArgs]");
  });
  it('a timed-out publish is passed to the registry check as timed out', () => {
    expect(src).toContain('timedOut: Boolean(pub.timedOut)');
  });
  it('the build runs with NODE_ENV=development, like the install', () => {
    expect(src).toMatch(/must\('npm', \['run', 'build'\], \{ env: \{ \.\.\.process\.env, NODE_ENV: 'development' \} \}\)/);
  });
  it('--push-only lands only a version already on npm, and never publishes', () => {
    const flow = src.slice(src.indexOf('if (opts.pushOnly) {'), src.indexOf('// ── 0. preflight'));
    expect(flow).toContain('publishedStateAfterFailure(');
    expect(flow.indexOf('publishedStateAfterFailure(')).toBeLessThan(flow.indexOf('push({'));
    expect(flow).not.toContain("'publish'");
    expect(flow).toContain('process.exit(0)');
  });
  it('argument guards', () => {
    const script = path.join(__dirname, '..', '..', 'scripts', 'release-local.mjs');
    const a = spawnSync(process.execPath, [script, '--keep-tag-on-published'], { encoding: 'utf-8' });
    expect(a.status).toBe(2);
    const b = spawnSync(process.execPath, [script, '--push-only', '--dry-run'], { encoding: 'utf-8' });
    expect(b.status).toBe(2);
    const d = spawnSync(process.execPath, [script, '--reconcile', 'latest'], { encoding: 'utf-8' });
    expect(d.status).toBe(2);
    const e = spawnSync(process.execPath, [script, '--reconcile', '1.2.3', '--dry-run'], { encoding: 'utf-8' });
    expect(e.status).toBe(2);
    const c = spawnSync(process.execPath, [script, '--allow-dirty-tool-files'], { encoding: 'utf-8' });
    expect(c.status).toBe(2);
    expect(c.stderr).toContain('--dry-run only');
  });
  it('an UNKNOWN publish state stops without restoring the tree or claiming nothing was published', () => {
    const failFn = src.slice(src.indexOf('function fail('), src.indexOf('function stopCleanly('));
    const unknownBranch = failFn.slice(failFn.indexOf('if (publishUnknown)'), failFn.indexOf('} else if (published)'));
    expect(unknownBranch).toContain('UNKNOWN');
    expect(unknownBranch).not.toContain('restoreTree');
    expect(unknownBranch).not.toContain('Nothing was published');
    expect(src).toMatch(/state === 'published'[\s\S]*?published = true/);
  });
});
