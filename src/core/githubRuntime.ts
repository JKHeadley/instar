/**
 * Server-safe GitHub runtime.
 *
 * Long-lived agent servers run under launchd, where PATH commonly omits
 * Homebrew, and must never inherit the active identity from a machine-global
 * `gh` keychain seat. This module is the single runtime boundary for:
 *
 *  - resolving an explicit per-agent token (`GITHUB_TOKEN`, then vault);
 *  - calling GitHub GraphQL directly; and
 *  - running the few remaining gh-dependent server adapters with an absolute
 *    executable and explicit token environment.
 *
 * Missing auth/executable always fails before a GitHub operation. No caller
 * falls through to `~/.config/gh/hosts.yml`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { constants as fsConstants, accessSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveGhTokenFromVault, type ResolveGhTokenOptions } from './ghToken.js';

export class GitHubAuthUnavailableError extends Error {
  readonly code = 'github-auth-unavailable';

  constructor() {
    super('github-auth-unavailable');
    this.name = 'GitHubAuthUnavailableError';
  }
}

export class GitHubCliUnavailableError extends Error {
  readonly code = 'github-cli-unavailable';

  constructor() {
    super('github-cli-unavailable');
    this.name = 'GitHubCliUnavailableError';
  }
}

export interface ResolveGitHubTokenOptions extends ResolveGhTokenOptions {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolve only explicit server identity: environment first, then agent vault. */
export function resolveGitHubToken(options: ResolveGitHubTokenOptions = {}): string | null {
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  if (typeof token === 'string' && token.trim()) return token.trim();
  return options.stateDir
    ? resolveGhTokenFromVault(options.stateDir, { forceFileKey: options.forceFileKey })
    : null;
}

/** Cache token presence or absence for a bounded interval. */
export function createGitHubTokenResolver(options: ResolveGitHubTokenOptions & {
  cacheTtlMs?: number;
  now?: () => number;
}): () => string | null {
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  let cached: { expiresAt: number; token: string | null } | null = null;
  return () => {
    const timestamp = now();
    if (cached && timestamp < cached.expiresAt) return cached.token;
    const token = resolveGitHubToken(options);
    cached = { expiresAt: timestamp + cacheTtlMs, token };
    return token;
  };
}

export interface ResolveGhExecutableOptions {
  env?: NodeJS.ProcessEnv;
  isExecutable?: (candidate: string) => boolean;
}

/**
 * Resolve gh without relying on launchd's truncated PATH. Candidate order is
 * deterministic: Apple Silicon Homebrew, Intel Homebrew, then explicit PATH.
 */
export function resolveGhExecutable(options: ResolveGhExecutableOptions = {}): string | null {
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? ((candidate: string) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch { /* @silent-fallback-ok — a missing/non-executable gh candidate is expected while resolving the next explicit candidate */
      return false;
    }
  });
  const candidates = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    ...(env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => path.isAbsolute(dir))
      .map((dir) => path.join(dir, 'gh')),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function explicitGitHubEnv(env: NodeJS.ProcessEnv, token: string, executable: string): NodeJS.ProcessEnv {
  const executableDir = path.dirname(executable);
  const pathEntries = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && entry !== executableDir);
  return {
    ...env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    // safe-merge still invokes `gh` internally. Put the already-resolved,
    // absolute executable directory first so that child cannot select a
    // different binary or depend on launchd's truncated PATH.
    PATH: [executableDir, ...pathEntries].join(path.delimiter),
  };
}

export type AuthenticatedGhResult = { code: number; stdout: string; stderr: string };
export type AuthenticatedGhExec = (args: string[]) => Promise<AuthenticatedGhResult>;

export interface AuthenticatedGitHubCliRuntime {
  executable: string;
  env: NodeJS.ProcessEnv;
}

