/**
 * Escalation tests for StuckInputSentinel — the codex session-wedge SELF-recovery
 * deeper-tier escalation (Increment 2).
 *
 * Once the keypress ladder (tier A) exhausts but a codex injection marker is
 * still stuck at the prompt, the sentinel — when escalation is enabled — requests
 * a tier-C recovery (server restart + replay) from the lifeline via
 * SessionRecoveryChannel, polls the ack, verifies, and bounds the wait. With
 * escalation OFF (the default), behavior is byte-for-byte the legacy "exhaust and
 * stop". These tests pin both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StuckInputSentinel } from '../../src/core/StuckInputSentinel.js';
import { SessionRecoveryChannel } from '../../src/core/SessionRecoveryChannel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SESS = 'echo-codey-mentor';
const MARKER = 'INJ_MARKER_7f3a';
// A codex pane where the injected marker is stuck on a `›` prompt line, with no
// activity indicator → the marker-based detector treats it as stuck.
const CODEX_STUCK_PANE = ['── codey ──', `› ${MARKER}`, 'Session paused.'].join('\n');

function buildStubManager() {
  const liveMarkers = new Map<string, { marker: string; framework: string; injectedAt: number }>([
    [SESS, { marker: MARKER, framework: 'codex-cli', injectedAt: 0 }],
  ]);
  return {
    listRunningSessions: vi.fn(() => [{ tmuxSession: SESS }]),
    tmuxSessionExists: vi.fn((n: string) => n === SESS),
    captureOutput: vi.fn(() => CODEX_STUCK_PANE),
    fireStuckInputRecovery: vi.fn(),
    getStrandedDraftMarker: vi.fn((n: string) => liveMarkers.get(n)),
    clearStrandedDraftMarker: vi.fn((n: string) => { liveMarkers.delete(n); }),
    strandedDraftMarkerSessions: vi.fn(() => [...liveMarkers.keys()]),
    isMarkerStuckAtPrompt: vi.fn((pane: string, marker: string) =>
      pane.split('\n').some(l => (l.includes('❯') || l.includes('›')) && l.includes(marker)),
    ),
  };
}

describe('StuckInputSentinel — deeper-tier escalation (codex wedge self-recovery)', () => {
  let stateDir: string;
  let channel: SessionRecoveryChannel;
  let manager: ReturnType<typeof buildStubManager>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-stuck-esc-'));
    channel = new SessionRecoveryChannel(stateDir);
    manager = buildStubManager();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/StuckInputSentinel-escalation.test.ts' });
  });

  function sentinel(escalationEnabled: boolean, escalationTimeoutTicks = 6) {
    return new StuckInputSentinel(manager as any, {
      stateDir, noPersist: true, minTicksBeforeFire: 2, maxAttempts: 4,
      recoveryChannel: channel, escalationEnabled, escalationTimeoutTicks,
    });
  }

  /** Tick n times. tick 1 seeds the record; ticks 2..5 fire keypress attempts
   *  0..3; tick 6 is the first post-exhaustion escalation tick. */
  function tickN(s: StuckInputSentinel, n: number) { for (let i = 0; i < n; i++) s.tick(); }

  it('DARK by default: after the keypress ladder exhausts, no channel request and no further keypresses', () => {
    const s = sentinel(false);
    tickN(s, 10); // well past exhaustion
    expect(manager.fireStuckInputRecovery).toHaveBeenCalledTimes(4); // exactly maxAttempts
    expect(channel.readPendingRequests()).toEqual([]); // never escalated
  });

  it('with no channel provided, escalation is a no-op (legacy exhausted, no throw)', () => {
    const s = new StuckInputSentinel(manager as any, {
      stateDir, noPersist: true, minTicksBeforeFire: 2, maxAttempts: 4, escalationEnabled: true,
    });
    expect(() => tickN(s, 10)).not.toThrow();
    expect(manager.fireStuckInputRecovery).toHaveBeenCalledTimes(4);
  });

  it('ENABLED: requests a tier-C recovery once the keypress ladder exhausts', () => {
    const s = sentinel(true);
    tickN(s, 6); // 4 keypresses then one escalation tick
    expect(manager.fireStuckInputRecovery).toHaveBeenCalledTimes(4);
    const pending = channel.readPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe(SESS);
    expect(pending[0].tier).toBe('server-restart-replay');
    expect(pending[0].requestedBy).toBe('StuckInputSentinel');
  });

  it('does not emit a second request while one is in flight (idempotent across ticks)', () => {
    const s = sentinel(true);
    tickN(s, 6);
    const a1 = channel.readPendingRequests()[0].attemptId;
    tickN(s, 3); // more ticks while still 'requested', no ack present
    const pend = channel.readPendingRequests();
    expect(pend).toHaveLength(1);
    expect(pend[0].attemptId).toBe(a1); // same attempt, not re-requested
  });

  it('clears the request and stops escalating when the lifeline acks "recovered"', () => {
    const s = sentinel(true);
    tickN(s, 6);
    const reqAttempt = channel.readPendingRequests()[0].attemptId;
    // Simulate the lifeline executing + acking recovery for THIS attempt.
    channel.ackRecovery({ sessionId: SESS, attemptId: reqAttempt, tier: 'server-restart-replay', outcome: 'recovered', updatedAt: '2026-06-03T05:00:00Z' });
    s.tick(); // sentinel reads the ack
    expect(channel.readPendingRequests()).toEqual([]); // request cleared
  });

  it('gives up (bounded) and clears the request when the lifeline acks "failed"', () => {
    const s = sentinel(true);
    tickN(s, 6);
    const reqAttempt = channel.readPendingRequests()[0].attemptId;
    channel.ackRecovery({ sessionId: SESS, attemptId: reqAttempt, tier: 'server-restart-replay', outcome: 'failed', detail: 'restart refused', updatedAt: '2026-06-03T05:00:00Z' });
    s.tick();
    expect(channel.readPendingRequests()).toEqual([]);
  });

  it('gives up (bounded) after escalationTimeoutTicks with no ack — no restart loop', () => {
    const s = sentinel(true, 3);
    tickN(s, 6); // request emitted at tick 6
    expect(channel.readPendingRequests()).toHaveLength(1);
    tickN(s, 4); // > escalationTimeoutTicks (3) with no ack → give up
    expect(channel.readPendingRequests()).toEqual([]); // cleared, abandoned
  });
});
