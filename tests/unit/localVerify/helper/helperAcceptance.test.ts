// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the pure parts of what a helper accepts (docs/specs/local-verify-borrowed-slices-count.md,
 * C items 2, 3 and 5) and its two host-side records: GitHub's pull-request listing read into a
 * verdict, each verdict's named refusal, the install-inputs comparison with local-path packages,
 * the dry-run record, and the index of installed-package sets. No network, no sandbox.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { headRefusal, judgeInstallInputs, localPackagePath, localPackagesUnchanged, readInstallInputs, treeHasNodeModules } from '../../../../src/localVerify/helper/acceptance.js';
import { GitHubCompareChecker, classifyPullListing, isRateLimited, type HeadVerdict, type TreeEntry } from '../../../../src/localVerify/helper/hostTree.js';
import { HelperDryRunStore } from '../../../../src/localVerify/helper/dryRunRecord.js';
import { HelperComparedStore } from '../../../../src/localVerify/helper/comparedFiles.js';
import { HelperPackageIndex, PACKAGE_SETS_MAX } from '../../../../src/localVerify/helper/packageCache.js';
import type { InstallInputFiles } from '../../../../src/localVerify/installInputs.js';
import { helperUninstallAt } from '../../../../src/commands/helper.js';
import { FakeSandboxDriver } from '../../../helpers/fakeSandboxDriver.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperAcceptance.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvacc-'))); dirs.push(d); return d; };

const HEAD = 'b'.repeat(40);
const REPO_ID = 4242;
const pull = (over: Record<string, unknown> = {}) => ({ number: 7, state: 'open', head: { sha: HEAD, repo: { id: REPO_ID } }, base: { repo: { id: REPO_ID } }, ...over });

