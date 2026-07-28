// safe-git-allow: this is a test file for SafeGitExecutor's credential audit; direct git+fs usage is for fixture setup only.
//
// Inc-P3d — credential-resolution audit (observe-only).
// Covers BOTH sides of every decision boundary:
//   - repo-local-strip entry emitted when inherited identity is stripped
//   - NO entry when there was nothing to strip
//   - host-identity-inject entry emitted when host identity fills gaps
//   - per-process dedupe (recurring resolution recorded once)
//   - INSTAR_AUDIT_LOG_DISABLED suppresses writes entirely
//   - boot coherence: divergence detected, expected identity read from the
//     repo-local config, clean sample has no divergences (deterministic via
//     homeDirOverride), broken input never throws
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  _internal,
  auditBootCredentialCoherence,
  type CredentialResolutionEntry,
} from '../../src/core/SafeGitExecutor.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

function mkSandbox(prefix = 'cra-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function initRepo(dir: string, withIdentity = true): void {
  const env = sanitizedGitEnv();
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore', env });
  if (withIdentity) {
    execFileSync('git', ['config', 'user.email', 'agent@instar.local'], { cwd: dir, stdio: 'ignore', env });
    execFileSync('git', ['config', 'user.name', 'Instar Agent (test)'], { cwd: dir, stdio: 'ignore', env });
  }
}

