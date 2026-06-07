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

describe('Version-skew recovery — native rebuild is ABI-pinned + prebuilt-first', () => {
  // Updated 2026-05-29 (PR #539): the rebuild no longer uses --build-from-source
  // as the ONLY strategy. `npm rebuild` always node-gyp-compiles and can't fetch
  // a prebuilt, so on a box without a C++ toolchain it can never heal (it left
  // instar-codey's sqlite offline 16h). Both paths now PIN the toolchain to the
  // server/running Node (correct ABI regardless of PATH) and PREFER the prebuilt
  // (`npm install` → prebuild-install) with --build-from-source as the fallback.
  it('ServerSupervisor preflight rebuild pins the server Node and prefers the prebuilt', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'ServerSupervisor.ts'),
      'utf-8',
    );
    expect(src).toMatch(/npm_node_execpath/);            // toolchain pinned to the server Node
    expect(src).toMatch(/'install'/);                    // prebuilt-first (prebuild-install)
    expect(src).toMatch(/'--build-from-source'/);        // compile fallback retained
    expect(src).toMatch(/'--ignore-scripts'/);
    expect(src).toMatch(/'better-sqlite3'/);
  });

  it('NativeModuleHealer in-line rebuild pins the running Node and prefers the prebuilt', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'memory', 'NativeModuleHealer.ts'),
      'utf-8',
    );
    expect(src).toMatch(/npm_node_execpath/);            // toolchain pinned to the running Node
    expect(src).toMatch(/'install'/);                    // prebuilt-first
    expect(src).toMatch(/'--build-from-source'/);        // compile fallback retained
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
    // The per-message replay decision must come AFTER the versionSkew bypass.
    const skewIdx = replayLoop.indexOf('versionSkewActive');
    const decisionIdx = replayLoop.indexOf('decideReplay(');
    expect(skewIdx).toBeGreaterThan(0);
    expect(decisionIdx).toBeGreaterThan(0);
    expect(skewIdx).toBeLessThan(decisionIdx);
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

describe('Replay drop-policy — only a message-specific (HTTP 400) failure may drop a message', () => {
  // Failure shape (2026-06-05 codey; 2026-06-06 topic-21487): a restart /
  // CPU-starvation window made every forward fail transiently; the old
  // single-counter policy (`supervisor.healthy ? failures + 1 : failures`)
  // burned all 3 attempts and DROPPED real messages. The classified policy
  // (replayPolicy.decideReplay) only burns the drop budget on a genuine 400
  // ('poison'); timeout / 5xx / 503-boot / network refusal are 'transient' and
  // never drop a real message. The behavioral coverage lives in
  // tests/unit/lifeline/replayPolicy.test.ts — these assertions pin the wiring.

  it('replayQueue routes failures through the classified forward + decideReplay (not the old healthy-gated counter)', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    const replayLoop = extractSectionAroundFirstMatch(
      src,
      /private async replayQueue\(/,
      8000,
    );
    expect(replayLoop).toBeTruthy();
    // New policy is wired in…
    expect(replayLoop).toContain('forwardToServerClassified(');
    expect(replayLoop).toContain('decideReplay(');
    // …and the old coarse single-counter increment is GONE.
    expect(replayLoop).not.toMatch(
      /replayFailures\s*=\s*this\.supervisor\.healthy\s*\?\s*failures\s*\+\s*1/,
    );
  });

  it('replay consumes the queue DURABLY (peek + remove), never drain() — no untracked loss', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    const replayLoop = extractSectionAroundFirstMatch(
      src,
      /private async replayQueue\(/,
      8000,
    );
    expect(replayLoop).toBeTruthy();
    // A message leaves the persisted queue only after delivery/drop.
    expect(replayLoop).toContain('this.queue.peek()');
    expect(replayLoop).toContain('this.queue.remove(');
    expect(replayLoop).toContain('this.queue.updateReplayCounters(');
    // The destructive up-front drain() must NOT be used by replay.
    expect(replayLoop).not.toContain('this.queue.drain()');
  });

  it('forwardToServerClassified maps a 400 to poison and everything else to transient/skew', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'lifeline', 'TelegramLifeline.ts'),
      'utf-8',
    );
    const fn = extractSectionAroundFirstMatch(
      src,
      /private async forwardToServerClassified\(/,
      8000,
    );
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/ForwardBadRequestError\)\s*return 'poison'/);
    expect(fn).toContain("return 'transient'");
    expect(fn).toContain("return 'skew'");
    expect(fn).toContain("return 'ok'");
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