describe('GitHub\'s pull-request listing → whose head it is', () => {
  it('ours: an open pull request with this head whose head and base repositories are the pinned one, by id', () => {
    expect(classifyPullListing([pull()], HEAD, REPO_ID)).toBe('ours');
    // Listed beside an unrelated closed pull request: still ours.
    expect(classifyPullListing([pull({ state: 'closed' }), pull()], HEAD, REPO_ID)).toBe('ours');
  });

  it('a fork (another head repository, same name or not), a closed pull request, a moved head, a missing head repository and no listing each read differently', () => {
    expect(classifyPullListing([pull({ head: { sha: HEAD, repo: { id: 999, full_name: 'JKHeadley/instar' } } })], HEAD, REPO_ID)).toBe('fork');
    expect(classifyPullListing([pull({ base: { repo: { id: 999 } } })], HEAD, REPO_ID)).toBe('fork');
    expect(classifyPullListing([pull({ state: 'closed' })], HEAD, REPO_ID)).toBe('closed');
    expect(classifyPullListing([pull({ head: { sha: 'c'.repeat(40), repo: { id: REPO_ID } } })], HEAD, REPO_ID)).toBe('moved');
    expect(classifyPullListing([pull({ head: { sha: HEAD, repo: null } })], HEAD, REPO_ID)).toBe('no-head-repo');
    expect(classifyPullListing([pull({ head: { sha: HEAD } })], HEAD, REPO_ID)).toBe('no-head-repo');
    expect(classifyPullListing([], HEAD, REPO_ID)).toBe('not-listed');
    // An id as a string is not the id.
    expect(classifyPullListing([pull({ head: { sha: HEAD, repo: { id: String(REPO_ID) } } })], HEAD, REPO_ID)).toBe('fork');
    // Something that is not a listing is unreadable, not "not listed".
    expect(classifyPullListing({ message: 'Not Found' }, HEAD, REPO_ID)).toBe('unreachable');
    expect(classifyPullListing([null], HEAD, REPO_ID)).toBe('unreachable');
  });

  it('each verdict has its own refusal; only "ours" has none', () => {
    const all: HeadVerdict[] = ['ours', 'fork', 'closed', 'moved', 'no-head-repo', 'not-listed', 'unreachable', 'rate-limited'];
    const reasons = all.map(headRefusal);
    expect(reasons).toEqual([null, 'head-fork', 'head-pr-closed', 'head-moved', 'head-repo-missing', 'head-not-ours', 'head-unknown', 'head-rate-limited']);
    expect(new Set(reasons).size).toBe(all.length);
    expect(headRefusal('something-new' as HeadVerdict)).toBe('head-unknown');
  });

  const respond = (routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>, seen: string[] = []) =>
    (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(`${String(url)} ${init?.headers?.Authorization ?? ''}`);
      const key = Object.keys(routes).find((k) => String(url).endsWith(k));
      if (!key) throw new Error(`unexpected url ${String(url)}`);
      const r = routes[key];
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers ?? {} });
    }) as unknown as typeof fetch;
  const reader = (routes: Parameters<typeof respond>[0], seen: string[] = [], token: string | null = 'tok') => new GitHubCompareChecker({ token: () => token, fetchImpl: respond(routes, seen) });
  const LIST = `/commits/${HEAD}/pulls?per_page=100`;

  it('the reader asks the repository for its id once, then the commit\'s pull requests, with the helper\'s token; no real network', async () => {
    const seen: string[] = [];
    const r = reader({ '/repos/o/r': { status: 200, body: { id: REPO_ID } }, [LIST]: { status: 200, body: [pull()] } }, seen);
    expect(await r.ownOpenHead('o/r', HEAD)).toBe('ours');
    expect(await r.ownOpenHead('o/r', HEAD)).toBe('ours');
    expect(seen).toEqual([
      'https://api.github.com/repos/o/r Bearer tok', `https://api.github.com/repos/o/r${LIST} Bearer tok`, `https://api.github.com/repos/o/r${LIST} Bearer tok`,
    ]);
  });

  it('unreachable, rate-limited (429, or 403 with no requests left or a retry-after), an error status, an unreadable id and a missing token all refuse, each as its own verdict', async () => {
    const id = { '/repos/o/r': { status: 200, body: { id: REPO_ID } } };
    expect(await reader({ ...id, [LIST]: { status: 429 } }).ownOpenHead('o/r', HEAD)).toBe('rate-limited');
    expect(await reader({ ...id, [LIST]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } }).ownOpenHead('o/r', HEAD)).toBe('rate-limited');
    expect(await reader({ ...id, [LIST]: { status: 403, headers: { 'retry-after': '60' } } }).ownOpenHead('o/r', HEAD)).toBe('rate-limited');
    // A plain 403 (the token lacks pull-request read) is not a limit: unknown.
    expect(await reader({ ...id, [LIST]: { status: 403, headers: { 'x-ratelimit-remaining': '4999' } } }).ownOpenHead('o/r', HEAD)).toBe('unreachable');
    expect(await reader({ ...id, [LIST]: { status: 500 } }).ownOpenHead('o/r', HEAD)).toBe('unreachable');
    expect(await reader({ ...id, [LIST]: { status: 404 } }).ownOpenHead('o/r', HEAD)).toBe('not-listed');
    expect(await reader({ ...id, [LIST]: { status: 422 } }).ownOpenHead('o/r', HEAD)).toBe('not-listed');
    expect(await reader({ '/repos/o/r': { status: 429 } }).ownOpenHead('o/r', HEAD)).toBe('rate-limited');
    expect(await reader({ '/repos/o/r': { status: 200, body: { id: 'x' } } }).ownOpenHead('o/r', HEAD)).toBe('unreachable');
    expect(await reader({}).ownOpenHead('o/r', HEAD)).toBe('unreachable'); // the fetch throws
    expect(await reader({ ...id, [LIST]: { status: 200, body: [pull()] } }, [], null).ownOpenHead('o/r', HEAD)).toBe('unreachable');
    expect(await reader(id).ownOpenHead('o/r', 'not-a-sha')).toBe('unreachable');
    expect(await reader(id).ownOpenHead('../x', HEAD)).toBe('unreachable');
    // The merged check tells a limit from other unknowns too.
    const cmp = `/compare/main...${HEAD}`;
    expect(await reader({ [cmp]: { status: 429 } }).isOnMain('o/r', HEAD)).toBe('rate-limited');
    expect(await reader({ [cmp]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } }).isOnMain('o/r', HEAD)).toBe('rate-limited');
    expect(await reader({ [cmp]: { status: 403 } }).isOnMain('o/r', HEAD)).toBeNull();
    expect(isRateLimited(403, new Headers())).toBe(false);
  });
});

