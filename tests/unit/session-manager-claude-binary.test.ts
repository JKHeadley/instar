// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Wiring-integrity tests — SessionManager × ClaudeBinaryRetainer (CMT-798).
 *
 * The retainer is only worth anything if the spawn path actually consults
 * it. These tests drive the ONE chokepoint every claude-code launch goes
 * through (`resolveLaunchBinary`) with a real SessionManager and a real
 * fake-npm layout on disk, and check both sides of each boundary:
 * claude-code → retained path; any other framework → untouched; off switch →
 * untouched; the status read reflects what the spawn path did; the default
 * retain dir lives under the agent's state dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ClaudeBinaryRetainer, RETAINED_BINARY_NAME, resolveRetainerEnabled } from '../../src/core/ClaudeBinaryRetainer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/session-manager-claude-binary.test.ts';

function fakeInstall(root: string, version: string): { exe: string; link: string } {
  const pkgDir = path.join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  const exe = path.join(pkgDir, 'bin', 'claude.exe');
  fs.writeFileSync(exe, `FAKE-CLAUDE-${version}\n`, { mode: 0o755 });
  const link = path.join(root, 'bin', 'claude');
  fs.symlinkSync(path.relative(path.dirname(link), exe), link);
  return { exe, link };
}

describe('SessionManager launches claude-code from the retained copy (CMT-798)', () => {
  let projectDir: string;
  let claude: { exe: string; link: string };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-claude-bin-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claude = fakeInstall(path.join(projectDir, 'fake-install'), '2.1.299');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }); });

  const newSm = (retainedClaudeBinary?: { enabled?: boolean; dir?: string; pruneGraceMs?: number }) =>
    new SessionManager({
      tmuxPath: '/usr/bin/false', claudePath: claude.link, projectDir,
      maxSessions: 1, protectedSessions: [], completionPatterns: [],
      // Under vitest the default resolves OFF (see resolveRetainerEnabled); these
      // tests exercise the ON path explicitly, exactly as production resolves it.
      retainedClaudeBinary: retainedClaudeBinary ?? { enabled: true },
    }, new StateManager(projectDir));

  it('claude-code → the retained per-version path under <projectDir>/.instar/state/claude-bin by default', () => {
    const sm = newSm();
    const launched = sm.resolveLaunchBinary('claude-code', claude.link);
    const expectedDir = ClaudeBinaryRetainer.defaultDir(projectDir);
    expect(expectedDir).toBe(path.join(projectDir, '.instar', 'state', 'claude-bin'));
    expect(launched).toBe(path.join(expectedDir, '2.1.299', RETAINED_BINARY_NAME));
    expect(fs.readFileSync(launched, 'utf8')).toBe('FAKE-CLAUDE-2.1.299\n');
    const status = sm.claudeBinaryStatus();
    expect(status.enabled).toBe(true);
    expect(status.dir).toBe(expectedDir);
    expect(status.current?.key).toBe('2.1.299');
    expect(status.lastResolution?.source).toBe('retained');
    expect(status.lastResolution?.copied).toBe(true);
  });

  it('is byte-for-byte the SAME copy on every spawn (no re-copy), and a simulated update moves new spawns to a new dir', () => {
    const sm = newSm();
    const a = sm.resolveLaunchBinary('claude-code', claude.link);
    const b = sm.resolveLaunchBinary('claude-code', claude.link);
    expect(b).toBe(a);
    expect(sm.claudeBinaryStatus().counters.copies).toBe(1);
    const inoA = fs.statSync(a).ino;
    // npm update: replace in place
    fs.writeFileSync(path.join(path.dirname(path.dirname(claude.exe)), 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.300' }));
    fs.writeFileSync(claude.exe + '.new', 'FAKE-CLAUDE-2.1.300\n', { mode: 0o755 });
    fs.renameSync(claude.exe + '.new', claude.exe);
    const c = sm.resolveLaunchBinary('claude-code', claude.link);
    expect(c).not.toBe(a);
    expect(c).toContain(`${path.sep}2.1.300${path.sep}`);
    expect(fs.statSync(a).ino).toBe(inoA); // old copy untouched
    expect(fs.statSync(a).nlink).toBeGreaterThan(0);
  });

  it('other frameworks pass through untouched (codex / gemini / pi / grok)', () => {
    const sm = newSm();
    for (const fw of ['codex-cli', 'gemini-cli', 'pi-cli', 'grok-build'] as const) {
      expect(sm.resolveLaunchBinary(fw, '/opt/tools/bin/thing')).toBe('/opt/tools/bin/thing');
    }
    expect(sm.claudeBinaryStatus().counters.resolutions).toBe(0);
    expect(fs.existsSync(ClaudeBinaryRetainer.defaultDir(projectDir))).toBe(false);
  });

  it('the off switch (sessions.retainedClaudeBinary.enabled=false) launches from the configured path and creates nothing', () => {
    const sm = newSm({ enabled: false });
    expect(sm.resolveLaunchBinary('claude-code', claude.link)).toBe(claude.link);
    const status = sm.claudeBinaryStatus();
    expect(status.enabled).toBe(false);
    expect(status.lastResolution?.reason).toBe('disabled');
    expect(fs.existsSync(ClaudeBinaryRetainer.defaultDir(projectDir))).toBe(false);
  });

  it('a custom dir + pruneGraceMs from config are honoured', () => {
    const dir = path.join(projectDir, 'elsewhere', 'claude-bin');
    const sm = newSm({ enabled: true, dir, pruneGraceMs: 42 });
    const launched = sm.resolveLaunchBinary('claude-code', claude.link);
    expect(launched).toBe(path.join(dir, '2.1.299', RETAINED_BINARY_NAME));
    expect(sm.claudeBinaryStatus()).toMatchObject({ dir, pruneGraceMs: 42 });
  });

  it('a retainer fallback never blocks the spawn: the configured path is returned and the status names the reason', () => {
    // A wrapper script is a legitimate claudePath; it is launched as-is.
    fs.writeFileSync(claude.exe, '#!/bin/sh\nexec /real/claude "$@"\n', { mode: 0o755 });
    const sm = newSm();
    expect(sm.resolveLaunchBinary('claude-code', claude.link)).toBe(claude.link);
    expect(sm.claudeBinaryStatus().lastResolution?.reason).toBe('script-not-retained');
  });

  it('under a test runner the DEFAULT resolves off, so argv-pinning tests stay host-independent; production default is on', () => {
    expect(process.env.VITEST).toBeTruthy();
    const sm = new SessionManager({
      tmuxPath: '/usr/bin/false', claudePath: claude.link, projectDir,
      maxSessions: 1, protectedSessions: [], completionPatterns: [],
    }, new StateManager(projectDir));
    expect(sm.resolveLaunchBinary('claude-code', claude.link)).toBe(claude.link);
    expect(sm.claudeBinaryStatus().enabled).toBe(false);
    expect(resolveRetainerEnabled(undefined, {})).toBe(true);
    expect(resolveRetainerEnabled(undefined, { VITEST: 'true' })).toBe(false);
    expect(resolveRetainerEnabled(true, { VITEST: 'true' })).toBe(true);
    expect(resolveRetainerEnabled(false, {})).toBe(false);
  });

  it('pruneRetainedClaudeBinaries() runs a real pass and reports it on the status read', async () => {
    const sm = newSm();
    sm.resolveLaunchBinary('claude-code', claude.link);
    const r = await sm.pruneRetainedClaudeBinaries();
    expect(r.keptCurrent).toEqual(['2.1.299']);
    expect(r.removed).toEqual([]);
    expect(sm.claudeBinaryStatus().lastPrune?.at).toBe(r.at);
  });
});
