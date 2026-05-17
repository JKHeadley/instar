/**
 * Unit tests for the lifeline shadow-install self-heal change
 * (docs/specs/lifeline-shadow-install-self-heal.md).
 *
 * Three covered surfaces:
 *
 *   1. The boot-wrapper template (bash + node) in installBootWrapper() now
 *      attempts ONE reinstall of the shadow-install before exiting when SHADOW
 *      is missing, debounced by a marker file.
 *
 *   2. The fleet-watchdog script template at
 *      src/templates/scripts/instar-watchdog.sh is well-formed and contains
 *      the PATH-resolved npm invocation + consecutive-fail counter + peer
 *      escalation logic.
 *
 *   3. PostUpdateMigrator.migrateFleetWatchdog() writes the script + plist to
 *      the user-machine paths on darwin, skips on non-darwin, idempotent on
 *      re-run, and validates the plist with plutil.
 *
 * Tests do NOT spawn launchd or run the actual watchdog (those need integration
 * harness). They exercise template content + migrator behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBootWrapper } from '../../src/commands/setup.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Boot-wrapper template content tests ─────────────────────────────

describe('installBootWrapper — shadow-install self-heal', () => {
  let tmp: string;
  let projectDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-wrapper-heal-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/lifeline-shadow-install-self-heal.test.ts:cleanup' }); } catch { /* best effort */ }
  });

  it('writes both bash and node wrappers', () => {
    const wrappers = installBootWrapper(projectDir);
    expect(fs.existsSync(wrappers.sh)).toBe(true);
    expect(fs.existsSync(wrappers.js)).toBe(true);
  });

  it('node wrapper contains shadow-install self-heal logic', () => {
    const wrappers = installBootWrapper(projectDir);
    const body = fs.readFileSync(wrappers.js, 'utf-8');
    // Heal marker + debounce
    expect(body).toContain('.heal-attempted');
    expect(body).toContain('5 * 60 * 1000');
    // Absolute-path resolution for node + npm
    expect(body).toContain('/opt/homebrew/bin/node');
    expect(body).toContain('/usr/local/bin/node');
    expect(body).toContain('npm-cli.js');
    // Recovery success messaging
    expect(body).toContain('Reinstall succeeded');
    // Stays the same on the failure path
    expect(body).toContain('Reinstall failed');
  });

  it('bash wrapper contains shadow-install self-heal logic', () => {
    const wrappers = installBootWrapper(projectDir);
    const body = fs.readFileSync(wrappers.sh, 'utf-8');
    // Heal marker + debounce
    expect(body).toContain('.heal-attempted');
    expect(body).toContain('-gt 300');
    // Absolute-path resolution for node + npm
    expect(body).toContain('/opt/homebrew/bin/node');
    expect(body).toContain('/usr/local/bin/node');
    // Recovery messaging
    expect(body).toContain('Reinstall succeeded');
    expect(body).toContain('Reinstall failed');
  });

  it('node wrapper still fails closed (exit 1) if no node/npm found at all', () => {
    const wrappers = installBootWrapper(projectDir);
    const body = fs.readFileSync(wrappers.js, 'utf-8');
    // The catch path must process.exit(1) — we don't want to silently mask a
    // hard failure as a healthy boot.
    expect(body).toContain("process.exit(1)");
  });

  it('node wrapper marker file path is sibling of shadow-install, not inside it', () => {
    const wrappers = installBootWrapper(projectDir);
    const body = fs.readFileSync(wrappers.js, 'utf-8');
    // The marker is `SHADOW_DIR + '.heal-attempted'` (not `path.join(SHADOW_DIR, '.heal-attempted')`)
    // so it survives when SHADOW_DIR itself is the thing missing.
    expect(body).toContain("SHADOW_DIR + '.heal-attempted'");
  });
});

// ── Fleet-watchdog template content tests ───────────────────────────

