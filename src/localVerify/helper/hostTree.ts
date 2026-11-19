/**
 * The helper's host-side view of the code it is asked to test
 * (docs/specs/local-verify-borrowed-slices-count.md, C items 1, 2 and 4):
 *  - GitHub is asked whether `baseSha` is reachable from `main` of the pinned repository (the
 *    compare API reports `identical` or `behind`), and whether `headSha` is the current head of an
 *    open pull request whose head repository IS the pinned repository, compared by repository id.
 *    Both with a read-only fine-grained token (contents: read, pull requests: read, on the one
 *    repository) held in the helper machine's secret store. The token stays on the host and never
 *    enters the sandbox.
 *  - The owner service keeps its own clone of the pinned repository: full commit history, file
 *    contents only when needed (a partial clone, `--filter=blob:none`). It builds the merge of the
 *    two commits there with `git merge-tree --write-tree` (which runs no code), and exports that
 *    tree as a plain file tree with no `.git`: a tar built here from `ls-tree` + `cat-file`, which
 *    reads no git attributes, so `export-ignore` and `export-subst` change nothing and the files
 *    in the sandbox are exactly the hashed tree.
 *
 * All are injected seams of HelperService (`HelperGitHubReader`, `HostTreeSource`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SafeGitExecutor } from '../../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { SecretStore } from '../../core/SecretStore.js';

export interface MergedOnMainChecker {
  readonly kind: string;
  /**
   * true: on main; false: not on main; `'rate-limited'`: GitHub limited the request
   * (→ `merged-rate-limited`); null: unknown for any other reason (→ `merged-unknown`).
   */
  isOnMain(repo: string, sha: string): Promise<boolean | null | 'rate-limited'>;
}

/**
 * What GitHub's listing says about a head commit (spec C item 2). Only `ours` is accepted; every
 * other value refuses, each with its own reason.
 */
export type HeadVerdict =
  /** An open pull request has this commit as its head, and its head and base repositories are the pinned one. */
  | 'ours'
  /** An open pull request has this head, from another repository. */
  | 'fork'
  /** A pull request has this head and is not open. */
  | 'closed'
  /** The commit belongs to a pull request whose head is now another commit. */
  | 'moved'
  /** An open pull request has this head and its head repository no longer exists. */
  | 'no-head-repo'
  /** No pull request lists the commit. */
  | 'not-listed'
  /** GitHub could not be reached, answered an error, or answered something unreadable. */
  | 'unreachable'
  /** GitHub limited the request. */
  | 'rate-limited';

export interface OpenPullChecker {
  /** Whether `headSha` is the current head of an open pull request from the pinned repository itself. Never throws. */
  ownOpenHead(repo: string, headSha: string): Promise<HeadVerdict>;
}

/** The GitHub reads a helper makes, behind one injectable seam (unit tests use a fake; nothing reaches the network). */
export type HelperGitHubReader = MergedOnMainChecker & OpenPullChecker;

/** The secret-store key holding the helper's read-only GitHub token (contents: read, pull requests: read). */
export const HELPER_GITHUB_TOKEN_KEY = 'localVerifyHelper.githubToken';