describe('install inputs: the merge tree against the merged commit', () => {
  const entry = (p: string, content: string): TreeEntry => ({ mode: '100644', object: crypto.createHash('sha1').update(content).digest('hex'), path: p });
  const tree = (files: Record<string, string>) => ({ entries: Object.entries(files).map(([p, c]) => entry(p, c)), read: async (f: string) => files[f] ?? null });
  const inputs = async (files: Record<string, string>): Promise<InstallInputFiles> => { const t = tree(files); return readInstallInputs(t.entries, t.read); };
  const pkg = (deps: Record<string, string>, version = '1.0.0') => JSON.stringify({ name: 'x', version, dependencies: deps });
  const lock = (pkgs: Record<string, unknown>, version = '1.0.0') => JSON.stringify({ name: 'x', version, lockfileVersion: 3, packages: { '': { name: 'x', version }, ...pkgs } });
  const BASE = { 'package.json': pkg({ a: '1.0.0' }), 'package-lock.json': lock({ 'node_modules/a': { version: '1.0.0' } }), '.husky/pre-commit': 'npm test\n', 'scripts/fix-better-sqlite3.cjs': '// fix\n', 'src/a.ts': 'a' };
  const judge = async (base: Record<string, string>, merged: Record<string, string>, sameCommit = false) =>
    judgeInstallInputs({ base: await inputs(base), merged: await inputs(merged), baseEntries: tree(base).entries, mergeEntries: tree(merged).entries, sameCommit });

  it('reads package.json, the lock, .npmrc and every file under the listed install-step paths, and nothing else', async () => {
    const i = await inputs({ ...BASE, '.npmrc': 'save-exact=true\n', '.husky/_/h': 'x' });
    expect(i.npmrc).toBe('save-exact=true\n');
    expect(i.stepFiles.map((f) => f.path).sort()).toEqual(['.husky/_/h', '.husky/pre-commit', 'scripts/fix-better-sqlite3.cjs']);
    expect((await inputs(BASE)).npmrc).toBeNull();
  });

  it('equal inputs give the cache key; a source-only change is equal; only the version fields may differ', async () => {
    const same = await judge(BASE, { ...BASE, 'src/a.ts': 'changed', 'src/new.ts': 'n' });
    expect(same.ok).toBe(true);
    const release = await judge(BASE, { ...BASE, 'package.json': pkg({ a: '1.0.0' }, '1.0.1'), 'package-lock.json': lock({ 'node_modules/a': { version: '1.0.0' } }, '1.0.1') });
    expect(release).toEqual(same);
  });

  it('a different package list, lock, .npmrc, hook or install script, in either direction, differs', async () => {
    for (const edit of [
      { 'package.json': pkg({ a: '1.0.0', b: '2.0.0' }) }, { 'package-lock.json': lock({ 'node_modules/a': { version: '1.0.1' } }) },
      { '.npmrc': 'registry=https://evil.example/\n' }, { '.husky/pre-commit': 'curl evil\n' }, { '.husky/post-merge': 'x\n' }, { 'scripts/fix-better-sqlite3.cjs': '// other\n' },
    ] as Array<Record<string, string>>) {
      expect(await judge(BASE, { ...BASE, ...edit }), JSON.stringify(edit)).toEqual({ ok: false, why: 'hash-differs' });
      expect(await judge({ ...BASE, ...edit }, BASE), `reverse ${JSON.stringify(edit)}`).toEqual({ ok: false, why: 'hash-differs' });
    }
  });

  it('a file that does not parse, or is missing, refuses with the side it is on', async () => {
    expect(await judge(BASE, { ...BASE, 'package.json': '{' })).toEqual({ ok: false, why: 'merge-tree:package-json-malformed' });
    const noLock: Record<string, string> = { ...BASE }; delete noLock['package-lock.json'];
    expect(await judge(BASE, noLock)).toEqual({ ok: false, why: 'merge-tree:package-lock-missing' });
    expect(await judge(noLock, BASE)).toEqual({ ok: false, why: 'base:package-lock-missing' });
    // A merged commit whose own inputs do not parse cannot be installed from either.
    expect(await judge({ ...BASE, 'package.json': '[]' }, { ...BASE, 'package.json': '[]' }, true)).toEqual({ ok: false, why: 'base:package-json-malformed' });
    expect((await judge(BASE, BASE, true)).ok).toBe(true);
  });

  const LOCAL = {
    ...BASE,
    'package.json': pkg({ a: '1.0.0', lx: 'file:./vendor/lx' }),
    'package-lock.json': lock({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/lx': { resolved: 'vendor/lx', link: true }, 'vendor/lx': { version: '1.0.0' } }),
    'vendor/lx/package.json': '{"name":"lx"}', 'vendor/lx/index.js': 'module.exports = 1;\n',
  };

  it('a local-path package must be on the merged commit and identical in the merge tree', async () => {
    expect((await judge(LOCAL, { ...LOCAL, 'src/a.ts': 'changed' })).ok).toBe(true);
    expect(await judge(LOCAL, { ...LOCAL, 'vendor/lx/index.js': 'evil' })).toEqual({ ok: false, why: 'local-package-changed' });
    expect(await judge(LOCAL, { ...LOCAL, 'vendor/lx/postinstall.js': 'evil' })).toEqual({ ok: false, why: 'local-package-changed' });
    const gone: Record<string, string> = { ...LOCAL }; delete gone['vendor/lx/index.js'];
    expect(await judge(LOCAL, gone)).toEqual({ ok: false, why: 'local-package-changed' });
    // Declared at the merged commit but its folder is not there: nothing to compare with, refuse.
    const hollow: Record<string, string> = { ...LOCAL }; delete hollow['vendor/lx/package.json']; delete hollow['vendor/lx/index.js'];
    expect(await judge(hollow, hollow)).toEqual({ ok: false, why: 'local-package-changed' });
    // A neighbour whose name only starts the same is not the package's folder.
    expect((await judge(LOCAL, { ...LOCAL, 'vendor/lx-other/index.js': 'x' })).ok).toBe(true);
    // The merged commit itself is its own reference.
    expect((await judge(LOCAL, LOCAL, true)).ok).toBe(true);
  });

  it('a local path that cannot be named inside the repository refuses: absolute, home, outside the repository, workspaces', () => {
    expect(localPackagePath('package.json dependencies lx file:./vendor/lx')).toBe('vendor/lx');
    expect(localPackagePath('package.json dependencies lx link:vendor/lx/')).toBe('vendor/lx');
    expect(localPackagePath('package-lock.json packages vendor/lx')).toBe('vendor/lx');
    expect(localPackagePath('package-lock.json resolved node_modules/lx file:vendor/lx.tgz')).toBe('vendor/lx.tgz');
    expect(localPackagePath('package-lock.json link node_modules/lx')).toBe('none');
    for (const d of ['package.json dependencies lx file:../outside', 'package.json dependencies lx file:/etc/x', 'package.json dependencies lx ~/x', 'package.json workspaces',
      'package.json dependencies lx workspace:*', 'package-lock.json packages ../sibling', 'package.json dependencies lx file:.', 'something else']) {
      expect(localPackagePath(d), d).toBeNull();
    }
    const e = tree(LOCAL).entries;
    expect(localPackagesUnchanged(['package.json dependencies lx file:../outside'], e, e)).toBe(false);
    expect(localPackagesUnchanged(['package.json workspaces'], e, e)).toBe(false);
    expect(localPackagesUnchanged([], e, [])).toBe(true);
  });

  it('a tree with its own top-level node_modules is seen, as a folder, a file or a link; a nested one is not that', () => {
    const e = (p: string): TreeEntry => ({ mode: '100644', object: 'a'.repeat(40), path: p });
    expect(treeHasNodeModules([e('src/a.ts'), e('node_modules/x/index.js')])).toBe(true);
    expect(treeHasNodeModules([e('node_modules')])).toBe(true);
    expect(treeHasNodeModules([e('tests/fixtures/app/node_modules/x.js'), e('node_modules_backup/x')])).toBe(false);
  });
});

describe('the helper\'s own dry-run record', () => {
  const IMG = { imageDigest: 'sha256:one', settingsHash: 'set-one' };
  const C = 'c'.repeat(40);
  const A = 'tests/integration/a.test.ts', B = 'tests/integration/b.test.ts';
  /** Answered files as a dry-run slice reports them: each with its helper time and whether it passed there. */
  const ok = (...files: string[]) => files.map((file) => ({ file, ms: 1_000, passed: true }));

  it('is done for a lane only on the image it was made on; another lane, digest or settings hash is not it', () => {
    const dir = tmp();
    const s = new HelperDryRunStore(dir, () => Date.parse('2026-11-19T01:00:00.000Z'));
    expect(s.doneFor('integration', IMG)).toBe(false);
    expect(s.noteAnswered('integration', IMG, C, ok(A, B), [A, B])).toEqual({ lane: 'integration', ...IMG, commit: C, finishedAt: '2026-11-19T01:00:00.000Z', files: 2, passedFiles: 2, totalMs: 2_000, passedMs: 2_000, passedShare: 1 });
    expect(s.doneFor('integration', IMG)).toBe(true);
    expect(s.doneFor('e2e', IMG)).toBe(false);
    expect(s.doneFor('unit', IMG)).toBe(false);
    expect(s.doneFor('integration', { ...IMG, imageDigest: 'sha256:two' })).toBe(false);
    expect(s.doneFor('integration', { ...IMG, settingsHash: 'set-two' })).toBe(false);
    // Asked again later (a daily re-creation does not touch the file): still done.
    expect(new HelperDryRunStore(dir).doneFor('integration', IMG)).toBe(true);
  });

  it('is written only when every file of the lane was answered for one commit on one image, over as many slices and restarts as it takes', () => {
    const dir = tmp();
    const s = new HelperDryRunStore(dir);
    expect(s.noteAnswered('integration', IMG, C, ok(A), [A, B])).toBeNull();
    expect(s.get('integration')).toBeNull();
    expect(new HelperDryRunStore(dir).progress('integration')).toEqual({ commit: C, answered: 1 }); // survives a restart
    // A file outside the lane's list answers nothing.
    expect(new HelperDryRunStore(dir).noteAnswered('integration', IMG, C, ok('tests/unit/x.test.ts'), [A, B])).toBeNull();
    // Progress on another commit or another image starts again: a dry run is one pass.
    expect(s.noteAnswered('integration', IMG, 'd'.repeat(40), ok(B), [A, B])).toBeNull();
    expect(s.progress('integration')).toEqual({ commit: 'd'.repeat(40), answered: 1 });
    expect(s.noteAnswered('integration', { ...IMG, imageDigest: 'sha256:two' }, 'd'.repeat(40), ok(A), [A, B])).toBeNull();
    // The second file failed on the helper: the lane is done, and half of its time passed.
    expect(s.noteAnswered('integration', { ...IMG, imageDigest: 'sha256:two' }, 'd'.repeat(40), [{ file: B, ms: 1_000, passed: false }], [A, B])).toMatchObject({ imageDigest: 'sha256:two', commit: 'd'.repeat(40), files: 2, passedFiles: 1, totalMs: 2_000, passedMs: 1_000, passedShare: 0.5 });
    // An empty lane is never "done".
    expect(s.noteAnswered('e2e', IMG, C, [], [])).toBeNull();
    expect(s.get('e2e')).toBeNull();
  });

  it('a missing, unreadable or malformed file means no dry run is done; clear removes it', () => {
    const dir = tmp();
    const file = path.join(dir, 'state', 'local-verify', 'helper-dry-run.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const text of ['not json', '{"v":2,"lanes":{}}', JSON.stringify({ v: 1, lanes: { integration: { lane: 'e2e', ...IMG, commit: C, finishedAt: '2026-11-19T01:00:00.000Z' } } }),
      JSON.stringify({ v: 1, lanes: { integration: { lane: 'integration', ...IMG, commit: 'short', finishedAt: '2026-11-19T01:00:00.000Z' } } }),
      JSON.stringify({ v: 1, lanes: { integration: { lane: 'integration', imageDigest: '', settingsHash: 'x', commit: C, finishedAt: '2026-11-19T01:00:00.000Z' } } }),
      // A record without its time share (written before the lane-proven figure existed), or with one that cannot be: not a record.
      JSON.stringify({ v: 1, lanes: { integration: { lane: 'integration', ...IMG, commit: C, finishedAt: '2026-11-19T01:00:00.000Z' } } }),
      JSON.stringify({ v: 1, lanes: { integration: { lane: 'integration', ...IMG, commit: C, finishedAt: '2026-11-19T01:00:00.000Z', files: 2, passedFiles: 3, totalMs: 10, passedMs: 10, passedShare: 1 } } }),
      JSON.stringify({ v: 1, lanes: { integration: { lane: 'integration', ...IMG, commit: C, finishedAt: '2026-11-19T01:00:00.000Z', files: 2, passedFiles: 2, totalMs: 10, passedMs: 10, passedShare: 1.5 } } })]) {
      fs.writeFileSync(file, text);
      expect(new HelperDryRunStore(dir).doneFor('integration', IMG), text).toBe(false);
    }
    const s = new HelperDryRunStore(dir);
    s.noteAnswered('integration', IMG, C, ok(A), [A]);
    expect(s.records()).toHaveLength(1);
    // A well-formed record on disk is read back whole.
    expect(new HelperDryRunStore(dir).get('integration')).toMatchObject({ files: 1, passedFiles: 1, totalMs: 1_000, passedMs: 1_000, passedShare: 1 });
    s.clear();
    expect(fs.existsSync(file)).toBe(false);
    expect(s.doneFor('integration', IMG)).toBe(false);
  });
});

describe('the index of installed-package sets', () => {
  const h = (c: string) => c.repeat(64), sha = (c: string) => c.repeat(40);
  it('records which merged commit a set came from and its manifest digest, across restarts; a malformed record is refused', () => {
    const dir = tmp();
    let t = Date.parse('2026-11-19T01:00:00.000Z');
    const idx = new HelperPackageIndex(dir, () => t);
    expect(idx.get(h('a'))).toBeNull();
    expect(idx.record(h('a'), sha('1'), h('f'))).toEqual([]);
    expect(new HelperPackageIndex(dir).get(h('a'))).toMatchObject({ hash: h('a'), mergedCommit: sha('1'), manifestDigest: h('f') });
    expect(() => idx.record('nope', sha('1'), h('f'))).toThrow('malformed');
    expect(() => idx.record(h('a'), 'nope', h('f'))).toThrow('malformed');
    t += 1000;
    idx.remove(h('a'));
    expect(idx.list()).toEqual([]);
  });

  it(`keeps at most ${PACKAGE_SETS_MAX} sets and names the least recently used one for deletion`, () => {
    const dir = tmp();
    let t = Date.parse('2026-11-19T01:00:00.000Z');
    const idx = new HelperPackageIndex(dir, () => t);
    for (const c of ['a', 'b', 'c']) { expect(idx.record(h(c), sha('1'), h('f'))).toEqual([]); t += 1000; }
    idx.touch(h('a')); t += 1000; // a was used after b and c
    expect(idx.record(h('d'), sha('2'), h('e'))).toEqual([h('b')]);
    expect(idx.list().map((s) => s.hash).sort()).toEqual([h('a'), h('c'), h('d')]);
  });

  it('a missing or unreadable index means nothing is cached', () => {
    const dir = tmp();
    const file = path.join(dir, 'state', 'local-verify', 'helper-packages.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ broken');
    expect(new HelperPackageIndex(dir).list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ v: 1, sets: [{ hash: 'x' }, { hash: h('a'), mergedCommit: sha('1'), manifestDigest: h('f'), installedAt: 'x', lastUsedAt: 'x' }] }));
    expect(new HelperPackageIndex(dir).list().map((s) => s.hash)).toEqual([h('a')]);
  });
});

