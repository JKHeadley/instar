// safe-git-allow: integration test for the credential-resolution audit; direct git+fs usage is for fixture setup and verification only.
//
// Inc-P3d Tier-2 — the OBSERVED Caroline replay: a real commit through the
// real funnel under a fully polluted environment must (a) land as the
// repo-local agent identity (the P3a guarantee) AND (b) leave a durable
// repo-local-strip line in credential-resolution.jsonl (the P3d guarantee).
// Also proves the audit is signal-only: with the audit disabled the same
// operation still succeeds — observability never gates the operation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SafeGitExecutor,
  _internal,
  type CredentialResolutionEntry,
} from '../../src/core/SafeGitExecutor.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

function mkSandbox(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function initAgentRepo(dir: string): void {
  const env = sanitizedGitEnv();
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['config', 'user.name', 'Instar Agent (itest)'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['config', 'user.email', 'itest@instar.local'], { cwd: dir, stdio: 'ignore', env });
  fs.writeFileSync(path.join(dir, 'seed'), 'seed');
  execFileSync('git', ['add', 'seed'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'ignore', env });
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

const POLLUTED = {
  GIT_AUTHOR_NAME: 'Caroline',
  GIT_AUTHOR_EMAIL: 'caroline@other.example',
  GIT_COMMITTER_NAME: 'Caroline',
  GIT_COMMITTER_EMAIL: 'caroline@other.example',
};

let auditDir: string;
let repo: string;

beforeEach(() => {
  auditDir = mkSandbox('crf-audit-');
  repo = mkSandbox('crf-repo-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
  delete process.env.INSTAR_AUDIT_LOG_DISABLED;
  initAgentRepo(repo);
  _internal._resetLocalIdentityCacheForTest();
  _internal._resetCredentialAuditDedupeForTest();
});

afterEach(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  rmrf(auditDir);
  rmrf(repo);
});

describe('credential-resolution audit — observed Caroline replay (Inc-P3d)', () => {
  it('a real funnel commit under a polluted env lands as the agent AND is recorded', () => {
    fs.writeFileSync(path.join(repo, 'work.txt'), 'phase-3d');
    execFileSync('git', ['add', 'work.txt'], { cwd: repo, stdio: 'ignore', env: sanitizedGitEnv() });
    SafeGitExecutor.execSync(['commit', '-m', 'agent work'], {
      cwd: repo,
      operation: 'inc-p3d-test-commit',
      env: POLLUTED,
    });
    // (a) The P3a guarantee still holds: the commit is the agent's.
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
      cwd: repo, encoding: 'utf-8', env: sanitizedGitEnv(),
    }).trim();
    expect(author).toBe('Instar Agent (itest) <itest@instar.local>');
    // (b) The P3d guarantee: the strip decision is durably observable.
    const entries = readEntries(auditDir).filter((e) => e.kind === 'resolution');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const strip = entries.find((e) => e.decision === 'repo-local-strip');
    expect(strip).toBeDefined();
    expect(strip!.strippedKeys).toEqual(
      expect.arrayContaining([
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ]),
    );
    expect(strip!.cwd).toBe(repo);
  });

  it('the audit is signal-only: with auditing disabled the same operation still succeeds', () => {
    process.env.INSTAR_AUDIT_LOG_DISABLED = '1';
    fs.writeFileSync(path.join(repo, 'work2.txt'), 'phase-3d');
    execFileSync('git', ['add', 'work2.txt'], { cwd: repo, stdio: 'ignore', env: sanitizedGitEnv() });
    SafeGitExecutor.execSync(['commit', '-m', 'agent work 2'], {
      cwd: repo,
      operation: 'inc-p3d-test-commit-disabled',
      env: POLLUTED,
    });
    const author = execFileSync('git', ['log', '-1', '--format=%an'], {
      cwd: repo, encoding: 'utf-8', env: sanitizedGitEnv(),
    }).trim();
    expect(author).toBe('Instar Agent (itest)');
    expect(readEntries(auditDir)).toHaveLength(0);
    delete process.env.INSTAR_AUDIT_LOG_DISABLED;
  });

  it('a recurring sync-style resolution is recorded once, not flooded', () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(repo, `w${i}.txt`), String(i));
      execFileSync('git', ['add', `w${i}.txt`], { cwd: repo, stdio: 'ignore', env: sanitizedGitEnv() });
      SafeGitExecutor.execSync(['commit', '-m', `work ${i}`], {
        cwd: repo,
        operation: 'inc-p3d-sync-loop',
        env: POLLUTED,
      });
    }
    const strips = readEntries(auditDir).filter((e) => e.decision === 'repo-local-strip');
    expect(strips).toHaveLength(1);
  });
});