export function secretStoreToken(stateDir: string): () => string | null {
  return () => {
    try {
      const v = new SecretStore({ stateDir }).get(HELPER_GITHUB_TOKEN_KEY);
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch { return null; } // @silent-fallback-ok: no readable token makes every GitHub check unknown, which refuses
  };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/**
 * Read GitHub's "pull requests associated with a commit" listing for one head commit. Pure.
 * The listing is the only evidence: that GitHub serves the commit proves nothing.
 */
export function classifyPullListing(pulls: unknown, headSha: string, repoId: number): HeadVerdict {
  if (!Array.isArray(pulls)) return 'unreachable';
  let fork = false, noRepo = false, closed = false, any = false;
  for (const raw of pulls) {
    const p = obj(raw);
    if (!p) return 'unreachable';
    any = true;
    const head = obj(p.head);
    const base = obj(p.base);
    if (!head || head.sha !== headSha) continue;
    if (p.state !== 'open') { closed = true; continue; }
    const headRepo = obj(head.repo);
    if (!headRepo) { noRepo = true; continue; }
    const baseRepo = base ? obj(base.repo) : null;
    if (headRepo.id === repoId && baseRepo?.id === repoId) return 'ours';
    fork = true;
  }
  if (noRepo) return 'no-head-repo';
  if (fork) return 'fork';
  if (closed) return 'closed';
  return any ? 'moved' : 'not-listed';
}

/** GitHub's two ways of saying "slow down": 429, or 403 with the remaining-requests header at zero or a retry-after. */
export function isRateLimited(status: number, headers: { get(name: string): string | null }): boolean {
  if (status === 429) return true;
  return status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null);
}

export class GitHubCompareChecker implements HelperGitHubReader {
  readonly kind = 'github-compare';
  private readonly repoIds = new Map<string, number>();
  constructor(private readonly o: { token: () => string | null; fetchImpl?: typeof fetch; timeoutMs?: number }) {}

  private async get(url: string, token: string): Promise<Response | null> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 15_000);
    try {
      return await (this.o.fetchImpl ?? fetch)(url, {
        signal: ac.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'instar-helper' },
      });
    } catch { return null; } // @silent-fallback-ok: unreachable GitHub is unknown, which refuses
    finally { clearTimeout(t); }
  }

  async isOnMain(repo: string, sha: string): Promise<boolean | null | 'rate-limited'> {
    if (!REPO_RE.test(repo) || !SHA_RE.test(sha)) return null;
    const token = this.o.token();
    if (!token) return null;
    const r = await this.get(`https://api.github.com/repos/${repo}/compare/main...${sha}`, token);
    if (!r) return null;
    if (r.status === 404) return false;
    if (isRateLimited(r.status, r.headers)) return 'rate-limited';
    if (r.status !== 200) return null;
    try {
      const body = await r.json() as { status?: unknown };
      if (body.status === 'identical' || body.status === 'behind') return true;
      if (body.status === 'ahead' || body.status === 'diverged') return false;
      return null;
    } catch { return null; } // @silent-fallback-ok: an unreadable answer is unknown, which refuses
  }

  async ownOpenHead(repo: string, headSha: string): Promise<HeadVerdict> {
    if (!REPO_RE.test(repo) || !SHA_RE.test(headSha)) return 'unreachable';
    const token = this.o.token();
    if (!token) return 'unreachable';
    try {
      let repoId = this.repoIds.get(repo);
      if (repoId === undefined) {
        const rr = await this.get(`https://api.github.com/repos/${repo}`, token);
        if (!rr) return 'unreachable';
        if (isRateLimited(rr.status, rr.headers)) return 'rate-limited';
        if (rr.status !== 200) return 'unreachable';
        const id = (await rr.json() as { id?: unknown }).id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return 'unreachable';
        repoId = id;
        this.repoIds.set(repo, id); // a repository's id never changes
      }
      const r = await this.get(`https://api.github.com/repos/${repo}/commits/${headSha}/pulls?per_page=100`, token);
      if (!r) return 'unreachable';
      if (isRateLimited(r.status, r.headers)) return 'rate-limited';
      // GitHub does not know the commit in this repository: nothing lists it.
      if (r.status === 404 || r.status === 422) return 'not-listed';
      if (r.status !== 200) return 'unreachable';
      return classifyPullListing(await r.json(), headSha, repoId);
    } catch { return 'unreachable'; } // @silent-fallback-ok: an unreadable answer is unknown, which refuses
  }
}

export interface TreeEntry { mode: string; object: string; path: string }

/** The merge of two commits: its tree's hash, or a conflict (→ `merge-conflict`). */
export type MergeTreeResult = { tree: string } | { conflict: true };

export interface HostTreeSource {
  readonly kind: string;
  /** Fetch the commits, with their history and without file contents, into the owner service's clone. Runs no code. */
  fetch(repoUrl: string, shas: readonly string[]): Promise<void>;
  /**
   * The tree of the merge of `baseSha` and `headSha` (`git merge-tree --write-tree`, the command
   * the run machine uses, so the two hashes are comparable). The same commit twice is that
   * commit's own tree. Throws when the merge could not be computed at all.
   */
  mergeTree(baseSha: string, headSha: string): Promise<MergeTreeResult>;
  /** The files of a tree. `treeish` is a tree hash or a commit. */
  entries(treeish: string): Promise<TreeEntry[]>;
  read(treeish: string, file: string): Promise<string | null>;
  /** A tar of the tree's files (no `.git`), built without reading git attributes. */
  archive(treeish: string): Promise<Readable>;
}

