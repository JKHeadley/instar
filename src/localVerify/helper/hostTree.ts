/**
 * The helper's host-side view of a merged commit (docs/specs/local-verify-borrowed-unit-slices.md,
 * C.1 and E "Preparation"):
 *  - GitHub is asked whether `headSha` is reachable from `main` of the pinned repository (the compare
 *    API reports `identical` or `behind`), with a read-only fine-grained token held in the helper
 *    machine's secret store. The token stays on the host and never enters the sandbox.
 *  - The owner service fetches the commit into its own bare clone (fetching runs no code) and
 *    exports it as a plain file tree with no `.git`: a tar built here from `ls-tree` + `cat-file`
 *    (the same bytes `git archive` would give, without widening the git funnel's verb table).
 *
 * Both are injected seams of HelperService (`MergedOnMainChecker`, `HostTreeSource`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SafeGitExecutor } from '../../core/SafeGitExecutor.js';
import { SecretStore } from '../../core/SecretStore.js';

export interface MergedOnMainChecker {
  readonly kind: string;
  /** true: on main; false: not on main; null: unknown (→ refused `merged-unknown`). */
  isOnMain(repo: string, sha: string): Promise<boolean | null>;
}

/** The secret-store key holding the helper's read-only GitHub token. */
export const HELPER_GITHUB_TOKEN_KEY = 'localVerifyHelper.githubToken';

export function secretStoreToken(stateDir: string): () => string | null {
  return () => {
    try {
      const v = new SecretStore({ stateDir }).get(HELPER_GITHUB_TOKEN_KEY);
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch { return null; } // @silent-fallback-ok: no readable token makes every merged check unknown, which refuses
  };
}

export class GitHubCompareChecker implements MergedOnMainChecker {
  readonly kind = 'github-compare';
  constructor(private readonly o: { token: () => string | null; fetchImpl?: typeof fetch; timeoutMs?: number }) {}

  async isOnMain(repo: string, sha: string): Promise<boolean | null> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) return null;
    const token = this.o.token();
    if (!token) return null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 15_000);
    try {
      const r = await (this.o.fetchImpl ?? fetch)(`https://api.github.com/repos/${repo}/compare/main...${sha}`, {
        signal: ac.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'instar-helper' },
      });
      if (r.status === 404) return false;
      if (r.status !== 200) return null;
      const body = await r.json() as { status?: unknown };
      if (body.status === 'identical' || body.status === 'behind') return true;
      if (body.status === 'ahead' || body.status === 'diverged') return false;
      return null;
    } catch { return null; } // @silent-fallback-ok: unreachable GitHub is unknown, which refuses
    finally { clearTimeout(t); }
  }
}

export interface TreeEntry { mode: string; object: string; path: string }

export interface HostTreeSource {
  readonly kind: string;
  /** Fetch the commit into the owner service's bare clone. Runs no code. */
  fetch(repoUrl: string, sha: string): Promise<void>;
  entries(sha: string): Promise<TreeEntry[]>;
  read(sha: string, file: string): Promise<string | null>;
  /** A tar of the commit's files (no `.git`). */
  archive(sha: string): Promise<Readable>;
}

function collect(child: ChildProcess, input?: string): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => resolve({ code: null, out: Buffer.alloc(0) }));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks) }));
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

/** The production tree source: a bare clone under the helper's home, read through the git funnel. */
export class BareCloneTreeSource implements HostTreeSource {
  readonly kind = 'bare-clone';
  private readonly entryCache = new Map<string, TreeEntry[]>();
  constructor(private readonly bare: string) {}

  private async ensure(): Promise<void> {
    if (fs.existsSync(path.join(this.bare, 'HEAD'))) return;
    fs.mkdirSync(this.bare, { recursive: true, mode: 0o700 });
    const r = await collect(SafeGitExecutor.spawn(['init', '--bare', '--quiet', this.bare], { operation: 'local-verify:helper-bare-init', cwd: path.dirname(this.bare) }));
    if (r.code !== 0) throw new Error('bare clone init failed');
  }

  async fetch(repoUrl: string, sha: string): Promise<void> {
    await this.ensure();
    const r = await collect(SafeGitExecutor.spawn(['--git-dir', this.bare, 'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', repoUrl, sha], { operation: 'local-verify:helper-fetch', cwd: this.bare, timeout: 10 * 60_000 }));
    if (r.code !== 0) throw new Error('fetch failed');
  }

  async entries(sha: string): Promise<TreeEntry[]> {
    const cached = this.entryCache.get(sha);
    if (cached) return cached;
    const r = await collect(SafeGitExecutor.readStream(['--git-dir', this.bare, 'ls-tree', '-r', '-z', '--full-tree', sha], { operation: 'local-verify:helper-ls-tree', cwd: this.bare, timeout: 60_000 }));
    if (r.code !== 0) throw new Error('ls-tree failed');
    const list = parseLsTree(r.out);
    this.entryCache.set(sha, list);
    if (this.entryCache.size > 2) this.entryCache.delete(this.entryCache.keys().next().value as string);
    return list;
  }

  private async objects(ids: string[]): Promise<Map<string, Buffer>> {
    if (ids.length === 0) return new Map();
    const r = await collect(SafeGitExecutor.readStream(['--git-dir', this.bare, 'cat-file', '--batch'], { operation: 'local-verify:helper-cat-file', cwd: this.bare, timeout: 5 * 60_000 }), ids.join('\n') + '\n');
    if (r.code !== 0) throw new Error('cat-file failed');
    return parseCatFileBatch(r.out);
  }

  async read(sha: string, file: string): Promise<string | null> {
    const e = (await this.entries(sha)).find((x) => x.path === file);
    if (!e) return null;
    return (await this.objects([e.object])).get(e.object)?.toString('utf-8') ?? null;
  }

  async archive(sha: string): Promise<Readable> {
    const entries = await this.entries(sha);
    const objs = await this.objects([...new Set(entries.map((e) => e.object))]);
    const tar = buildTar(entries.filter((e) => objs.has(e.object)).map((e) => ({ path: e.path, mode: e.mode, data: objs.get(e.object)! })));
    return Readable.from([tar]);
  }
}
