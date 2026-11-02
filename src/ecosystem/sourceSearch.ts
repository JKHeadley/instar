/**
 * Our own source, searched by trusted code (docs/specs/ecosystem-idea-pipeline.md §5).
 *
 * Roots are full bare mirrors under state/ecosystem/sources. Retrieval is by meaning and by
 * word: a dedicated SemanticMemory database at state/ecosystem/index.db, never the server's
 * shared state/semantic.db, so nothing here can reach session recall or private memories; and
 * fixed-string `git grep` over code. If vector search is unavailable the search says `word-only`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { SemanticMemory } from '../memory/SemanticMemory.js';
import { CLONE_TIMEOUT_MS, repoUrl, runGitNetwork, type FetchOptions } from './projectFetch.js';
import { HARDENED_GIT_CONFIG } from '../feedback-factory/execute/executorPorts.js';
import type { SearchMode } from './types.js';
import type { SearchResult } from './ideaPrompts.js';

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 40;
const MAX_RESULT_CHARS = 500;
const MAX_INDEX_CHUNKS = 2_500;
const CHUNK_CHARS = 1_500;

export interface SourceRootSpec { repo: string; ref?: string; docGlobs?: string[] }

export interface SourceSearch {
  /** Bring the roots up to date and return each root's commit. */
  refresh(): Promise<Record<string, string>>;
  search(terms: string[], claim: string): Promise<{ results: SearchResult[]; truncated: boolean; mode: SearchMode }>;
  /** A document from a root at its recorded commit, or null. */
  readDoc(repo: string, file: string, maxChars: number): Promise<{ text: string; commit: string } | null>;
  /** Index a ledger claim, so an earlier ruling can be found by meaning. Rebuilt indexes need these again. */
  indexLedgerClaim(ref: string, text: string): void;
  close(): void;
}

