/**
 * Tests for macOS launchd crash-loop prevention in the auto-updater.
 *
 * Bug: Auto-update downloads to shadow-install via npm. launchd restarts the
 * process, but macOS security attributes (quarantine/provenance) on npm-downloaded
 * files cause EPERM in launchd's restricted sandbox, triggering a crash loop.
 *
 * Fix (defense in depth):
 *   1. Strip removable xattrs after npm install (quarantine is removable, provenance isn't on macOS 15+)
 *   2. Pre-restart access validation — verify node can read the new CLI before signaling restart
 *   3. Boot wrapper crash loop protection — detect rapid failures and backoff
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Launchd crash loop prevention — UpdateChecker', () => {
  const updateCheckerPath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
  const source = fs.readFileSync(updateCheckerPath, 'utf-8');

  it('imports execFileSync for synchronous operations', () => {
    expect(source).toContain('execFileSync');
  });

  it('imports os module for platform detection', () => {
    expect(source).toMatch(/import.*os.*from.*'node:os'/);
  });

  it('checks platform is darwin before stripping xattrs', () => {
    expect(source).toContain("os.platform() === 'darwin'");
  });

  it('strips com.apple.quarantine (removable on all macOS versions)', () => {
    expect(source).toContain("'com.apple.quarantine'");
  });

  it('attempts com.apple.provenance stripping (harmless no-op on macOS 15+)', () => {
    expect(source).toContain("'com.apple.provenance'");
  });

  it('performs pre-restart access validation on the new CLI', () => {
    // Candidate validation must run the new CLI before it can be promoted.
    expect(source).toContain('this.validateCandidate(candidateDir, targetVersion)');
    expect(source).toContain("[newCliPath, '--version']");
    expect(source).toContain('readFileSync');
    expect(source).toContain('newCliPath');
  });

  it('access validation uses the correct shadow install path', () => {
    expect(source).toContain("path.join(shadowDir, 'node_modules', 'instar', 'dist', 'cli.js')");
  });

  it('access validation failure prevents promotion', () => {
    const validateIndex = source.indexOf('this.validateCandidate(candidateDir, targetVersion)');
    const promoteIndex = source.indexOf('this.promoteCandidate(candidateDir)');
    expect(validateIndex).toBeGreaterThan(0);
    expect(promoteIndex).toBeGreaterThan(validateIndex);
    expect(source.slice(validateIndex, promoteIndex)).toContain('catch (err)');
  });

  it('xattr stripping happens after npm install and rebuild', () => {
    const rebuildIndex = source.indexOf('Rebuilt better-sqlite3');
    const xattrIndex = source.indexOf('com.apple.quarantine');
    expect(xattrIndex).toBeGreaterThan(rebuildIndex);
  });

  it('access validation happens after xattr stripping', () => {
    const xattrIndex = source.indexOf('xattr cleanup');
    const validationIndex = source.indexOf('this.validateCandidate(candidateDir, targetVersion)');
    expect(validationIndex).toBeGreaterThan(xattrIndex);
  });
});

describe('Launchd crash loop prevention — boot wrapper', () => {
  const setupPath = path.resolve(__dirname, '../../src/commands/setup.ts');
  const source = fs.readFileSync(setupPath, 'utf-8');

  it('strips com.apple.quarantine xattr before exec', () => {
    expect(source).toContain('xattr -rd com.apple.quarantine');
  });

  it('attempts com.apple.provenance stripping', () => {
    expect(source).toContain('xattr -rd com.apple.provenance');
  });

  it('checks for xattr command existence', () => {
    expect(source).toContain('command -v xattr');
  });

  it('suppresses xattr errors', () => {
    expect(source).toContain('2>/dev/null || true');
  });

  it('implements crash loop detection', () => {
    expect(source).toContain('Crash loop');
    expect(source).toContain('CRASH_FILE');
  });

  it('tracks crash timestamps for rate detection', () => {
    // Counts recent crashes within a time window
    expect(source).toContain('now - 120');
  });

  it('backs off progressively on repeated crashes', () => {
    expect(source).toContain('BACKOFF');
    expect(source).toContain('sleep $BACKOFF');
  });

  it('caps backoff at 120 seconds', () => {
    expect(source).toContain('-gt 120');
  });

  it('clears crash history on clean exit', () => {
    expect(source).toContain('Clean exit');
    expect(source).toContain('rm -f "$CRASH_FILE"');
  });

  it('trims crash file to prevent unbounded growth', () => {
    expect(source).toContain('tail -20');
  });

  it('xattr stripping happens before node execution', () => {
    const xattrIndex = source.indexOf('xattr -rd com.apple.quarantine');
    const nodeIndex = source.indexOf('node "$SHADOW" "$@"');
    expect(xattrIndex).toBeGreaterThan(-1);
    expect(nodeIndex).toBeGreaterThan(-1);
    expect(xattrIndex).toBeLessThan(nodeIndex);
  });

  it('does not use exec (captures exit code for crash tracking)', () => {
    // The old wrapper used `exec node` which replaces the shell — can't track exit codes.
    // The new wrapper runs node as a child to capture EXIT_CODE.
    const wrapperSection = source.substring(
      source.indexOf('# Crash loop protection'),
      source.indexOf('# Clean exit')
    );
    expect(wrapperSection).not.toContain('exec node');
    expect(wrapperSection).toContain('EXIT_CODE=$?');
  });
});
