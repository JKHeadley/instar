import { describe, it, expect } from 'vitest';
import {
  porcelainPath,
  isResiduePath,
  classifyPorcelain,
  makeWorktreeDirtyCheck,
  DEFAULT_RESIDUE_DENYLIST,
} from '../../src/core/worktreeDirtyCheck.js';

describe('worktreeDirtyCheck — porcelainPath', () => {
  it('strips the 2-char status + space', () => {
    expect(porcelainPath(' M src/a.ts')).toBe('src/a.ts');
    expect(porcelainPath('?? new.txt')).toBe('new.txt');
    expect(porcelainPath('A  staged.ts')).toBe('staged.ts');
  });
  it('takes the destination of a rename', () => {
    expect(porcelainPath('R  old.ts -> new.ts')).toBe('new.ts');
  });
  it('unquotes a quoted path', () => {
    expect(porcelainPath(' M "with space.ts"')).toBe('with space.ts');
  });
  it('returns empty for a too-short line', () => {
    expect(porcelainPath('M')).toBe('');
  });
});

describe('worktreeDirtyCheck — isResiduePath', () => {
  const dl = DEFAULT_RESIDUE_DENYLIST;
  it('matches a denylisted directory prefix', () => {
    expect(isResiduePath('dist/bundle.js', dl)).toBe(true);
    expect(isResiduePath('node_modules/x/y.js', dl)).toBe(true);
  });
  it('matches a nested denylisted dir', () => {
    expect(isResiduePath('packages/a/dist/x.js', dl)).toBe(true);
  });
  it('matches a *.ext glob', () => {
    expect(isResiduePath('server.log', dl)).toBe(true);
    expect(isResiduePath('tsconfig.tsbuildinfo', dl)).toBe(true);
  });
  it('does NOT match real source', () => {
    expect(isResiduePath('src/core/Foo.ts', dl)).toBe(false);
    expect(isResiduePath('README.md', dl)).toBe(false);
  });
});

describe('worktreeDirtyCheck — classifyPorcelain (both sides)', () => {
  const dl = DEFAULT_RESIDUE_DENYLIST;
  it('clean tree → false', () => {
    expect(classifyPorcelain('', dl)).toBe(false);
    expect(classifyPorcelain('\n', dl)).toBe(false);
  });
  it('a real source change → true', () => {
    expect(classifyPorcelain(' M src/a.ts', dl)).toBe(true);
  });
  it('untracked real file → true', () => {
    expect(classifyPorcelain('?? src/new.ts', dl)).toBe(true);
  });
  it('ONLY build residue → false (no junk revives)', () => {
    expect(classifyPorcelain(' M dist/bundle.js\n?? coverage/lcov.info\n M app.log', dl)).toBe(false);
  });
  it('residue + one real change → true', () => {
    expect(classifyPorcelain(' M dist/bundle.js\n M src/real.ts', dl)).toBe(true);
  });
});

describe('worktreeDirtyCheck — makeWorktreeDirtyCheck (deps + fail-open + cache)', () => {
  const fakeRealpath = (p: string): string => p; // identity for tests
  it('dirty worktree → true (wired to readGit, not a no-op)', () => {
    let calls = 0;
    const check = makeWorktreeDirtyCheck({
      readGit: () => { calls++; return ' M src/a.ts'; },
      realpath: fakeRealpath,
      now: () => 1000,
    });
    expect(check('/wt')).toBe(true);
    expect(calls).toBe(1); // proves it actually called git
  });
  it('clean worktree → false', () => {
    const check = makeWorktreeDirtyCheck({ readGit: () => '', realpath: fakeRealpath });
    expect(check('/wt')).toBe(false);
  });
  it('fail-open: readGit throws (git error/timeout) → false', () => {
    const check = makeWorktreeDirtyCheck({
      readGit: () => { throw new Error('timeout'); },
      realpath: fakeRealpath,
    });
    expect(check('/wt')).toBe(false);
  });
  it('fail-open: realpath throws (ELOOP / missing) → false, never calls git', () => {
    let gitCalls = 0;
    const check = makeWorktreeDirtyCheck({
      readGit: () => { gitCalls++; return ' M x'; },
      realpath: () => { throw new Error('ELOOP'); },
    });
    expect(check('/wt')).toBe(false);
    expect(gitCalls).toBe(0);
  });
  it('rejects a resolved path that begins with "-" (cannot become a git option)', () => {
    let gitCalls = 0;
    const check = makeWorktreeDirtyCheck({
      readGit: () => { gitCalls++; return ' M x'; },
      realpath: () => '-rf',
    });
    expect(check('/wt')).toBe(false);
    expect(gitCalls).toBe(0);
  });
  it('caches within the TTL (second call within 30s does NOT re-spawn git)', () => {
    let calls = 0;
    let clock = 1000;
    const check = makeWorktreeDirtyCheck({
      readGit: () => { calls++; return ' M src/a.ts'; },
      realpath: fakeRealpath,
      now: () => clock,
    });
    expect(check('/wt')).toBe(true);
    clock = 1000 + 29_000; // still within 30s
    expect(check('/wt')).toBe(true);
    expect(calls).toBe(1); // cache hit — only one git call
    clock = 1000 + 31_000; // past TTL
    expect(check('/wt')).toBe(true);
    expect(calls).toBe(2); // re-checked after TTL
  });
});
