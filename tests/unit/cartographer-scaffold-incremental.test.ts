/**
 * The boot scaffold must not rewrite the whole Cartographer tree synchronously
 * (docs/specs/main-loop-freeze-conversation-list.md; Echo Studio profile of
 * 2026-11-21 showed scaffoldChunked spending its time in sync readFileSync /
 * writeFileSync / renameSync of every node file on every boot).
 *
 * Bar: a re-scaffold of an unchanged tree writes no node file; a change writes
 * only the nodes it touched; each node's read-compare-write stays in one turn so a
 * concurrent setSummary can never be overwritten by a stale copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let root: string;
let projectDir: string;
let stateDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-incr-'));
  projectDir = path.join(root, 'proj');
  stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(projectDir, 'src', 'core'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(projectDir, 'src', 'core', `M${i}.ts`), `export const m${i} = ${i};\n`);
  fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export {};\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/cartographer-scaffold-incremental.test.ts' });
});

const opts = { chunkNodes: 5, onYield: () => new Promise<void>((r) => setImmediate(r)) };
const nodesDir = () => path.join(stateDir, 'cartographer', 'nodes');
const isNodeFile = (p: unknown) => String(p).startsWith(nodesDir());

describe('CartographerTree.scaffoldChunked is incremental and async', () => {
  it('a second scaffold of an unchanged tree rewrites no node file', async () => {
    const tree = new CartographerTree({ projectDir, stateDir });
    const first = await tree.scaffoldChunked(opts);
    expect(first.nodeCount).toBeGreaterThan(20);
    expect(tree.lastScaffoldUnchangedNodes).toBe(0);

    const writes = vi.spyOn(fs, 'writeFileSync');
    const second = await tree.scaffoldChunked(opts);
    expect(second.nodeCount).toBe(first.nodeCount);
    expect(tree.lastScaffoldUnchangedNodes).toBe(first.nodeCount);
    expect(writes.mock.calls.filter((c) => isNodeFile(c[0]))).toHaveLength(0);
  });

  it('a change rewrites only the nodes it touched', async () => {
    const tree = new CartographerTree({ projectDir, stateDir });
    const first = await tree.scaffoldChunked(opts);
    fs.writeFileSync(path.join(projectDir, 'src', 'core', 'New.ts'), 'export const n = 1;\n');

    const writes = vi.spyOn(fs, 'writeFileSync');
    const second = await tree.scaffoldChunked(opts);

    expect(second.nodeCount).toBe(first.nodeCount + 1);
    // The new file's node + its parent dir (whose children changed).
    expect(writes.mock.calls.filter((c) => isNodeFile(c[0]))).toHaveLength(2);
    expect(tree.lastScaffoldUnchangedNodes).toBe(first.nodeCount - 1);
    expect(tree.getNode('src/core/New.ts')?.kind).toBe('file');
    expect(tree.getNode('src/core')?.children).toContain('src/core/New.ts');
  });

  it('an authored summary written between two scaffold chunks survives the scaffold', async () => {
    const tree = new CartographerTree({ projectDir, stateDir });
    await tree.scaffoldChunked(opts);
    let wrote = false;
    await tree.scaffoldChunked({
      chunkNodes: 1,
      onYield: async () => {
        if (!wrote) { wrote = true; tree.setSummary('src/core/M7.ts', 'authored mid-scaffold', { codeHash: 'h', codeRev: 'r', deferIndexWrite: true }); }
        await new Promise<void>((r) => setImmediate(r));
      },
    });
    expect(wrote).toBe(true);
    expect(tree.getNode('src/core/M7.ts')?.summary).toBe('authored mid-scaffold');
  });

  it('a corrupt node file is rewritten, not trusted', async () => {
    const tree = new CartographerTree({ projectDir, stateDir });
    await tree.scaffoldChunked(opts);
    const victim = fs.readdirSync(nodesDir()).find((f) => f.endsWith('.json'))!;
    fs.writeFileSync(path.join(nodesDir(), victim), '{not json');
    await tree.scaffoldChunked(opts);
    expect(() => JSON.parse(fs.readFileSync(path.join(nodesDir(), victim), 'utf8'))).not.toThrow();
  });
});
