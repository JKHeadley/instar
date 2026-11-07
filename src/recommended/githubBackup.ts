/**
 * What the GitHub private-backup recipe needs from GitHub and from this agent's state repository,
 * behind one small surface so the recipe and the routes can be tested with a stand-in
 * (docs/specs/recommended-services.md, First recipes: GitHub). The real surface talks to the GitHub
 * REST API with the stored token and drives the state repository through GitStateManager and
 * SafeGitExecutor, with the token in the child's environment only, never in a remote URL or argv.
 *
 * Nothing here logs a value. Repository names are not secrets; tokens are.
 */
import path from 'node:path';
import { GitStateManager } from '../core/GitStateManager.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';

/** The variable the one-shot git credential helper reads the token from. Set on the child only. */
export const GITHUB_BACKUP_TOKEN_ENV = 'INSTAR_GITHUB_BACKUP_TOKEN';

export interface GitHubRepoInfo {
  /** The repository's owner/name as GitHub reports it. */
  fullName: string;
  private: boolean;
  htmlUrl: string;
  /** The clone URL without credentials. */
  cloneUrl: string;
}

export interface GitHubBackupSurface {
  /** The login the token belongs to. Null when the token is refused; undefined when GitHub did not answer. */
  tokenOwner(token: string): Promise<string | null | undefined>;
  /** The repository named, as GitHub sees it with this token. Null when it does not exist (or is not visible); undefined when GitHub did not answer. */
  repo(token: string, fullName: string): Promise<GitHubRepoInfo | null | undefined>;
  /** Creates a PRIVATE repository under the token's own account. */
  createPrivateRepo(token: string, name: string, description: string): Promise<GitHubRepoInfo | null>;
  /** This agent's state repository: initialised when needed, remote set (no credentials in it), everything committed and pushed. Returns the pushed head. */
  pushState(token: string, cloneUrl: string): { head: string } | null;
  /** The remote's head for the state branch, read with the token. Null when the remote refuses or is empty; undefined when it cannot be reached. */
  remoteHead(token: string, cloneUrl: string): Promise<string | null | undefined>;
  /** The local state repository's head, or null when there is no repository yet. */
  localHead(): string | null;
  /** The remote currently set on the state repository, or null. */
  currentRemote(): string | null;
}

/** The repository name the recipe creates for an agent: fixed, so a second machine finds the same one. */
export function backupRepoName(agentName: string): string {
  return `instar-${agentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}-state`;
}