function env(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

const DEFAULT_DOC_PATHS = ['docs'];
const CODE_PATHS = ['src', 'scripts', 'skills'];

export interface GitSourceSearchOptions extends FetchOptions {
  dir: string;
  roots: SourceRootSpec[];
  /** Attaches embeddings when they can load; absent or failing means word-only. */
  attachEmbeddings?: (memory: SemanticMemory) => Promise<boolean>;
}

export class GitSourceSearch implements SourceSearch {
  private commits: Record<string, string> = {};
  private memory: SemanticMemory | null = null;
  private vectorReady = false;

  constructor(private readonly opts: GitSourceSearchOptions) {
    fs.mkdirSync(path.join(opts.dir, 'sources'), { recursive: true });
  }

  private mirrorDir(repo: string): string {
    return path.join(this.opts.dir, 'sources', `${repo.replace(/[^A-Za-z0-9._-]/g, '__')}.git`);
  }

  private gitArgs(repo: string): string[] {
    const url = repoUrl(repo, this.opts);
    const cfg = url.startsWith('https://') ? [] : ['-c', 'protocol.file.allow=always'];
    return [...HARDENED_GIT_CONFIG, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...cfg];
  }

  private async read(repo: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync('git', [...this.gitArgs(repo), `--git-dir=${this.mirrorDir(repo)}`, ...args], { env: env(), cwd: os.tmpdir(), timeout: 120_000, maxBuffer });
    return stdout;
  }

  async refresh(): Promise<Record<string, string>> {
    const before = JSON.stringify(this.commits);
    for (const root of this.opts.roots) {
      const dir = this.mirrorDir(root.repo);
      const url = repoUrl(root.repo, this.opts);
      const ref = root.ref ?? 'HEAD';
      if (!fs.existsSync(path.join(dir, 'HEAD'))) {
        await runGitNetwork([...this.gitArgs(root.repo), 'clone', '--bare', '--no-recurse-submodules', '--quiet', url, dir], { cwd: this.opts.dir, timeoutMs: CLONE_TIMEOUT_MS, operation: 'ecosystem-ideas clone source root' });
      } else {
        await runGitNetwork([...this.gitArgs(root.repo), `--git-dir=${dir}`, 'fetch', '--quiet', '--no-recurse-submodules', 'origin', '+HEAD:refs/ecosystem/head'], { cwd: this.opts.dir, timeoutMs: CLONE_TIMEOUT_MS, operation: 'ecosystem-ideas fetch source root' });
      }
      const resolved = (await this.read(root.repo, ['rev-parse', '--verify', '--quiet', 'refs/ecosystem/head']).catch(() => '')).trim();
      this.commits[root.repo] = resolved || (await this.read(root.repo, ['rev-parse', ref])).trim();
    }
    if (JSON.stringify(this.commits) !== before || !this.memory) await this.rebuildIndex();
    return { ...this.commits };
  }

  /** The index is derived: rebuilt when a root moves, and never holds anything but our own documents. */
  private async rebuildIndex(): Promise<void> {
    this.close();
    const dbPath = path.join(this.opts.dir, 'index.db');
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.jsonl`]) {
      SafeFsExecutor.safeRmSync(f, { force: true, operation: 'ecosystem-ideas rebuild index' });
    }
    this.memory = new SemanticMemory({ dbPath, decayHalfLifeDays: 3650, lessonDecayHalfLifeDays: 3650, staleThreshold: 0 });
    await this.memory.open();
    let chunks = 0;
    const now = new Date().toISOString();
    for (const root of this.opts.roots) {
      const commit = this.commits[root.repo];
      if (!commit) continue;
      const files = (await this.read(root.repo, ['ls-tree', '-r', '--name-only', commit, '--', ...(root.docGlobs ?? DEFAULT_DOC_PATHS)])).split('\n').filter((f) => /\.mdx?$/.test(f));
      // Specs and standards first, so the cap never spends itself on audit journals. A cut index is still backed by word search.
      const rank = (f: string) => (/(^|\/)docs\/specs\/[^/]*\.md$/.test(f) && !f.endsWith('.eli16.md') ? 0 : /STANDARDS|PURPOSE|00-the-|01-the-/i.test(f) ? 1 : /\/(audits|reports|research|findings)\//.test(f) ? 3 : 2);
      const rootCap = chunks + Math.ceil(MAX_INDEX_CHUNKS / this.opts.roots.length);
      for (const file of [...new Set(files)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
        if (chunks >= rootCap) break;
        const text = await this.read(root.repo, ['show', `${commit}:${file}`]).catch(() => '');
        for (let at = 0; at < text.length && chunks < rootCap; at += CHUNK_CHARS) {
          this.memory.remember({ type: 'fact', name: `${root.repo}:${file}#${at}`, content: text.slice(at, at + CHUNK_CHARS), confidence: 1, lastVerified: now, source: 'ecosystem-index', tags: ['ecosystem-index'] });
          chunks++;
        }
      }
    }
    // Attached after the load, so the chunks embed in one bounded batch rather than one spawn each.
    this.vectorReady = this.opts.attachEmbeddings ? await this.opts.attachEmbeddings(this.memory).catch(() => false) : false;
    if (this.vectorReady) await this.memory.embedAllEntities().catch(() => { this.vectorReady = false; });
  }

  async search(terms: string[], claim: string): Promise<{ results: SearchResult[]; truncated: boolean; mode: SearchMode }> {
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    let truncated = false;
    const push = (ref: string, text: string) => {
      if (seen.has(ref)) return;
      if (results.length >= MAX_RESULTS) { truncated = true; return; }
      seen.add(ref);
      results.push({ ref, text: text.slice(0, MAX_RESULT_CHARS) });
    };
    if (this.memory) {
      const hits = this.vectorReady
        ? await this.memory.searchHybrid([claim, ...terms].join(' '), { limit: 20 })
        : this.memory.search(terms.join(' ') || claim, { limit: 20 });
      for (const hit of hits) push(hit.name, hit.content);
    }
    for (const root of this.opts.roots) {
      const commit = this.commits[root.repo];
      if (!commit) continue;
      for (const term of terms) {
        // Fixed-string search: a model's term is never a pattern.
        let out = '';
        try {
          out = await this.read(root.repo, ['grep', '-F', '-n', '-I', '-i', '--max-count=3', '-e', term, commit, '--', ...CODE_PATHS, 'docs/specs']);
        } catch { continue; /* @silent-fallback-ok: git grep exits 1 on no match, which is an answer */ }
        for (const line of out.split('\n').filter(Boolean).slice(0, 12)) {
          const m = /^[0-9a-f]+:([^:]+):(\d+):(.*)$/.exec(line);
          if (m) push(`${root.repo}:${m[1]}:${m[2]}`, m[3]);
        }
      }
    }
    return { results, truncated, mode: this.vectorReady ? 'hybrid' : 'word-only' };
  }

  async readDoc(repo: string, file: string, maxChars: number): Promise<{ text: string; commit: string } | null> {
    const commit = this.commits[repo];
    if (!commit) return null;
    try {
      return { text: (await this.read(repo, ['show', `${commit}:${file}`])).slice(0, maxChars), commit };
    } catch { return null; }
  }

  indexLedgerClaim(ref: string, text: string): void {
    this.memory?.remember({ type: 'fact', name: ref, content: text.slice(0, CHUNK_CHARS), confidence: 1, lastVerified: new Date().toISOString(), source: 'ecosystem-index', tags: ['ecosystem-ledger'] });
  }

  close(): void {
    if (this.memory) { try { this.memory.close(); } catch { /* @silent-fallback-ok: closing a derived index that is about to be rebuilt */ } }
    this.memory = null;
  }
}
