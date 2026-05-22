/**
 * Integration test: server-side 426 + AutoUpdater signal write +
 * lifeline tick consumer produce the coordinated restart we expect.
 *
 * We don't spawn a real lifeline or server here. Instead we drive the
 * three independent code paths directly and assert their shared
 * signal-file contract holds.
 *
 * Spec: docs/specs/auto-updater-lifeline-coordination.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  crossesBreaking,
  writeLifelineRestartSignal,
  readLifelineRestartSignal,
  clearLifelineRestartSignal,
  lifelineRestartSignalPath,
} from '../../src/core/version-skew.js';
import { decide as decideRateLimit } from '../../src/lifeline/rateLimitState.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('coordinated restart pipeline — writers and consumers agree on the signal contract', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-restart-'));
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/auto-updater-lifeline-handshake.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  it('AutoUpdater writer + lifeline reader round-trip preserves all fields', () => {
    // Simulate AutoUpdater detecting a major.minor crossing and writing the signal.
    expect(crossesBreaking('1.1.0', '1.2.28')).toBe(true);
    const writeResult = writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'auto-updater',
      reason: 'version-bump-crossing-major-minor',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(writeResult).toBe('written');

    // Lifeline-side reader picks up the signal and decides to restart.
    const signal = readLifelineRestartSignal(stateDir);
    expect(signal).not.toBeNull();
    expect(signal!.requestedBy).toBe('auto-updater');
    expect(signal!.targetVersion).toBe('1.2.28');

    // Lifeline first action: clear the signal so a respawn doesn't re-fire.
    clearLifelineRestartSignal(stateDir);
    expect(readLifelineRestartSignal(stateDir)).toBeNull();
  });

  it('server-426 writer is idempotent vs AutoUpdater writer when targetVersion matches', () => {
    // AutoUpdater writes first.
    writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'auto-updater',
      reason: 'version-bump',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });

    // Server then sees a 426 and tries to write — should skip because the
    // signal is already fresh with the same target.
    const second = writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'server-426',
      reason: 'server-426-direct-evidence',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(second).toBe('skipped-fresh');

    // Original AutoUpdater write preserved.
    const signal = readLifelineRestartSignal(stateDir);
    expect(signal!.requestedBy).toBe('auto-updater');
  });

  it('PostUpdateMigrator bootstrap writer fills the gap when neither AutoUpdater nor server got there first', () => {
    expect(readLifelineRestartSignal(stateDir)).toBeNull();

    // First update post-PR-#284: agent's old lifeline never wrote a signal.
    // The migrator writes one as the bootstrap.
    const written = writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'post-update-migrator-bootstrap',
      reason: 'stale-lifeline-bootstrap',
      previousVersion: '1.0.13',
      targetVersion: '1.2.28',
    });
    expect(written).toBe('written');

    const signal = readLifelineRestartSignal(stateDir);
    expect(signal!.requestedBy).toBe('post-update-migrator-bootstrap');
    expect(signal!.previousVersion).toBe('1.0.13');
  });

  it('rate-limit plannedUpgrade bucket bypasses cooldown so the lifeline can act immediately on the signal', () => {
    // Simulate a recent watchdog restart (1 min ago — well within cooldown).
    const now = Date.now();
    const justNow = new Date(now - 60_000).toISOString();
    const state = {
      lastRestartAt: justNow,
      history: [{ at: justNow, reason: 'watchdog', bucket: 'watchdog' as const }],
    };
    const outcome = { kind: 'ok' as const, state };

    // Watchdog tick would be cooldown-blocked.
    const wd = decideRateLimit(outcome, 'watchdog', now);
    expect(wd.allowed).toBe(false);

    // But plannedUpgrade (driven by the signal file) bypasses.
    const pu = decideRateLimit(outcome, 'plannedUpgrade', now);
    expect(pu.allowed).toBe(true);
  });

  it('expired signal is treated as absent by reader and replaced cleanly by writer', () => {
    // Manually plant an expired signal.
    const expired = {
      requestedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      requestedBy: 'auto-updater',
      reason: 'old',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    const signalPath = lifelineRestartSignalPath(stateDir);
    fs.mkdirSync(path.dirname(signalPath), { recursive: true });
    fs.writeFileSync(signalPath, JSON.stringify(expired));

    // Reader treats expired as absent.
    expect(readLifelineRestartSignal(stateDir)).toBeNull();

    // Writer replaces it.
    const outcome = writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'server-426',
      reason: 'fresh',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });
    expect(outcome).toBe('replaced-stale');
    expect(readLifelineRestartSignal(stateDir)!.reason).toBe('fresh');
  });

  it('full b2lead scenario: minor-jump apply → signal → lifeline acts → no re-fire on respawn', () => {
    // 1. AutoUpdater applies 1.1.0 → 1.2.28 (crosses minor).
    expect(crossesBreaking('1.1.0', '1.2.28')).toBe(true);
    writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'auto-updater',
      reason: 'version-bump',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });

    // 2. Lifeline tick reads the signal.
    let signal = readLifelineRestartSignal(stateDir);
    expect(signal).not.toBeNull();
    expect(signal!.targetVersion).toBe('1.2.28');

    // 3. Lifeline clears the signal as its first step (before initiateRestart).
    clearLifelineRestartSignal(stateDir);

    // 4. Process restarts; fresh lifeline starts at v1.2.28 and ticks.
    //    On first tick, no signal exists → no re-fire.
    signal = readLifelineRestartSignal(stateDir);
    expect(signal).toBeNull();
  });

  it('respawned lifeline same-version no-op clears stale signal if one slipped through', () => {
    // Edge case: a different writer (e.g. PostUpdateMigrator) wrote the
    // signal AFTER the respawned lifeline started, but the targetVersion
    // matches the lifeline's running version. The lifeline must NOT loop.
    writeLifelineRestartSignal({
      stateDir,
      requestedBy: 'post-update-migrator-bootstrap',
      reason: 'stale-lifeline-bootstrap',
      previousVersion: '1.1.0',
      targetVersion: '1.2.28',
    });

    // Simulate the lifeline's per-tick check: if targetVersion === my version,
    // clear and return (no restart). This logic lives in TelegramLifeline.
    const myVersion = '1.2.28';
    const signal = readLifelineRestartSignal(stateDir);
    expect(signal).not.toBeNull();
    if (signal!.targetVersion === myVersion) {
      clearLifelineRestartSignal(stateDir);
    }
    expect(readLifelineRestartSignal(stateDir)).toBeNull();
  });
});