/** owner/name from a GitHub clone or web URL; null for anything else. */
export function parseGitHubRepo(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const API = 'https://api.github.com';

async function gh<T>(token: string, method: string, pathname: string, body?: unknown, doFetch: typeof fetch = fetch): Promise<{ status: number; body: T | null } | undefined> {
  try {
    const res = await doFetch(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'instar-recommended-services', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed: T | null = null;
    try { parsed = text ? (JSON.parse(text) as T) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } catch {
    // @silent-fallback-ok: "GitHub did not answer" is a state the recipe reports as unknown
    return undefined;
  }
}

function toInfo(r: { full_name?: unknown; private?: unknown; html_url?: unknown; clone_url?: unknown }): GitHubRepoInfo | null {
  if (typeof r.full_name !== 'string' || typeof r.private !== 'boolean' || typeof r.html_url !== 'string' || typeof r.clone_url !== 'string') return null;
  return { fullName: r.full_name, private: r.private, htmlUrl: r.html_url, cloneUrl: r.clone_url };
}

/** The production surface: GitHub's REST API with the stored token, and this agent's state repository. */
export function realGitHubBackupSurface(stateDir: string, gitConfig: Record<string, unknown> | undefined, doFetch: typeof fetch = fetch): GitHubBackupSurface {
  const manager = () => new GitStateManager(stateDir, gitConfig as never);
  // A one-shot credential helper: the token travels in the child's environment, never on the command line or in the remote URL.
  const credential = `credential.helper=!f() { echo username=x-access-token; echo "password=$${GITHUB_BACKUP_TOKEN_ENV}"; }; f`;
  // GIT_TERMINAL_PROMPT=0: a helper that yields nothing fails at once instead of waiting on a tty prompt.
  // `-c` comes before the verb, so the funnel is named explicitly: execSync for the push (a write), readSync for ls-remote.
  const gitOpts = (token: string) => ({
    cwd: stateDir, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as Array<'pipe'>, operation: 'src/recommended/githubBackup.ts:git',
    env: { [GITHUB_BACKUP_TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: '0' },
  });
  const gitWrite = (token: string, args: string[]): string => SafeGitExecutor.execSync(['-c', credential, ...args], gitOpts(token));
  const gitRead = (token: string, args: string[]): string => SafeGitExecutor.readSync(['-c', credential, ...args], gitOpts(token));
  const readRemote = (): string | null => {
    try {
      const url = SafeGitExecutor.run(['remote', 'get-url', 'origin'], { cwd: path.resolve(stateDir), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], operation: 'src/recommended/githubBackup.ts:remote' }).trim();
      return url || null;
    } catch {
      // @silent-fallback-ok: no remote set
      return null;
    }
  };
  return {
    tokenOwner: async (token) => {
      const r = await gh<{ login?: unknown }>(token, 'GET', '/user', undefined, doFetch);
      if (!r) return undefined;
      return r.status === 200 && typeof r.body?.login === 'string' ? r.body.login : null;
    },
    repo: async (token, fullName) => {
      const r = await gh<Record<string, unknown>>(token, 'GET', `/repos/${fullName}`, undefined, doFetch);
      if (!r) return undefined;
      return r.status === 200 && r.body ? toInfo(r.body) : null;
    },
    createPrivateRepo: async (token, name, description) => {
      const r = await gh<Record<string, unknown>>(token, 'POST', '/user/repos', { name, description, private: true, auto_init: false }, doFetch);
      if (!r || r.status !== 201 || !r.body) return null;
      return toInfo(r.body);
    },
    pushState: (token, cloneUrl) => {
      try {
        const m = manager();
        if (!m.isInitialized()) m.init();
        // A remote the person already set (their own GitHub remote, SSH, another host) is left exactly as it is:
        // only a repository with no origin gets this one. The push always names the URL, never `origin`.
        if (readRemote() === null) m.setRemote(cloneUrl);
        // Commit whatever the ignore list allows; an empty tree is fine (the init commit stands).
        try { m.commit('[instar] backup: recommended-services copy'); } catch { /* @silent-fallback-ok: nothing to commit is not a failure */ }
        gitWrite(token, ['push', cloneUrl, 'HEAD:main']);
        const head = SafeGitExecutor.run(['rev-parse', 'HEAD'], { cwd: stateDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], operation: 'src/recommended/githubBackup.ts:head' }).trim();
        return head ? { head } : null;
      } catch {
        // @silent-fallback-ok: a failed push is reported as such by the recipe, with a fixed reason
        return null;
      }
    },
    remoteHead: async (token, cloneUrl) => {
      try {
        const out = gitRead(token, ['ls-remote', cloneUrl, 'refs/heads/main']).trim();
        const sha = out.split(/\s+/)[0];
        return /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null;
      } catch {
        // @silent-fallback-ok: unreachable or refused; the recipe tells the two apart from GitHub's own answer
        return undefined;
      }
    },
    localHead: () => {
      try {
        if (!manager().isInitialized()) return null;
        const head = SafeGitExecutor.run(['rev-parse', 'HEAD'], { cwd: stateDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], operation: 'src/recommended/githubBackup.ts:head' }).trim();
        return head || null;
      } catch {
        // @silent-fallback-ok: no commits yet
        return null;
      }
    },
    currentRemote: () => (manager().isInitialized() ? readRemote() : null),
  };
}
