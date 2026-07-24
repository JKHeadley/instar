import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveJoinDir, isGitCloneUrl } from '../../src/commands/joinDir.js';

describe('resolveJoinDir — honors --dir for git URLs (§1.3 fix)', () => {
  it('git URL + --dir → the resolved --dir (THE FIX: was ignored, forced <cwd>/<repoName>)', () => {
    expect(resolveJoinDir('https://github.com/JKHeadley/instar.git', { dir: '/tmp/mmtest2' }))
      .toBe(path.resolve('/tmp/mmtest2'));
  });

  it('git URL + no --dir → <cwd>/<repoName> (historical default, UNCHANGED)', () => {
    expect(resolveJoinDir('https://github.com/JKHeadley/instar.git', {}))
      .toBe(path.resolve('instar'));
  });

  it('git@ SSH URL + --dir → the resolved --dir', () => {
    expect(resolveJoinDir('git@github.com:JKHeadley/instar.git', { dir: '/tmp/home' }))
      .toBe(path.resolve('/tmp/home'));
  });

  it('git@ SSH URL + no --dir → <cwd>/<repoName> (UNCHANGED)', () => {
    expect(resolveJoinDir('git@github.com:JKHeadley/instar.git', {}))
      .toBe(path.resolve('instar'));
  });

  it('non-git (tunnel) URL + --dir → the resolved --dir', () => {
    expect(resolveJoinDir('https://echo-mini.dawn-tunnel.dev', { dir: '/tmp/x' }))
      .toBe(path.resolve('/tmp/x'));
  });

  it('non-git (tunnel) URL + no --dir → process.cwd() (UNCHANGED)', () => {
    expect(resolveJoinDir('https://echo-mini.dawn-tunnel.dev', {}))
      .toBe(process.cwd());
  });

  it('a relative --dir is resolved to an absolute path', () => {
    expect(resolveJoinDir('https://github.com/x/y.git', { dir: 'sub/dir' }))
      .toBe(path.resolve('sub/dir'));
    expect(path.isAbsolute(resolveJoinDir('https://github.com/x/y.git', { dir: 'sub/dir' }))).toBe(true);
  });
});

describe('isGitCloneUrl — git-URL vs tunnel/local discrimination', () => {
  it('github.com URL → true', () => expect(isGitCloneUrl('https://github.com/a/b')).toBe(true));
  it('.git URL → true', () => expect(isGitCloneUrl('https://example.com/a/b.git')).toBe(true));
  it('git@ SSH → true', () => expect(isGitCloneUrl('git@github.com:a/b.git')).toBe(true));
  it('tunnel http URL → false', () => expect(isGitCloneUrl('https://echo-mini.dawn-tunnel.dev')).toBe(false));
  it('local non-git path → false', () => expect(isGitCloneUrl('/tmp/some/dir')).toBe(false));
});
