import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
// safe-fs-allow: temporary test fixtures only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhGateway, runGitWithoutBlocking, SafeAttemptGit } from '../../../src/feedback-factory/execute/executorPorts.js';
import { SecretStore } from '../../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../../src/core/SafeGitExecutor.js';
import { createAuthenticatedGitHubCliRuntimeResolver, GitHubAuthUnavailableError } from '../../../src/core/githubRuntime.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback GitHub runtime fixture cleanup' });
});

function fixture(token: string | null = 'fixture-current-seat') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-gh-runtime-'));
  roots.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir);
  const vault = new SecretStore({ stateDir, forceFileKey: true });
  if (token) vault.set('github_token', token);
  const marker = path.join(root, 'called');
  const ghPath = path.join(root, 'gh');
  // A real external process; it reports only whether the right identity reached it.
  fs.writeFileSync(ghPath, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n');
if (process.env.GH_TOKEN !== 'fixture-current-seat' || process.env.GITHUB_TOKEN !== 'fixture-current-seat') process.exit(1);
console.log(JSON.stringify({login:'fixture-agent',owner:{login:'fixture-owner',type:'User'},allow_auto_merge:true}));
`, { mode: 0o700 });
  const safeMergeScript = path.join(root, 'merge.cjs');
  fs.writeFileSync(safeMergeScript, `
const cp = require('node:child_process');
const r = cp.spawnSync('gh', ['api','user'], {encoding:'utf8'});
if(r.status !== 0 || JSON.parse(r.stdout).login !== 'fixture-agent') process.exit(1);
console.log('fixture-merge-authenticated');
`);
  vi.stubEnv('GH_TOKEN', 'fixture-stale-seat');
  vi.stubEnv('GITHUB_TOKEN', '');
  return { root, stateDir, vault, marker, ghPath, gateway: new GhGateway({ cwd: stateDir, ghPath, safeMergeScript }) };
}

describe('feedback GitHub explicit runtime', () => {
  it('reads the agent vault rather than stale inherited or saved CLI credentials', async () => {
    const { gateway } = fixture();
    expect(await gateway.viewerLogin()).toBe('fixture-agent');
    expect(await gateway.repoInfo('fixture-owner/repo')).toEqual({ ownerLogin: 'fixture-owner', ownerType: 'User', allowAutoMerge: true });
  });

  it('refuses before starting the CLI when explicit agent identity is missing', async () => {
    const { gateway, marker } = fixture(null);
    expect(await gateway.repoInfo('fixture-owner/repo')).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
    expect(await gateway.safeMerge('fixture-owner/repo', 7, 'a'.repeat(40))).toMatchObject({ exitCode: null });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('supplies the same explicit identity and resolved CLI to the merge child', async () => {
    const { gateway } = fixture();
    expect(await gateway.safeMerge('fixture-owner/repo', 7, 'a'.repeat(40))).toEqual({ exitCode: 0, stdout: 'fixture-merge-authenticated\n' });
  });

  it('observes a vault rotation after the existing bounded runtime cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    const { gateway, vault } = fixture('fixture-old-seat');
    expect(await gateway.viewerLogin()).toBeNull();
    vault.set('github_token', 'fixture-current-seat');
    expect(await gateway.viewerLogin()).toBeNull();
    vi.setSystemTime(new Date('2026-11-06T12:05:01Z'));
    expect(await gateway.viewerLogin()).toBe('fixture-agent');
  });

  it('commitInBase resolves a short SHA only when the base contains it, using a real repository', async () => {
    const { execFileSync } = await import('node:child_process');
    const fsm = await import('node:fs');
    const osm = await import('node:os');
    const pathm = await import('node:path');
    const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'commit-in-base-'));
    try {
      const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      g('commit', '-q', '--allow-empty', '-m', 'one');
      const fix = g('rev-parse', 'HEAD');
      g('commit', '-q', '--allow-empty', '-m', 'two');
      const base = g('rev-parse', 'HEAD');
      g('checkout', '-q', '-b', 'side', fix);
      g('commit', '-q', '--allow-empty', '-m', 'side');
      const side = g('rev-parse', 'HEAD');
      const git = new SafeAttemptGit(() => null);
      expect(await git.commitInBase(dir, fix.slice(0, 9), base)).toMatchObject({ sha: fix, committedAt: expect.any(Number) });
      expect(await git.commitInBase(dir, side.slice(0, 9), base)).toBeNull();
      expect(await git.commitInBase(dir, 'f'.repeat(12), base)).toBeNull();
      expect(await git.commitInBase(dir, 'HEAD', base)).toBeNull();
    } finally { fsm.rmSync(dir, { recursive: true, force: true }); }
  });

  it('authenticates trusted fetch, publication and release lookup without putting credentials in argv', async () => {
    const f = fixture();
    const resolve = createAuthenticatedGitHubCliRuntimeResolver({ stateDir: f.stateDir, resolveExecutable: () => f.ghPath });
    const git = new SafeAttemptGit(resolve);
    const sha = 'a'.repeat(40);
    const writes = vi.spyOn(SafeGitExecutor, 'execSync').mockReturnValue('');
    const spawned = vi.spyOn(SafeGitExecutor, 'spawn').mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      setImmediate(() => child.emit('close', 0, null));
      return child;
    });
    const reads = vi.spyOn(SafeGitExecutor, 'readSync').mockImplementation((args) => {
      if (args.includes('ls-remote')) return `${sha}\trefs/tags/v1.0.0\n`;
      if (args.includes('log')) return '2026-11-06T12:00:00Z';
      if (args.includes('merge-base')) return '';
      return sha;
    });
    expect(await git.fetchBase('/fixture-source')).toBe(sha);
    expect(await git.commitAndPush('/fixture-publish', { branch: 'feedback/item-a1', message: 'fixture', remoteUrl: 'https://github.com/fixture-owner/repo.git', authorName: 'Fixture', authorEmail: 'fixture@example.test', credentialHelper: '!wrong-seat' })).toBe(sha);
    expect(await git.firstReleaseContaining('/fixture-source', sha)).toMatchObject({ tag: 'v1.0.0' });
    const network = [...writes.mock.calls, ...spawned.mock.calls, ...reads.mock.calls].filter(([args]) => ['fetch', 'push', 'ls-remote'].some((verb) => args.includes(verb)));
    expect(network).toHaveLength(3);
    for (const [args, opts] of network) {
      expect(opts.env).toMatchObject({ GH_TOKEN: 'fixture-current-seat', GITHUB_TOKEN: 'fixture-current-seat', GIT_TERMINAL_PROMPT: '0' });
      expect(args).toContain('credential.helper=');
      expect(args.join(' ')).toContain(f.ghPath);
      expect(args.join(' ')).not.toContain('fixture-current-seat');
      expect(args.join(' ')).not.toContain('wrong-seat');
    }
  });

  it('does not stage or fetch when the production network runtime has no identity', async () => {
    const writes = vi.spyOn(SafeGitExecutor, 'spawn');
    const git = new SafeAttemptGit(() => { throw new GitHubAuthUnavailableError(); });
    await expect(git.fetchBase('/fixture-source')).rejects.toThrow('github-auth-unavailable');
    await expect(git.commitAndPush('/fixture-publish', { branch: 'feedback/item-a1', message: 'fixture', remoteUrl: 'https://github.com/fixture-owner/repo.git', authorName: 'Fixture', authorEmail: 'fixture@example.test', credentialHelper: null })).rejects.toThrow('github-auth-unavailable');
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('git in the server process does not stop its event loop', () => {
  it('createClone lets other work run while git runs and still produces the checkout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-nonblocking-'));
    try {
      const source = path.join(root, 'source');
      fs.mkdirSync(source);
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
      const git = (...args: string[]) => SafeGitExecutor.execSync(args, { cwd: source, env, operation: 'feedback nonblocking test fixture' });
      git('init', '--quiet', '-b', 'main');
      fs.writeFileSync(path.join(source, 'file.txt'), 'content\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'init');
      let turned = false;
      setImmediate(() => { turned = true; });
      const dest = path.join(root, 'feedback-dest');
      await new SafeAttemptGit().createClone(source, dest, SafeGitExecutor.readSync(['rev-parse', 'HEAD'], { cwd: source, operation: 'feedback nonblocking test fixture' }).trim());
      expect(turned).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'file.txt'), 'utf8')).toBe('content\n');
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback nonblocking test cleanup' });
    }
  });

  it('a failed command rejects with the git error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-nonblocking-'));
    try {
      await expect(runGitWithoutBlocking(['clone', '--quiet', path.join(root, 'missing'), path.join(root, 'dest')],
        { cwd: root, operation: 'feedback nonblocking failure test', timeout: 60_000 })).rejects.toThrow(/does not exist/);
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback nonblocking test cleanup' });
    }
  });

  it('the timeout settles even when a leftover process keeps the error pipe open', async () => {
    // A credential helper that outlives git holds stderr, so `close` would not fire for 30 s.
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const spawned = vi.spyOn(SafeGitExecutor, 'spawn').mockReturnValue(child);
    const started = Date.now();
    try {
      await expect(runGitWithoutBlocking(['fetch', 'origin'], { cwd: os.tmpdir(), operation: 'feedback nonblocking timeout test', timeout: 200 }))
        .rejects.toMatchObject({ signal: 'SIGTERM', message: expect.stringContaining('timed out after 200 ms') });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(spawned).toHaveBeenCalledOnce();
    } finally {
      child.kill('SIGKILL');
    }
  });
});