describe('fleet watchdog template (src/templates/scripts/instar-watchdog.sh)', () => {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'instar-watchdog.sh'),
    path.resolve(__dirname, '..', '..', 'dist', 'templates', 'scripts', 'instar-watchdog.sh'),
  ];

  function readTemplate(): string {
    for (const c of candidates) {
      if (fs.existsSync(c)) return fs.readFileSync(c, 'utf-8');
    }
    throw new Error('watchdog template not found in src or dist');
  }

  it('exists and is non-empty', () => {
    const body = readTemplate();
    expect(body.length).toBeGreaterThan(1000);
    expect(body.startsWith('#!/bin/bash')).toBe(true);
  });

  it('uses absolute-path node + npm-cli.js resolution (PATH-empty-launchd safe)', () => {
    const body = readTemplate();
    // No bare `npm install` (must invoke via absolute node + npm-cli.js)
    expect(body).toContain('/opt/homebrew/bin/node');
    expect(body).toContain('/usr/local/bin/node');
    expect(body).toContain('npm-cli.js');
    expect(body).toContain('/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js');
    expect(body).toContain('/usr/local/lib/node_modules/npm/bin/npm-cli.js');
    // resolve_node / resolve_npm helpers exist
    expect(body).toContain('resolve_node()');
    expect(body).toContain('resolve_npm()');
  });

  it('includes consecutive-fail counter + escalate-after threshold', () => {
    const body = readTemplate();
    expect(body).toMatch(/ESCALATE_AFTER_FAILS=.*:-3/);
    expect(body).toContain('bump_fail_counter');
    expect(body).toContain('reset_fail_counter');
    expect(body).toContain('consecutive-heal-fails');
  });

  it('escalates via peer agent /attention endpoint with category=degradation', () => {
    const body = readTemplate();
    expect(body).toContain('escalate_via_peer()');
    expect(body).toContain('/attention');
    expect(body).toContain('"category": "degradation"');
    // The ToneGate handles the wording — but our default payload (the JSON
    // sent to /attention) MUST be plain-English with no jargon (else B12
    // will block). Internal log lines + comments inside the script can use
    // any vocabulary; only the JSON payload reaches the user.
    expect(body).toContain('Want me to dig in?');
    // Extract the JSONEOF heredoc — that's the payload — and assert no jargon.
    const heredocMatch = body.match(/<<JSONEOF\n([\s\S]*?)\nJSONEOF/);
    expect(heredocMatch).not.toBeNull();
    const payload = heredocMatch![1].toLowerCase();
    // Each of these jargon terms is on the B12 list (HEALTH_ALERT_INTERNALS).
    expect(payload).not.toMatch(/crash[- ]loop/);
    expect(payload).not.toMatch(/\blifeline\b/);
    expect(payload).not.toMatch(/\bshadow[- ]install/);
    expect(payload).not.toMatch(/\blaunchd\b/);
    expect(payload).not.toMatch(/\bpid\b/);
  });

  it('treats 422 (tone-gate-reshape) as successful escalation, not failure', () => {
    const body = readTemplate();
    // 422 means tone gate fell back to SAFE_HEALTH_ALERT_TEMPLATE — user still got pinged
    expect(body).toContain('"422"');
    expect(body).toContain('reset_fail_counter');
  });

  it('skips the watchdog label itself (no self-supervision)', () => {
    const body = readTemplate();
    expect(body).toContain('ai.instar.watchdog');
    expect(body).toContain('continue');
  });
});

// ── PostUpdateMigrator.migrateFleetWatchdog tests ────────────────────

describe('PostUpdateMigrator.migrateFleetWatchdog', () => {
  let tmp: string;
  let projectDir: string;
  let stateDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watchdog-migrate-'));
    projectDir = path.join(tmp, 'agent');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    // Redirect HOME so the migration writes into a sandbox, not the real
    // ~/.instar or ~/Library/LaunchAgents.
    fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(path.join(fakeHome, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/lifeline-shadow-install-self-heal.test.ts:cleanup' }); } catch { /* best effort */ }
  });

  function buildMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({
      projectDir,
      stateDir,
      hasTelegram: false,
      port: 4042,
    });
  }

  it('skips on non-darwin platforms', () => {
    if (process.platform === 'darwin') return; // Only meaningful off-darwin
    const migrator = buildMigrator();
    const result = migrator.migrate();
    const skipped = result.skipped.find(s => s.startsWith('fleet-watchdog'));
    expect(skipped).toBeDefined();
    expect(skipped).toContain('non-darwin');
  });

  it('on darwin: writes script + plist to user paths on first run', () => {
    if (process.platform !== 'darwin') return; // darwin-only behavior
    const migrator = buildMigrator();
    // Stub out launchctl (the migrator catches and ignores failures, but a
    // sandbox HOME launchctl invocation would still be noisy).
    const result = migrator.migrate();

    const scriptPath = path.join(fakeHome, '.instar', 'instar-watchdog.sh');
    const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', 'ai.instar.watchdog.plist');

    // Either it upgraded OR it errored on launchctl in the sandbox (which is OK
    // for this test — we only care that the files landed).
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.existsSync(plistPath)).toBe(true);

    const scriptBody = fs.readFileSync(scriptPath, 'utf-8');
    expect(scriptBody).toContain('Instar Fleet Watchdog');
    expect(scriptBody).toContain('/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js');

    const plistBody = fs.readFileSync(plistPath, 'utf-8');
    expect(plistBody).toContain('<string>ai.instar.watchdog</string>');
    expect(plistBody).toContain('<integer>300</integer>');
    // PATH baked into plist
    expect(plistBody).toContain('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    // The migrator's launchctl invocations may have failed in the sandbox,
    // but the migration result should at least not crash.
    expect(Array.isArray(result.upgraded)).toBe(true);
  });

  it('on darwin: second run with identical content is a no-op', () => {
    if (process.platform !== 'darwin') return;
    const migrator = buildMigrator();
    migrator.migrate();
    // Second run
    const result2 = migrator.migrate();
    const skipped = result2.skipped.find(s => s.startsWith('fleet-watchdog'));
    expect(skipped).toBeDefined();
    expect(skipped).toContain('already up to date');
  });
});
