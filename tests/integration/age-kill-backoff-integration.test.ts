/**
 * Integration test for the age-gate kill back-off as wired into the REAL SessionManager.
 *
 * Regression for the 2026-06-05 incident: an over-age, idle-at-prompt session whose kill the
 * KEEP-guard vetoes was re-requested for a kill every 5-second monitor tick → 17,503 identical
 * "Requesting kill" lines + wasted CPU. The back-off bounds that to ~1 request per window.
 *
 * We assert against the SessionManager's OWN ledger instance (not a stand-in), driving the
 * exact call sequence the age-gate performs (SessionManager.ts: shouldRequest → terminateSession
 * → recordVeto/recordKilled). This proves the real manager holds a real, working back-off and
 * that the age-gate's contract with it produces the right bounding — without the brittle full
 * tmux/liveness preconditions of a full monitorTick drive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { AgeKillBackoff } from '../../src/core/AgeKillBackoff.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MIN = 60_000;

function makeManager(ageKillBackoffMinutes: number, dir: string): { manager: SessionManager; ledger: AgeKillBackoff } {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const config: SessionManagerConfig = {
    tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude', projectDir: dir,
    maxSessions: 5, protectedSessions: ['p-server'], completionPatterns: ['bye'],
    framework: 'claude-code', defaultMaxDurationMinutes: 240, ageKillBackoffMinutes,
  };
  const manager = new SessionManager(config, new StateManager(stateDir));
  const ledger = (manager as unknown as { ageKillBackoff: AgeKillBackoff }).ageKillBackoff;
  return { manager, ledger };
}

describe('SessionManager age-gate kill back-off (integration)', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agekill-')); });
  afterEach(() => {
    manager?.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'age-kill-backoff-integration cleanup' });
  });

  it('wires a REAL AgeKillBackoff into SessionManager from config (not null / not a no-op)', () => {
    const { manager: m, ledger } = makeManager(10, tmpDir); manager = m;
    expect(ledger).toBeInstanceOf(AgeKillBackoff);
    const now = 1_000_000;
    expect(ledger.shouldRequest('s', now)).toBe(true);
    ledger.recordVeto('s', now);
    expect(ledger.shouldRequest('s', now)).toBe(false); // real logic, not a stub
  });

  it('bounds the age-gate to ONE kill-request per window when the guard keeps vetoing (the 17,503-line fix)', () => {
    const { manager: m, ledger } = makeManager(10, tmpDir); manager = m;
    // Replay exactly what the age-gate does each 5s tick on an over-age, KEPT session:
    //   if (ledger.shouldRequest) { terminate() -> {terminated:false} ; ledger.recordVeto() }
    let killRequests = 0;
    for (let t = 0; t < 60 * MIN; t += 5_000) {
      if (ledger.shouldRequest('topic-keepme', t)) {
        killRequests++;            // age-gate would call terminateSession here
        ledger.recordVeto('topic-keepme', t); // guard vetoed → back off
      }
    }
    expect(killRequests).toBe(6);  // one per 10-min window over an hour — was 720 (one per 5s)
  });

  it('a genuinely-abandoned session (no keep-reason) dies on the FIRST ask, then state is cleared', () => {
    const { manager: m, ledger } = makeManager(10, tmpDir); manager = m;
    const now = 2_000_000;
    expect(ledger.shouldRequest('sess-dead', now)).toBe(true); // first ask allowed
    // terminate() -> {terminated:true} -> age-gate calls recordKilled (not recordVeto).
    ledger.recordKilled('sess-dead');
    expect(ledger.trackedCount).toBe(0); // no lingering back-off for a killed session
  });

  it('back-off of 0 minutes preserves legacy every-tick behavior', () => {
    const { manager: m, ledger } = makeManager(0, tmpDir); manager = m;
    let killRequests = 0;
    for (let t = 0; t < MIN; t += 5_000) {
      if (ledger.shouldRequest('s', t)) { killRequests++; ledger.recordVeto('s', t); }
    }
    expect(killRequests).toBe(12); // every tick — disabled back-off
  });
});