function readEntries(dir: string): CredentialResolutionEntry[] {
  const file = path.join(dir, 'credential-resolution.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CredentialResolutionEntry);
}

const IDENTITY_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

let auditDir: string;
let savedIdentityEnv: Record<string, string | undefined>;

beforeAll(() => {
  savedIdentityEnv = {};
  for (const k of IDENTITY_KEYS) savedIdentityEnv[k] = process.env[k];
});

beforeEach(() => {
  auditDir = mkSandbox('cra-audit-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
  delete process.env.INSTAR_AUDIT_LOG_DISABLED;
  for (const k of IDENTITY_KEYS) delete process.env[k];
  _internal._resetLocalIdentityCacheForTest();
  _internal._resetCredentialAuditDedupeForTest();
});

afterAll(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  for (const k of IDENTITY_KEYS) {
    if (savedIdentityEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedIdentityEnv[k];
  }
});

describe('credential-resolution audit — sanitizeEnv emit (Inc-P3d)', () => {
  it('records a repo-local-strip entry when inherited identity is stripped', () => {
    const repo = mkSandbox('cra-repo-');
    initRepo(repo, true);
    const env = _internal.sanitizeEnv(
      { GIT_AUTHOR_NAME: 'Caroline', GIT_AUTHOR_EMAIL: 'caroline@example.com' },
      repo,
    );
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    const entries = readEntries(auditDir).filter((e) => e.kind === 'resolution');
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe('repo-local-strip');
    expect(entries[0].strippedKeys).toEqual(
      expect.arrayContaining(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL']),
    );
    expect(entries[0].cwd).toBe(repo);
    rmrf(repo);
  });

  it('records NOTHING when the env carried no identity to strip', () => {
    const repo = mkSandbox('cra-repo-');
    initRepo(repo, true);
    _internal.sanitizeEnv({}, repo);
    expect(readEntries(auditDir).filter((e) => e.kind === 'resolution')).toHaveLength(0);
    rmrf(repo);
  });

  it('records a host-identity-inject entry when host identity fills missing vars', () => {
    const repo = mkSandbox('cra-repo-');
    initRepo(repo, false); // no local identity → inject path
    // Author vars present in process.env feed getHostGitIdentity; committer
    // vars are absent from the caller env so the funnel injects them.
    process.env.GIT_AUTHOR_NAME = 'Host User';
    process.env.GIT_AUTHOR_EMAIL = 'host@example.com';
    const env = _internal.sanitizeEnv({}, repo);
    expect(env.GIT_COMMITTER_NAME).toBe('Host User');
    const entries = readEntries(auditDir).filter((e) => e.kind === 'resolution');
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe('host-identity-inject');
    expect(entries[0].injectedKeys).toEqual(
      expect.arrayContaining(['GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']),
    );
    rmrf(repo);
  });

  it('dedupes a recurring identical resolution within the process', () => {
    const repo = mkSandbox('cra-repo-');
    initRepo(repo, true);
    _internal.sanitizeEnv({ GIT_AUTHOR_NAME: 'Caroline' }, repo);
    _internal.sanitizeEnv({ GIT_AUTHOR_NAME: 'Caroline' }, repo);
    expect(readEntries(auditDir).filter((e) => e.kind === 'resolution')).toHaveLength(1);
    _internal._resetCredentialAuditDedupeForTest();
    _internal.sanitizeEnv({ GIT_AUTHOR_NAME: 'Caroline' }, repo);
    expect(readEntries(auditDir).filter((e) => e.kind === 'resolution')).toHaveLength(2);
    rmrf(repo);
  });

  it('writes nothing at all when INSTAR_AUDIT_LOG_DISABLED=1', () => {
    const repo = mkSandbox('cra-repo-');
    initRepo(repo, true);
    process.env.INSTAR_AUDIT_LOG_DISABLED = '1';
    _internal.sanitizeEnv({ GIT_AUTHOR_NAME: 'Caroline' }, repo);
    expect(readEntries(auditDir)).toHaveLength(0);
    delete process.env.INSTAR_AUDIT_LOG_DISABLED;
    rmrf(repo);
  });
});

describe('boot credential-coherence sample (Inc-P3d)', () => {
  it('reads the expected identity from the repo-local config and flags a divergent env var', () => {
    const repo = mkSandbox('cra-boot-');
    initRepo(repo, true);
    const fakeHome = mkSandbox('cra-home-'); // empty home → no global surface
    process.env.GIT_AUTHOR_NAME = 'Caroline';
    const report = auditBootCredentialCoherence(repo, fakeHome);
    expect(report).not.toBeNull();
    expect(report!.expected.name).toBe('Instar Agent (test)');
    expect(report!.expected.email).toBe('agent@instar.local');
    expect(report!.divergences.map((d) => d.surface)).toContain('env:GIT_AUTHOR_NAME');
    const entries = readEntries(auditDir).filter((e) => e.kind === 'boot-coherence');
    expect(entries).toHaveLength(1);
    expect(entries[0].expected?.name).toBe('Instar Agent (test)');
    rmrf(repo);
    rmrf(fakeHome);
  });

  it('reports zero divergences on a clean machine surface', () => {
    const repo = mkSandbox('cra-boot-');
    initRepo(repo, true);
    const fakeHome = mkSandbox('cra-home-');
    const report = auditBootCredentialCoherence(repo, fakeHome);
    expect(report).not.toBeNull();
    expect(report!.divergences).toHaveLength(0);
    rmrf(repo);
    rmrf(fakeHome);
  });

  it('flags a machine-global gitconfig identity that differs from the agent identity', () => {
    const repo = mkSandbox('cra-boot-');
    initRepo(repo, true);
    const fakeHome = mkSandbox('cra-home-');
    fs.writeFileSync(
      path.join(fakeHome, '.gitconfig'),
      '[user]\n\tname = Caroline\n\temail = caroline@example.com\n',
    );
    const report = auditBootCredentialCoherence(repo, fakeHome);
    expect(report).not.toBeNull();
    expect(report!.divergences.map((d) => d.surface)).toEqual(
      expect.arrayContaining(['global-gitconfig:user.name', 'global-gitconfig:user.email']),
    );
    rmrf(repo);
    rmrf(fakeHome);
  });

  it('reports gh CLI auth-state presence from the home surface', () => {
    const repo = mkSandbox('cra-boot-');
    initRepo(repo, true);
    const fakeHome = mkSandbox('cra-home-');
    fs.mkdirSync(path.join(fakeHome, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.config', 'gh', 'hosts.yml'), 'github.com:\n');
    const report = auditBootCredentialCoherence(repo, fakeHome);
    expect(report!.ghHostsPresent).toBe(true);
    rmrf(repo);
    rmrf(fakeHome);
  });

  it('never throws on a directory that is not a repo', () => {
    const notRepo = mkSandbox('cra-bare-');
    const fakeHome = mkSandbox('cra-home-');
    const report = auditBootCredentialCoherence(notRepo, fakeHome);
    expect(report).not.toBeNull();
    expect(report!.expected.name).toBeUndefined();
    rmrf(notRepo);
    rmrf(fakeHome);
  });
});
