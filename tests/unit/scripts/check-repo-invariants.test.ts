// safe-git-allow: test uses fs.rmSync for tmpdir cleanup; no git ops.
/**
 * Tests for scripts/check-repo-invariants.js — Layer 4 of the
 * test-env-isolation defense (PRs #130/#277 root cause).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-repo-invariants.mjs');

function runInvariants(cwd: string, extraEnv: NodeJS.ProcessEnv = {}): { exitCode: number; stderr: string; stdout: string } {
  const r = spawnSync('node', [SCRIPT], { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf-8' });
  return { exitCode: r.status ?? -1, stderr: r.stderr, stdout: r.stdout };
}

function fakeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-test-'));
  // 120 lines so the default 100-line floor is met.
  fs.writeFileSync(path.join(dir, 'README.md'), Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n'));
  return dir;
}

describe('check-repo-invariants', () => {
  let dir: string;
  beforeEach(() => { dir = fakeRepo(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('passes for a healthy repo', () => {
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(0);
  });

  it('fails when README is missing', () => {
    fs.unlinkSync(path.join(dir, 'README.md'));
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('README.md is missing');
  });

  it('fails when README drops below the line floor', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/README\.md has \d+ lines/);
  });

  it('fails when file-0.txt is present at root', () => {
    fs.writeFileSync(path.join(dir, 'file-0.txt'), 'stowaway');
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('file-0.txt');
  });

  it('fails when seed is present at root', () => {
    fs.writeFileSync(path.join(dir, 'seed'), 'stowaway');
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('seed');
  });

  it('honors INSTAR_README_MIN_LINES override', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'just one line');
    const r = runInvariants(dir, { INSTAR_README_MIN_LINES: '0' });
    expect(r.exitCode).toBe(0);
  });

  // ── Invariant 3: release-note fragments assemble + validate ──────
  // Server-side twin of the pre-push gate's §1 — a malformed fragment that
  // reaches main jams EVERY release at publish-time (v1.3.180, #781).

  function writeFragment(name: string, content: string): void {
    fs.mkdirSync(path.join(dir, 'upgrades', 'next'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'upgrades', 'next', name), content);
  }

  const VALID_FRAGMENT =
    '<!-- bump: patch -->\n\n# Some fix\n\n' +
    '## What to Tell Your User\n\nNothing user-visible; an internal fix.\n\n' +
    '## Summary of New Capabilities\n\n- An internal robustness fix landed.\n\n' +
    '## What Changed\n\nInternal plumbing only, no behavior change for users.\n';

  it('passes when fragments assemble and validate cleanly', () => {
    writeFragment('good.md', VALID_FRAGMENT);
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(0);
  });

  it('fails LOUDLY when a fragment is malformed (assembly throws) — the publish-jam class', () => {
    // Content but no parseable H2 section — assembleNextMd throws on this.
    writeFragment('broken.md', 'just some prose with no sections at all\n');
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/malformed|fail validation/i);
    expect(r.stderr).toContain('jam the publish workflow');
  });

  it('fails when the assembled guide misses a required section (validator issue)', () => {
    writeFragment('incomplete.md',
      '<!-- bump: patch -->\n\n## What Changed\n\nSomething changed but no user sections exist.\n');
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('jam the publish workflow');
  });

  it('passes when no upgrades dir / no fragments exist (post-release-cut state)', () => {
    // fakeRepo has no upgrades dir at all — covered by the healthy test, but
    // also pin the empty-fragments-dir shape explicitly.
    fs.mkdirSync(path.join(dir, 'upgrades', 'next'), { recursive: true });
    const r = runInvariants(dir);
    expect(r.exitCode).toBe(0);
  });
});
