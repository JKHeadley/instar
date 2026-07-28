// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) tests for CartographerTree (cartographer-doc-tree-schema spec #1).
 * Uses a REAL temporary git repo fixture — staleness derivation is git-backed, so
 * the test exercises real `git ls-tree`/`rev-parse`, not a stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CartographerTree } from '../../src/core/CartographerTree.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function commitAll(repo: string, msg: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}

let repo: string;
let stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-repo-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  // a small source tree
  fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'core', 'Thing.ts'), 'export class Thing {}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n'); // not a leaf ext
  fs.mkdirSync(path.join(repo, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'junk', 'x.ts'), 'skip me\n');
  commitAll(repo, 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function tree(): CartographerTree {
  return new CartographerTree({ projectDir: repo, stateDir });
}

describe('CartographerTree.scaffold', () => {
  it('builds a hierarchy mirroring the dir tree, skipping skip-dirs', () => {
    const t = tree();
    const index = t.scaffold();
    const paths = Object.keys(index.nodes).sort();
    expect(paths).toContain('');               // root
    expect(paths).toContain('src');
    expect(paths).toContain('src/core');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/core/Thing.ts');
    // skip-dirs excluded
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    // non-leaf extension excluded as a file node
    expect(paths).not.toContain('README.md');
  });

  it('root node children include the top-level src dir', () => {
    const t = tree();
    t.scaffold();
    const root = t.getNode('');
    expect(root?.kind).toBe('dir');
    expect(root?.children).toContain('src');
  });

  it('fresh scaffold leaves every node never-authored (codeHash null)', () => {
    const t = tree();
    const index = t.scaffold();
    for (const e of Object.values(index.nodes)) {
      expect(e.codeHash).toBeNull();
      expect(e.summaryUpdatedAt).toBeNull();
    }
  });

  it('leaves no .tmp residue (atomic writes)', () => {
    const t = tree();
    t.scaffold();
    const nodesDir = path.join(stateDir, 'cartographer', 'nodes');
    expect(fs.readdirSync(nodesDir).some((f) => f.includes('.tmp'))).toBe(false);
  });
});

describe('collision-free slug', () => {
  it('paths "a/b" and a file literally named "a__b" get distinct node files', () => {
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'a', 'b', 'm.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(repo, 'a__b.ts'), 'export const c = 1;\n'); // would collide under /→__
    commitAll(repo, 'collision fixture');
    const t = tree();
    t.scaffold();
    const nA = t.getNode('a/b');
    const nB = t.getNode('a__b.ts');
    expect(nA).not.toBeNull();
    expect(nB).not.toBeNull();
    expect(nA?.path).toBe('a/b');
    expect(nB?.path).toBe('a__b.ts');
  });
});

describe('setSummary + staleness lifecycle', () => {
  it('never-authored before authoring', () => {
    const t = tree();
    t.scaffold();
    expect(t.computeStaleness('src/index.ts')).toBe('never-authored');
  });

  it('fresh immediately after authoring, then stale after the covered file changes', () => {
    const t = tree();
    t.scaffold();
    const node = t.setSummary('src/index.ts', 'entry point exporting `a`');
    expect(node.summary).toBe('entry point exporting `a`');
    expect(node.codeHash).not.toBeNull();
    expect(t.computeStaleness('src/index.ts')).toBe('fresh');

    // change the covered file + commit → its blob oid changes
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 2;\n');
    commitAll(repo, 'change index');
    expect(t.computeStaleness('src/index.ts')).toBe('stale');
  });

  it('a dir node goes stale when a descendant file changes (tree-oid propagation)', () => {
    const t = tree();
    t.scaffold();
    t.setSummary('src/core', 'core modules');
    expect(t.computeStaleness('src/core')).toBe('fresh');
    fs.writeFileSync(path.join(repo, 'src', 'core', 'Thing.ts'), 'export class Thing { x = 1; }\n');
    commitAll(repo, 'change Thing');
    expect(t.computeStaleness('src/core')).toBe('stale');
  });

  it('staleNodes reflects exactly the changed authored node', () => {
    const t = tree();
    t.scaffold();
    t.setSummary('src/index.ts', 's1');
    t.setSummary('src/core/Thing.ts', 's2');
    expect(t.staleNodes().filter((s) => s.status === 'stale')).toHaveLength(0);
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 99;\n');
    commitAll(repo, 'touch index');
    const stale = t.staleNodes().filter((s) => s.status === 'stale');
    expect(stale.map((s) => s.path)).toEqual(['src/index.ts']);
  });

  it('path-gone when the covered file is deleted from HEAD', () => {
    const t = tree();
    t.scaffold();
    t.setSummary('src/index.ts', 's');
    fs.rmSync(path.join(repo, 'src', 'index.ts'));
    commitAll(repo, 'rm index');
    expect(t.computeStaleness('src/index.ts')).toBe('path-gone');
  });

  it('setSummary on an unknown path throws (must scaffold first)', () => {
    const t = tree();
    t.scaffold();
    expect(() => t.setSummary('does/not/exist.ts', 'x')).toThrow();
  });
});

describe('safety bounds', () => {
  it('honors maxDepth', () => {
    fs.mkdirSync(path.join(repo, 'd1', 'd2', 'd3'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'd1', 'd2', 'd3', 'deep.ts'), 'export const d = 1;\n');
    commitAll(repo, 'deep');
    const t = new CartographerTree({ projectDir: repo, stateDir, maxDepth: 1 });
    const index = t.scaffold();
    const paths = Object.keys(index.nodes);
    expect(paths).toContain('d1');
    // d1/d2/d3/deep.ts is beyond depth 1 → not present
    expect(paths).not.toContain('d1/d2/d3/deep.ts');
  });

  it('symlink loop does not hang scaffold', () => {
    fs.mkdirSync(path.join(repo, 'loop'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'loop', 'a.ts'), 'export const x = 1;\n');
    try {
      fs.symlinkSync(path.join(repo, 'loop'), path.join(repo, 'loop', 'self'));
    } catch {
      return; // symlinks unsupported on this FS — skip
    }
    const t = tree();
    const index = t.scaffold(); // must terminate
    expect(Object.keys(index.nodes)).toContain('loop');
  });
});

describe('health', () => {
  it('reports node/authored/stale counts', () => {
    const t = tree();
    t.scaffold();
    let h = t.health();
    expect(h.nodeCount).toBeGreaterThan(0);
    expect(h.authoredCount).toBe(0);
    t.setSummary('src/index.ts', 's');
    h = t.health();
    expect(h.authoredCount).toBe(1);
    expect(h.staleCount).toBe(0);
  });
});