describe('instar helper uninstall', () => {
  it('lists and removes the dry-run record and the package index with everything else; without --yes it removes nothing', async () => {
    const dir = tmp();
    const lv = path.join(dir, 'state', 'local-verify');
    new HelperDryRunStore(dir).noteAnswered('unit', { imageDigest: 'sha256:one', settingsHash: 's' }, 'c'.repeat(40), [{ file: 'tests/unit/a.test.ts', ms: 10, passed: true }], ['tests/unit/a.test.ts']);
    new HelperComparedStore(dir).note({ imageDigest: 'sha256:one', settingsHash: 's', runnerVersion: 'hr1:x' }, 'unit', ['tests/unit/a.test.ts']);
    new HelperPackageIndex(dir).record('a'.repeat(64), 'c'.repeat(40), 'f'.repeat(64));
    const driver = new FakeSandboxDriver();
    const dry = await helperUninstallAt(dir, driver, false);
    expect(dry.join('\n')).toContain('the record of files it was compared on, the dry-run record and the list of installed package sets');
    expect(driver.calls).toEqual([]);
    expect(fs.existsSync(path.join(lv, 'helper-dry-run.json'))).toBe(true);
    expect(fs.existsSync(path.join(lv, 'helper-compared.json'))).toBe(true);
    await helperUninstallAt(dir, driver, true);
    expect(driver.calls).toEqual(['uninstall']);
    expect(fs.existsSync(path.join(lv, 'helper-dry-run.json'))).toBe(false);
    expect(fs.existsSync(path.join(lv, 'helper-packages.json'))).toBe(false);
    expect(fs.existsSync(path.join(lv, 'helper-compared.json'))).toBe(false);
  });
});
