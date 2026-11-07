// safe-git-allow: fixture-only git commands and tmpdir cleanup build the stand-in repositories this test pushes between.
/**
 * The real GitHub backup surface against a real local git repository (a bare repository stands in
 * for GitHub's remote): the person's existing origin is left exactly as it was, the push names the
 * URL rather than origin, and the pushed head reads back.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realGitHubBackupSurface } from '../../src/recommended/githubBackup.js';

const dirs: string[] = [];
function tmp(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `recsvc-gh-${name}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const FOREIGN_ORIGIN = 'git@gitlab.example.com:someone/own-backup.git';

describe('realGitHubBackupSurface against a local repository', () => {
  it('leaves an existing origin untouched, pushes by URL, and reads the head back', async () => {
    const stateDir = tmp('state');
    const bare = tmp('bare');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
    // The person's own state repository with their own remote already set.
    execFileSync('git', ['init', '-b', 'main'], { cwd: stateDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# me\n');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['add', '-A'], { cwd: stateDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'first'], { cwd: stateDir, stdio: 'pipe', env });
    execFileSync('git', ['remote', 'add', 'origin', FOREIGN_ORIGIN], { cwd: stateDir, stdio: 'pipe' });

    const surface = realGitHubBackupSurface(stateDir, { branch: 'main' });
    expect(surface.currentRemote()).toBe(FOREIGN_ORIGIN);

    const pushed = surface.pushState('not-a-real-token', bare);
    expect(pushed).not.toBeNull();
    expect(pushed!.head).toMatch(/^[0-9a-f]{40}$/);

    // The foreign origin is exactly what it was; the bare repository holds the head.
    expect(surface.currentRemote()).toBe(FOREIGN_ORIGIN);
    const bareHead = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf-8' }).trim();
    expect(bareHead).toBe(pushed!.head);
    expect(surface.localHead()).toBe(pushed!.head);
    expect(await surface.remoteHead('not-a-real-token', bare)).toBe(pushed!.head);
  });

  it('reports no remote and no head for a folder with no repository', () => {
    const stateDir = tmp('empty');
    const surface = realGitHubBackupSurface(stateDir, { branch: 'main' });
    expect(surface.currentRemote()).toBeNull();
    expect(surface.localHead()).toBeNull();
  });
});