interface AuthenticatedGitHubRuntimeOptions extends ResolveGitHubTokenOptions {
  resolveToken?: () => string | null;
  resolveExecutable?: () => string | null;
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Resolve and briefly cache the explicit GitHub CLI runtime. Long-lived
 * pollers call this repeatedly, so caching both success and typed failure
 * avoids a vault/keychain read on every GitHub command while still allowing
 * token rotation to take effect within the bounded TTL.
 */
export function createAuthenticatedGitHubCliRuntimeResolver(
  options: AuthenticatedGitHubRuntimeOptions,
): () => AuthenticatedGitHubCliRuntime {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  let cached:
    | { expiresAt: number; value: AuthenticatedGitHubCliRuntime }
    | { expiresAt: number; error: GitHubAuthUnavailableError | GitHubCliUnavailableError }
    | null = null;

  return () => {
    const timestamp = now();
    if (cached && timestamp < cached.expiresAt) {
      if ('error' in cached) throw cached.error;
      return cached.value;
    }
    const expiresAt = timestamp + cacheTtlMs;
    const token = options.resolveToken ? options.resolveToken() : resolveGitHubToken(options);
    if (!token) {
      const error = new GitHubAuthUnavailableError();
      cached = { expiresAt, error };
      throw error;
    }
    const executable = options.resolveExecutable ? options.resolveExecutable() : resolveGhExecutable({ env });
    if (!executable) {
      const error = new GitHubCliUnavailableError();
      cached = { expiresAt, error };
      throw error;
    }
    const value = { executable, env: explicitGitHubEnv(env, token, executable) };
    cached = { expiresAt, value };
    return value;
  };
}

interface AuthenticatedGhOptions extends AuthenticatedGitHubRuntimeOptions {
  resolveRuntime?: () => AuthenticatedGitHubCliRuntime;
  execFileImpl?: typeof execFile;
}

/** Build the async arg-array gh runner used by long-lived server adapters. */
export function createAuthenticatedGhExec(options: AuthenticatedGhOptions): AuthenticatedGhExec {
  const run = options.execFileImpl ?? execFile;
  const resolveRuntime = options.resolveRuntime
    ?? createAuthenticatedGitHubCliRuntimeResolver(options);
  return async (args: string[]) => {
    let runtime: AuthenticatedGitHubCliRuntime;
    try {
      runtime = resolveRuntime();
    } catch (error) {
      if (error instanceof GitHubAuthUnavailableError || error instanceof GitHubCliUnavailableError) {
        return { code: 1, stdout: '', stderr: error.code };
      }
      throw error;
    }
    return new Promise((resolve) => {
      run(
        runtime.executable,
        args,
        {
          env: runtime.env,
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
        },
        (err, stdout, stderr) => resolve({
          code: err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? (err as NodeJS.ErrnoException & { code: number }).code
            : 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        }),
      );
    });
  };
}

interface AuthenticatedGhSyncOptions extends AuthenticatedGitHubRuntimeOptions {
  resolveRuntime?: () => AuthenticatedGitHubCliRuntime;
  resolveToken?: () => string | null;
  resolveExecutable?: () => string | null;
  execFileSyncImpl?: typeof execFileSync;
  timeoutMs?: number;
}

/** Build a cached synchronous runner for legacy polling code. */
export function createAuthenticatedGhSyncExec(
  options: AuthenticatedGhSyncOptions,
): (args: string[]) => string {
  const run = options.execFileSyncImpl ?? execFileSync;
  const resolveRuntime = options.resolveRuntime
    ?? createAuthenticatedGitHubCliRuntimeResolver(options);
  return (args: string[]) => {
    const runtime = resolveRuntime();
    return run(runtime.executable, args, {
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: runtime.env,
    });
  };
}

/** Run one synchronous command with explicit identity. */
export function execAuthenticatedGhSync(args: string[], options: AuthenticatedGhSyncOptions): string {
  return createAuthenticatedGhSyncExec(options)(args);
}

export interface FetchGitHubGraphqlOptions {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Direct GitHub GraphQL call with a bounded, non-secret error surface. */
export async function fetchGitHubGraphql<T>(options: FetchGitHubGraphqlOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'instar-agent-server',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query: options.query, variables: options.variables ?? {} }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`github-graphql-http-${response.status}`);
  const payload = await response.json() as { data?: T; errors?: unknown[] };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`github-graphql-errors-${payload.errors.length}`);
  }
  if (payload.data == null) throw new Error('github-graphql-invalid-response');
  return payload.data;
}
