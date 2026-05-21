/**
 * Version-skew recovery — closes the 2026-05-20 b2lead-insights failure class.
 *
 * Failure shape:
 *   Server auto-updated to v1.1.0; lifeline kept running v1.0.13. The
 *   server's /internal/telegram-forward endpoint enforces a major/minor
 *   compatibility check and returned HTTP 426 to every forward. The
 *   lifeline:
 *     1. Threw ForwardVersionSkewError on each forward.
 *     2. Requested a self-restart, blocked by rate-limit cooldown.
 *     3. Counted each failed forward toward MAX_REPLAY_FAILURES (3).
 *     4. SILENTLY DROPPED user messages after 3 attempts.
 *   Total impact: 21h of silent ingress drops, only discovered when the
 *   user complained.
 *
 * Fixes asserted here:
 *   A. rateLimitState.decide(): versionSkew bucket bypasses cooldown
 *      (covered in tests/unit/lifeline/rateLimitState.test.ts).
 *   B. CLI service label: `ai.instar.<projectName>` not
 *      `com.instar.<projectName>.lifeline` so launchctl kickstart
 *      actually resolves the service.
 *   C. Native rebuild uses --build-from-source to avoid the
 *      "rebuild succeeded but module still fails to load" pattern.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('Version-skew recovery — CLI service label', () => {
  it('uses ai.instar.<projectName> not com.instar.<projectName>.lifeline', () => {
    const cliSource = fs.readFileSync(path.join(repoRoot, 'src', 'cli.ts'), 'utf-8');
    // Lifeline restart command must build the label matching the plist
    // that installMacOSLaunchAgent writes (see src/commands/setup.ts).
    const restartSection = extractSectionAroundFirstMatch(
      cliSource,
      /lifelineCmd\s*\.command\('restart'\)/,
      8000,
    );
    expect(restartSection).toBeTruthy();
    // Modern label
    expect(restartSection).toMatch(/`ai\.instar\.\$\{[^}]+\}`/);
    // Reject the legacy wrong label that triggered the b2lead incident
    // (caused launchctl kickstart to fail and fall back to pkill).
    expect(restartSection).not.toMatch(/`com\.instar\.\$\{[^}]+\}\.lifeline`/);
  });

  it('pkill fallback escalates to SIGKILL after SIGTERM grace', () => {
    const cliSource = fs.readFileSync(path.join(repoRoot, 'src', 'cli.ts'), 'utf-8');
    const restartSection = extractSectionAroundFirstMatch(
      cliSource,
      /lifelineCmd\s*\.command\('restart'\)/,
      8000,
    );
    // SIGTERM path
    expect(restartSection).toMatch(/pkill -TERM/);
    // Escalation path
    expect(restartSection).toMatch(/pkill -KILL/);
  });
});

describe('Version-skew recovery — native rebuild uses --build-from-source', () => {
  it('ServerSupervisor preflight rebuild passes --build-from-source', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'ServerSupervisor.ts'),
      'utf-8',
    );
    // Find the rebuildArgs assignment used for the better-sqlite3 rebuild.
    const rebuildArgsLine = src.match(/const\s+rebuildArgs\s*=\s*\[([\s\S]*?)\]/);
    expect(rebuildArgsLine).toBeTruthy();
    const body = rebuildArgsLine?.[1] ?? '';
    expect(body).toMatch(/'--build-from-source'/);
    expect(body).toMatch(/'--ignore-scripts'/);
    expect(body).toMatch(/'better-sqlite3'/);
  });

  it('NativeModuleHealer in-line rebuild passes --build-from-source', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'memory', 'NativeModuleHealer.ts'),
      'utf-8',
    );
    // The in-line healBetterSqlite3Sync path used to be the one that
    // missed the flag (the Remediator-orchestrated path already had it).
    // Make sure BOTH paths now use --build-from-source. We assert that
    // every spawnSync that targets `npm rebuild ... better-sqlite3` in
    // this file includes the flag.
    const rebuildSpawns = [...src.matchAll(/spawnSync\(\s*[^,]+,\s*\[\s*([^\]]+)\]/g)]
      .map(m => m[1])
      .filter(args => args.includes("'rebuild'") && args.includes("'better-sqlite3'"));
    expect(rebuildSpawns.length).toBeGreaterThan(0);
    for (const args of rebuildSpawns) {
      expect(args).toMatch(/'--build-from-source'/);
    }
  });
});

describe('Version-skew recovery — replay drop-policy', () => {
  it('lifeline source guards drop with versionSkewActive', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    // The flag must exist as instance state.
    expect(src).toMatch(/versionSkewActive\s*=\s*false/);
    // The replay loop must check it BEFORE the drop check.
    const replayLoop = src.slice(
      src.indexOf('private async replayQueue('),
      src.indexOf('private async replayQueue(') + 6000,
    );
    expect(replayLoop).toContain('versionSkewActive');
    // Drop branch must come AFTER the versionSkew bypass in the loop body.
    const skewIdx = replayLoop.indexOf('versionSkewActive');
    const dropIdx = replayLoop.indexOf('MAX_REPLAY_FAILURES');
    expect(skewIdx).toBeGreaterThan(0);
    expect(dropIdx).toBeGreaterThan(0);
    expect(skewIdx).toBeLessThan(dropIdx);
  });

  it('handleVersionSkew sets the active flag + alert dedupe', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    const handler = src.slice(
      src.indexOf('private handleVersionSkew('),
      src.indexOf('private handleVersionSkew(') + 3000,
    );
    expect(handler).toContain('this.versionSkewActive = true');
    expect(handler).toContain('versionSkewAlertSentAt');
    expect(handler).toContain('sendToTopic'); // user-visible alert
  });

  it('forwardToServer success clears the version-skew episode flag', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    // The clear must live in the post-success block (after the catch ladder).
    const fwd = src.slice(
      src.indexOf('private async forwardToServer('),
      src.indexOf('private handleVersionSkew('),
    );
    expect(fwd).toContain('this.versionSkewActive = false');
    expect(fwd).toContain('this.versionSkewAlertSentAt = 0');
  });
});

describe('Version-skew recovery — stuck-lock detection', () => {
  it('lock-acquire treats sleeping (S) state > 5 min as recoverable', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    const lockFn = src.slice(
      src.indexOf('function acquireLockFile('),
      src.indexOf('function acquireLockFile(') + 5000,
    );
    // Existing zombie/stopped path retained
    expect(lockFn).toMatch(/Z.*T|isZombieOrStopped/);
    // New wedged-sleeping path
    expect(lockFn).toMatch(/isWedgedSleeping|^S/m);
    // Escalation: SIGTERM then SIGKILL after grace
    expect(lockFn).toContain('SIGTERM');
    expect(lockFn).toContain('SIGKILL');
  });
});

/**
 * Helper: pull a region of the file starting at the first regex match,
 * returning up to `length` characters of context. Lets us scope source
 * assertions to a specific lexical block instead of grepping the whole
 * file (which is fragile to unrelated changes).
 */
function extractSectionAroundFirstMatch(
  src: string,
  needle: RegExp,
  length: number,
): string | null {
  const m = needle.exec(src);
  if (!m) return null;
  return src.slice(m.index, m.index + length);
}
