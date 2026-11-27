// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test fixture setup — builds a throwaway "remote" repository for the helper's clone.
/**
 * Tier-1, against real git and no network: the helper's own clone
 * (docs/specs/local-verify-borrowed-slices-count.md, C item 4 and Build decisions "History on the
 * helper"). A throwaway repository on disk stands in for the pinned GitHub repository. Proven
 * here: the clone holds commit history without file contents until they are needed; the merge of
 * `baseSha` and `headSha` is built with the run machine's own command and hashes the same; a
 * conflict is reported as one; and the exported files are exactly the hashed tree, whatever git's
 * export attributes say.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { BareCloneTreeSource } from '../../../../src/localVerify/helper/hostTree.js';
import { extractTar } from '../../../../src/localVerify/helper/testBypassDriver.js';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const raw = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root = '';
let remote = '';
let url = '';
const C: Record<'base0' | 'base' | 'feature' | 'conflicting' | 'baseLater', string> = { base0: '', base: '', feature: '', conflicting: '', baseLater: '' };

async function drain(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks);
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvhosttree-')));
  remote = path.join(root, 'remote');
  fs.mkdirSync(remote);
  raw(remote, ['init', '--quiet', '-b', 'main']);
  // What GitHub allows: a filtered (partial) fetch, and a fetch of a commit by its id.
  raw(remote, ['config', 'uploadpack.allowFilter', 'true']);
  raw(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(remote, f)), { recursive: true }); fs.writeFileSync(path.join(remote, f), text); };
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  write('.gitattributes', 'secret.txt export-ignore\nstamp.txt export-subst\n');
  write('secret.txt', 'kept in the tree\n');
  write('stamp.txt', '$Format:%H$\n');
  raw(remote, ['add', '-A']);
  raw(remote, ['commit', '--quiet', '-m', 'base0']);
  C.base0 = raw(remote, ['rev-parse', 'HEAD']);
  // Our own branch: edits a.ts.
  raw(remote, ['checkout', '--quiet', '-b', 'feature']);
  write('src/a.ts', 'export const a = 2;\n');
  write('tests/unit/new.test.ts', "it('new', () => {});\n");
  raw(remote, ['add', '-A']);
  raw(remote, ['commit', '--quiet', '-m', 'feature']);
  C.feature = raw(remote, ['rev-parse', 'HEAD']);
  // main moves on: edits b.ts (no conflict with the branch).
  raw(remote, ['checkout', '--quiet', 'main']);
  write('src/b.ts', 'export const b = 2;\n');
  raw(remote, ['commit', '--quiet', '-am', 'main moves']);
  C.base = raw(remote, ['rev-parse', 'HEAD']);
  // Another branch and a later main that both edit a.ts differently: a conflict.
  raw(remote, ['checkout', '--quiet', '-b', 'conflicting', C.base0]);
  write('src/a.ts', 'export const a = 3;\n');
  raw(remote, ['commit', '--quiet', '-am', 'conflicting']);
  C.conflicting = raw(remote, ['rev-parse', 'HEAD']);
  raw(remote, ['checkout', '--quiet', 'main']);
  write('src/a.ts', 'export const a = 4;\n');
  raw(remote, ['commit', '--quiet', '-am', 'main edits a']);
  C.baseLater = raw(remote, ['rev-parse', 'HEAD']);
  // Like a pull request's head on GitHub: reachable by id, on no branch the clone follows.
  raw(remote, ['update-ref', 'refs/pull/1/head', C.feature]);
  raw(remote, ['update-ref', 'refs/pull/2/head', C.conflicting]);
  raw(remote, ['branch', '--quiet', '-D', 'feature', 'conflicting']);
  url = `file://${remote}`;
});

afterAll(() => { if (root) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'hostTree.test.ts' }); });

const source = (name: string) => { const bare = path.join(root, name, 'repo.git'); return { bare, src: new BareCloneTreeSource(bare) }; };

describe('the helper\'s clone: history without file contents until needed', () => {
  it('fetches both commits with their history into a partial clone, and holds no file contents yet', async () => {
    const { bare, src } = source('partial');
    await src.fetch(url, [C.base, C.feature]);
    expect(raw(bare, ['config', '--get', 'remote.origin.promisor'])).toBe('true');
    expect(raw(bare, ['config', '--get', 'remote.origin.partialclonefilter'])).toBe('blob:none');
    // Full history: the merge base (the first commit) is present though neither commit named it. A one-commit-deep fetch would not have it.
    expect(raw(bare, ['merge-base', C.base, C.feature])).toBe(C.base0);
    expect(fs.existsSync(path.join(bare, 'shallow'))).toBe(false);
    // No file contents: every file of the base tree is reported missing.
    const missing = raw(bare, ['rev-list', '--objects', '--missing=print', '--no-walk', `${C.base}^{tree}`]).split('\n').filter((l) => l.startsWith('?'));
    expect(missing.length).toBeGreaterThanOrEqual(5);
  });

  it('a clone of another repository, or a leftover that is not a clone, is replaced by a clone of the pinned one', async () => {
    const { bare, src } = source('replaced');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n'); // the reviewer's "only HEAD" leftover
    await src.fetch(url, [C.base]);
    expect(raw(bare, ['cat-file', '-t', C.base])).toBe('commit');
    expect(fs.readFileSync(`${bare}.instar-helper-origin`, 'utf-8').trim()).toBe(url);
    await expect(src.fetch(url, ['not-a-commit'])).rejects.toThrow('not commit ids');
    await expect(src.fetch(url, ['f'.repeat(40)])).rejects.toThrow('fetch failed');
  });
});

describe('the merge tree, built on the helper', () => {
  it('equals the run machine\'s merge of the same two commits; the same commit twice is that commit\'s own tree', async () => {
    const { src } = source('merge');
    await src.fetch(url, [C.base, C.feature]);
    const m = await src.mergeTree(C.base, C.feature);
    // The run machine's command (orchestrator.ts), run in the full repository.
    const theirs = raw(remote, ['merge-tree', '--write-tree', C.base, C.feature]).split('\n')[0];
    expect(m).toEqual({ tree: theirs });
    expect(await src.mergeTree(C.base, C.base)).toEqual({ tree: raw(remote, ['rev-parse', `${C.base}^{tree}`]) });
    // The merge has both sides' work: the branch's a.ts and new test, main's b.ts.
    const tree = (m as { tree: string }).tree;
    expect(await src.read(tree, 'src/a.ts')).toBe('export const a = 2;\n');
    expect(await src.read(tree, 'src/b.ts')).toBe('export const b = 2;\n');
    expect((await src.entries(tree)).map((e) => e.path)).toContain('tests/unit/new.test.ts');
    expect(await src.read(tree, 'nope.ts')).toBeNull();
    // It is neither commit's own tree.
    expect(tree).not.toBe(raw(remote, ['rev-parse', `${C.feature}^{tree}`]));
    expect(tree).not.toBe(raw(remote, ['rev-parse', `${C.base}^{tree}`]));
  });

  it('a merge that conflicts is reported as a conflict, not as a tree and not as an error', async () => {
    const { src } = source('conflict');
    await src.fetch(url, [C.baseLater, C.conflicting]);
    expect(await src.mergeTree(C.baseLater, C.conflicting)).toEqual({ conflict: true });
    // The other side: the same later main merges cleanly with itself.
    expect('tree' in await src.mergeTree(C.baseLater, C.baseLater)).toBe(true);
    await expect(src.mergeTree(C.baseLater, 'f'.repeat(40))).rejects.toThrow('merge-tree failed');
    await expect(src.mergeTree('x', C.baseLater)).rejects.toThrow('not commit ids');
  });
});

describe('the export: exactly the hashed tree', () => {
  it('writes every file of the merge tree byte for byte, ignoring export-ignore and export-subst, with no .git', async () => {
    const { bare, src } = source('export');
    await src.fetch(url, [C.base, C.feature]);
    const m = await src.mergeTree(C.base, C.feature) as { tree: string };
    const out = path.join(root, 'export', 'files');
    fs.mkdirSync(out, { recursive: true });
    const n = extractTar(await drain(await src.archive(m.tree)), out);
    const listed = (await src.entries(m.tree)).map((e) => e.path).sort();
    expect(n).toBe(listed.length);
    expect(listed).toEqual(['.gitattributes', 'secret.txt', 'src/a.ts', 'src/b.ts', 'stamp.txt', 'tests/unit/new.test.ts']);
    // `git archive` would drop secret.txt and rewrite stamp.txt; this export does neither.
    expect(fs.readFileSync(path.join(out, 'secret.txt'), 'utf-8')).toBe('kept in the tree\n');
    expect(fs.readFileSync(path.join(out, 'stamp.txt'), 'utf-8')).toBe('$Format:%H$\n');
    expect(fs.existsSync(path.join(out, '.git'))).toBe(false);
    // Hash the written files back into a tree: it is the very tree the helper reports.
    const check = path.join(root, 'export', 'check');
    fs.mkdirSync(check);
    raw(check, ['init', '--quiet']);
    raw(check, ['--work-tree', out, 'add', '-A', '-f']);
    expect(raw(check, ['write-tree'])).toBe(m.tree);
    // The file contents arrived for the export, in the clone; none is missing now.
    expect(raw(bare, ['rev-list', '--objects', '--missing=print', '--no-walk', m.tree]).split('\n').filter((l) => l.startsWith('?'))).toEqual([]);
  });
});