function collect(child: ChildProcess, input?: string, timeoutMs?: number): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    timer?.unref?.();
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', () => { /* drained so a chatty git never blocks on a full pipe */ });
    child.stdin?.on('error', () => { /* @silent-fallback-ok: git exited before reading its input; its exit code reports it */ });
    child.on('error', () => { if (timer) clearTimeout(timer); resolve({ code: null, out: Buffer.alloc(0) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out: Buffer.concat(chunks) }); });
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
  });
}

/** Parse `git cat-file --batch` output into object → bytes. */
export function parseCatFileBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = buf.subarray(i, nl).toString('utf-8');
    const m = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(header);
    if (!m) { i = nl + 1; continue; }
    const size = Number(m[3]);
    out.set(m[1], buf.subarray(nl + 1, nl + 1 + size));
    i = nl + 1 + size + 1;
  }
  return out;
}

/** Parse `git ls-tree -r -z --full-tree` output. */
export function parseLsTree(buf: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const rec of buf.toString('utf-8').split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(rec);
    if (m && m[2] === 'blob') out.push({ mode: m[1], object: m[3], path: m[4] });
  }
  return out;
}

/** A minimal ustar archive (regular files and symlinks). Pure. */
export function buildTar(files: Array<{ path: string; mode: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const isLink = f.mode === '120000';
    let name = f.path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 155);
      if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for ustar: ${f.path}`);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 100, 'utf-8');
    h.write(`${f.mode === '100755' ? '0000755' : '0000644'}\0`, 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(`${(isLink ? 0 : f.data.length).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(isLink ? '2' : '0', 156, 1, 'ascii');
    if (isLink) h.write(f.data.toString('utf-8'), 157, 100, 'utf-8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    h.write(prefix, 345, 155, 'utf-8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(h);
    if (!isLink) {
      blocks.push(f.data);
      const pad = (512 - (f.data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** The file beside the clone that names the repository it was cloned from. */
const CLONE_URL_FILE = 'instar-helper-origin';

/**
 * The production tree source: the helper's own clone under its home, read through the git funnel.
 * A bare partial clone (`--filter=blob:none`): every commit and tree of `main` and of the fetched
 * heads, and a file's contents only once a merge or an export needs them.
 */
export class BareCloneTreeSource implements HostTreeSource {
  readonly kind = 'bare-clone';
  private readonly entryCache = new Map<string, TreeEntry[]>();
  constructor(private readonly bare: string) {}

  private git(args: string[]): string[] { return ['--git-dir', this.bare, ...args]; }

  private async ensure(repoUrl: string): Promise<void> {
    const marker = path.join(path.dirname(this.bare), `${path.basename(this.bare)}.${CLONE_URL_FILE}`);
    let cloned: string | null = null;
    try { cloned = fs.readFileSync(marker, 'utf-8').trim(); } catch { cloned = null; } // @silent-fallback-ok: no marker means no usable clone, which is made below
    if (cloned === repoUrl && fs.existsSync(path.join(this.bare, 'HEAD'))) return;
    // No clone yet, a clone of another repository, or the first design's one-commit-deep clone
    // (which cannot build a merge): start again from the pinned repository.
    await SafeFsExecutor.safeRm(this.bare, { recursive: true, force: true, operation: 'local-verify:helper-clone-reset' });
    this.entryCache.clear();
    fs.mkdirSync(path.dirname(this.bare), { recursive: true, mode: 0o700 });
    const r = await collect(SafeGitExecutor.spawn(['clone', '--quiet', '--bare', '--filter=blob:none', '--no-tags', '--single-branch', '--branch', 'main', repoUrl, this.bare], { operation: 'local-verify:helper-clone', cwd: path.dirname(this.bare) }), undefined, 30 * 60_000);
    if (r.code !== 0) throw new Error('clone failed');
    fs.writeFileSync(marker, `${repoUrl}\n`, { mode: 0o600 });
  }

  async fetch(repoUrl: string, shas: readonly string[]): Promise<void> {
    if (shas.length === 0 || !shas.every((x) => SHA_RE.test(x))) throw new Error('fetch: not commit ids');
    await this.ensure(repoUrl);
    const r = await collect(SafeGitExecutor.spawn(this.git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--filter=blob:none', 'origin', ...new Set(shas)]), { operation: 'local-verify:helper-fetch', cwd: this.bare }), undefined, 10 * 60_000);
    if (r.code !== 0) throw new Error('fetch failed');
  }

  async mergeTree(baseSha: string, headSha: string): Promise<MergeTreeResult> {
    if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) throw new Error('merge-tree: not commit ids');
    if (baseSha === headSha) {
      const r = await collect(SafeGitExecutor.readStream(this.git(['rev-parse', '--verify', '--quiet', `${baseSha}^{tree}`]), { operation: 'local-verify:helper-rev-parse', cwd: this.bare, timeout: 60_000 }));
      const tree = r.out.toString('utf-8').trim();
      if (r.code !== 0 || !SHA_RE.test(tree)) throw new Error('rev-parse failed');
      return { tree };
    }
    // The run machine's own command (orchestrator.ts), so both sides hash the same merge.
    const r = await collect(SafeGitExecutor.spawn(this.git(['merge-tree', '--write-tree', baseSha, headSha]), { operation: 'local-verify:helper-merge-tree', cwd: this.bare }), undefined, 10 * 60_000);
    const tree = r.out.toString('utf-8').split('\n')[0].trim();
    // git exits 1 for a conflict AND for a commit it cannot merge at all ("not something we can
    // merge"). Only a conflict prints the conflicted tree first; the other prints nothing.
    if (r.code === 1 && SHA_RE.test(tree)) return { conflict: true };
    if (r.code !== 0 || !SHA_RE.test(tree)) throw new Error('merge-tree failed');
    return { tree };
  }

  async entries(treeish: string): Promise<TreeEntry[]> {
    const cached = this.entryCache.get(treeish);
    if (cached) return cached;
    const r = await collect(SafeGitExecutor.readStream(this.git(['ls-tree', '-r', '-z', '--full-tree', treeish]), { operation: 'local-verify:helper-ls-tree', cwd: this.bare, timeout: 60_000 }));
    if (r.code !== 0) throw new Error('ls-tree failed');
    const list = parseLsTree(r.out);
    this.entryCache.set(treeish, list);
    if (this.entryCache.size > 4) this.entryCache.delete(this.entryCache.keys().next().value as string);
    return list;
  }

  /**
   * Bring the contents of these files into the clone in ONE fetch. Without it a partial clone
   * would ask the remote for each missing file separately, one request per file.
   */
  private async ensureBlobs(treeish: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const want = new Set(ids);
    const r = await collect(SafeGitExecutor.readStream(this.git(['rev-list', '--objects', '--missing=print', '--no-walk', treeish]), { operation: 'local-verify:helper-missing', cwd: this.bare, timeout: 5 * 60_000 }));
    if (r.code !== 0) throw new Error('rev-list failed');
    const missing = r.out.toString('utf-8').split('\n').filter((l) => l.startsWith('?')).map((l) => l.slice(1).trim()).filter((id) => SHA_RE.test(id) && want.has(id));
    if (missing.length === 0) return;
    const f = await collect(SafeGitExecutor.spawn(this.git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--filter=blob:none', '--stdin', 'origin']), { operation: 'local-verify:helper-fetch-contents', cwd: this.bare }), missing.join('\n') + '\n', 20 * 60_000);
    if (f.code !== 0) throw new Error('fetch of file contents failed');
  }

  private async objects(treeish: string, ids: string[]): Promise<Map<string, Buffer>> {
    if (ids.length === 0) return new Map();
    await this.ensureBlobs(treeish, ids);
    const r = await collect(SafeGitExecutor.readStream(this.git(['cat-file', '--batch']), { operation: 'local-verify:helper-cat-file', cwd: this.bare, timeout: 5 * 60_000 }), ids.join('\n') + '\n');
    if (r.code !== 0) throw new Error('cat-file failed');
    return parseCatFileBatch(r.out);
  }

  async read(treeish: string, file: string): Promise<string | null> {
    const e = (await this.entries(treeish)).find((x) => x.path === file);
    if (!e) return null;
    return (await this.objects(treeish, [e.object])).get(e.object)?.toString('utf-8') ?? null;
  }

  /**
   * Every file of the tree, byte for byte as git stores it. Built from `ls-tree` + `cat-file`,
   * never `git archive`: no attribute is read, so `export-ignore` drops nothing and `export-subst`
   * rewrites nothing. A file whose contents could not be read fails the export; it is never left out.
   */
  async archive(treeish: string): Promise<Readable> {
    const entries = await this.entries(treeish);
    const objs = await this.objects(treeish, [...new Set(entries.map((e) => e.object))]);
    const absent = entries.find((e) => !objs.has(e.object));
    if (absent) throw new Error(`export: contents missing for ${absent.path}`);
    const tar = buildTar(entries.map((e) => ({ path: e.path, mode: e.mode, data: objs.get(e.object)! })));
    return Readable.from([tar]);
  }
}
