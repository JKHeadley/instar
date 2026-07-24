import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  createAuthenticatedGhExec,
  createAuthenticatedGitHubCliRuntimeResolver,
  execAuthenticatedGhSync,
  fetchGitHubGraphql,
  GitHubAuthUnavailableError,
  resolveGhExecutable,
  resolveGitHubToken,
} from '../../src/core/githubRuntime.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-runtime-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/github-runtime.test.ts',
  });
});

describe('resolveGitHubToken', () => {
  it('prefers the explicit server environment over the vault', () => {
    new SecretStore({ stateDir, forceFileKey: true }).set('github_token', 'vault-token');
    expect(resolveGitHubToken({
      stateDir,
      env: { GITHUB_TOKEN: '  env-token  ' },
      forceFileKey: true,
    })).toBe('env-token');
  });

  it('falls back to the per-agent encrypted vault', () => {
    new SecretStore({ stateDir, forceFileKey: true }).set('github_token', 'vault-token');
    expect(resolveGitHubToken({ stateDir, env: {}, forceFileKey: true })).toBe('vault-token');
  });

  it('returns null instead of consulting a machine-global gh seat', () => {
    expect(resolveGitHubToken({ stateDir, env: {}, forceFileKey: true })).toBeNull();
  });
});

describe('resolveGhExecutable', () => {
  it('checks Homebrew locations before launchd PATH entries', () => {
    const checked: string[] = [];
    const found = resolveGhExecutable({
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: (candidate) => {
        checked.push(candidate);
        return candidate === '/opt/homebrew/bin/gh';
      },
    });
    expect(found).toBe('/opt/homebrew/bin/gh');
    expect(checked[0]).toBe('/opt/homebrew/bin/gh');
  });

  it('falls back to an executable found on the supplied PATH', () => {
    expect(resolveGhExecutable({
      env: { PATH: '/custom/bin:/usr/bin' },
      isExecutable: (candidate) => candidate === '/custom/bin/gh',
    })).toBe('/custom/bin/gh');
  });

  it('ignores relative PATH entries', () => {
    const checked: string[] = [];
    resolveGhExecutable({
      env: { PATH: 'relative/bin:/usr/bin' },
      isExecutable: (candidate) => {
        checked.push(candidate);
        return false;
      },
    });
    expect(checked).not.toContain(path.join('relative/bin', 'gh'));
    expect(checked).toContain('/usr/bin/gh');
  });
});

describe('authenticated gh execution', () => {
  it('caches both successful and unavailable runtimes for the bounded TTL', () => {
    let now = 1_000;
    let tokenCalls = 0;
    const resolveRuntime = createAuthenticatedGitHubCliRuntimeResolver({
      env: { PATH: '/usr/bin:/bin' },
      now: () => now,
      cacheTtlMs: 100,
      resolveToken: () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? null : 'rotated-token';
      },
      resolveExecutable: () => '/opt/homebrew/bin/gh',
    });
    expect(() => resolveRuntime()).toThrow(GitHubAuthUnavailableError);
    expect(() => resolveRuntime()).toThrow(GitHubAuthUnavailableError);
    expect(tokenCalls).toBe(1);
    now += 101;
    expect(resolveRuntime().env.GH_TOKEN).toBe('rotated-token');
    expect(resolveRuntime().env.PATH?.split(path.delimiter)[0]).toBe('/opt/homebrew/bin');
    expect(resolveRuntime().env.GH_TOKEN).toBe('rotated-token');
    expect(tokenCalls).toBe(2);
  });

  it('does not start the async child when no explicit token exists', async () => {
    const execFileImpl = vi.fn() as unknown as typeof execFile;
    const run = createAuthenticatedGhExec({
      stateDir,
      env: {},
      resolveToken: () => null,
      resolveExecutable: () => '/opt/homebrew/bin/gh',
      execFileImpl,
    });
    await expect(run(['api', 'user'])).resolves.toEqual({
      code: 1,
      stdout: '',
      stderr: 'github-auth-unavailable',
    });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('uses an absolute executable and forces the explicit token into the async child', async () => {
    let captured: { file?: string; env?: NodeJS.ProcessEnv } = {};
    const execFileImpl = ((file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      captured = { file, env: options.env };
      callback(null, 'ok', '');
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile;
    const run = createAuthenticatedGhExec({
      stateDir,
      env: { PATH: '/usr/bin:/bin' },
      resolveToken: () => 'agent-token',
      resolveExecutable: () => '/opt/homebrew/bin/gh',
      execFileImpl,
    });

    await expect(run(['api', 'user'])).resolves.toMatchObject({ code: 0, stdout: 'ok' });
    expect(captured.file).toBe('/opt/homebrew/bin/gh');
    expect(captured.env?.GH_TOKEN).toBe('agent-token');
    expect(captured.env?.GITHUB_TOKEN).toBe('agent-token');
    expect(captured.env?.PATH?.split(path.delimiter)[0]).toBe('/opt/homebrew/bin');
  });

  it('throws the distinct auth error before sync execution when no token exists', () => {
    const execFileSyncImpl = vi.fn() as unknown as typeof execFileSync;
    expect(() => execAuthenticatedGhSync(['run', 'list'], {
      stateDir,
      env: {},
      resolveToken: () => null,
      resolveExecutable: () => '/opt/homebrew/bin/gh',
      execFileSyncImpl,
    })).toThrow(GitHubAuthUnavailableError);
    expect(execFileSyncImpl).not.toHaveBeenCalled();
  });

  it('forces the explicit token into the sync child environment', () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const execFileSyncImpl = ((_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env;
      return '[]';
    }) as typeof execFileSync;
    expect(execAuthenticatedGhSync(['run', 'list'], {
      stateDir,
      env: { PATH: '/usr/bin:/bin' },
      resolveToken: () => 'agent-token',
      resolveExecutable: () => '/usr/local/bin/gh',
      execFileSyncImpl,
    })).toBe('[]');
    expect(capturedEnv?.GH_TOKEN).toBe('agent-token');
    expect(capturedEnv?.GITHUB_TOKEN).toBe('agent-token');
    expect(capturedEnv?.PATH?.split(path.delimiter)[0]).toBe('/usr/local/bin');
  });
});

describe('fetchGitHubGraphql', () => {
  it('sends the explicit token directly to api.github.com', async () => {
    let request: { url?: string; authorization?: string; body?: string } = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      request = {
        url: String(url),
        authorization: headers.get('authorization') ?? undefined,
        body: String(init?.body),
      };
      return new Response(JSON.stringify({ data: { viewer: { login: 'EchoOfDawn' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await expect(fetchGitHubGraphql<{ viewer: { login: string } }>({
      token: 'agent-token',
      query: 'query { viewer { login } }',
      fetchImpl,
    })).resolves.toEqual({ viewer: { login: 'EchoOfDawn' } });
    expect(request.url).toBe('https://api.github.com/graphql');
    expect(request.authorization).toBe('Bearer agent-token');
    expect(request.body).not.toContain('machine-global');
  });

  it('surfaces only bounded status metadata on HTTP failure', async () => {
    const fetchImpl = (async () => new Response('sensitive upstream body', {
      status: 401,
    })) as typeof globalThis.fetch;
    await expect(fetchGitHubGraphql({
      token: 'bad-token',
      query: 'query { viewer { login } }',
      fetchImpl,
    })).rejects.toThrow('github-graphql-http-401');
  });
});
