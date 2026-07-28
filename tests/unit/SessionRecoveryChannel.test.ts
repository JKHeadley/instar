/**
 * Unit tests for SessionRecoveryChannel — the cross-process request/ack channel
 * for codex session-wedge self-recovery.
 *
 * The channel is the boundary between the SERVER-process detector
 * (StuckInputSentinel) and the LIFELINE-process restart authority. These tests
 * pin the contract both sides rely on: request/ack round-trips, attemptId
 * matching, idempotency, multi-session isolation, and tolerance of a
 * missing/corrupt signal file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRecoveryChannel, type RecoveryRequest, type RecoveryAck } from '../../src/core/SessionRecoveryChannel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SESS = 'echo-codey-mentor';

function req(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    sessionId: 'echo-codey-mentor',
    tier: 'redeliver',
    reason: 'input present ≥2 ticks, no turn progress',
    observedAt: '2026-06-03T05:00:00.000Z',
    attemptId: 'echo-codey-mentor#1',
    requestedBy: 'StuckInputSentinel',
    ...overrides,
  };
}

function ack(overrides: Partial<RecoveryAck> = {}): RecoveryAck {
  return {
    sessionId: 'echo-codey-mentor',
    attemptId: 'echo-codey-mentor#1',
    tier: 'redeliver',
    outcome: 'recovered',
    detail: 'Replay complete: 1 delivered',
    updatedAt: '2026-06-03T05:00:05.000Z',
    ...overrides,
  };
}

describe('SessionRecoveryChannel', () => {
  let stateDir: string;
  let channel: SessionRecoveryChannel;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-chan-'));
    channel = new SessionRecoveryChannel(stateDir);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/SessionRecoveryChannel.test.ts' });
  });

  it('round-trips a request from the server side to the lifeline side', () => {
    expect(channel.requestRecovery(req())).toBe(true);
    const pending = channel.readPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('echo-codey-mentor');
    expect(pending[0].tier).toBe('redeliver');
    expect(pending[0].attemptId).toBe('echo-codey-mentor#1');
  });

  it('is idempotent for an identical in-flight request (same attemptId + tier)', () => {
    expect(channel.requestRecovery(req())).toBe(true);
    expect(channel.requestRecovery(req())).toBe(false); // no change
    expect(channel.readPendingRequests()).toHaveLength(1);
  });

  it('replaces the request when the attemptId escalates', () => {
    channel.requestRecovery(req({ attemptId: 'echo-codey-mentor#1', tier: 'redeliver' }));
    expect(channel.requestRecovery(req({ attemptId: 'echo-codey-mentor#2', tier: 'server-restart-replay' }))).toBe(true);
    const pending = channel.readPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].attemptId).toBe('echo-codey-mentor#2');
    expect(pending[0].tier).toBe('server-restart-replay');
  });

  it('round-trips an ack from the lifeline side to the server side, matching attemptId', () => {
    channel.requestRecovery(req());
    channel.ackRecovery(ack({ outcome: 'in-progress' }));
    const a1 = channel.readAck('echo-codey-mentor');
    expect(a1?.outcome).toBe('in-progress');
    expect(a1?.attemptId).toBe('echo-codey-mentor#1'); // matches the request

    channel.ackRecovery(ack({ outcome: 'recovered' }));
    expect(channel.readAck('echo-codey-mentor')?.outcome).toBe('recovered'); // latest wins
  });

  it('keeps requests and acks for multiple sessions isolated', () => {
    channel.requestRecovery(req({ sessionId: 'sess-a', attemptId: 'sess-a#1' }));
    channel.requestRecovery(req({ sessionId: 'sess-b', attemptId: 'sess-b#1', tier: 'server-restart-replay' }));
    channel.ackRecovery(ack({ sessionId: 'sess-a', attemptId: 'sess-a#1', outcome: 'recovered' }));

    expect(channel.readPendingRequests()).toHaveLength(2);
    expect(channel.readAck('sess-a')?.outcome).toBe('recovered');
    expect(channel.readAck('sess-b')).toBeNull(); // no ack for b yet
  });

  it('clears a request without touching other sessions', () => {
    channel.requestRecovery(req({ sessionId: 'sess-a', attemptId: 'sess-a#1' }));
    channel.requestRecovery(req({ sessionId: 'sess-b', attemptId: 'sess-b#1' }));
    expect(channel.clearRequest('sess-a')).toBe(true);
    const pending = channel.readPendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('sess-b');
    expect(channel.clearRequest('sess-a')).toBe(false); // already gone
  });

  it('clears an ack once consumed', () => {
    channel.ackRecovery(ack());
    expect(channel.clearAck('echo-codey-mentor')).toBe(true);
    expect(channel.readAck('echo-codey-mentor')).toBeNull();
    expect(channel.clearAck('echo-codey-mentor')).toBe(false);
  });

  it('returns empty / null when the signal files do not exist yet', () => {
    expect(channel.readPendingRequests()).toEqual([]);
    expect(channel.readAck('anything')).toBeNull();
    expect(channel.clearRequest('anything')).toBe(false);
  });

  it('tolerates a corrupt request file (treats it as empty, then overwrites cleanly)', () => {
    const reqPath = path.join(stateDir, 'state', 'session-recovery-requested.json');
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    fs.writeFileSync(reqPath, '{ this is not valid json ');
    expect(channel.readPendingRequests()).toEqual([]); // no throw
    expect(channel.requestRecovery(req())).toBe(true);  // overwrites cleanly
    expect(channel.readPendingRequests()).toHaveLength(1);
  });

  it('single-writer invariant: requesting recovery never creates the ack file, acking never creates the request file', () => {
    const reqPath = path.join(stateDir, 'state', 'session-recovery-requested.json');
    const ackPath = path.join(stateDir, 'state', 'session-recovery-acked.json');

    channel.requestRecovery(req());
    expect(fs.existsSync(reqPath)).toBe(true);
    expect(fs.existsSync(ackPath)).toBe(false); // request side must not write the ack file

    // Fresh channel/dir for the inverse direction.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-chan2-'));
    try {
      const ch2 = new SessionRecoveryChannel(dir2);
      ch2.ackRecovery(ack());
      expect(fs.existsSync(path.join(dir2, 'state', 'session-recovery-acked.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir2, 'state', 'session-recovery-requested.json'))).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'tests/unit/SessionRecoveryChannel.test.ts:inverse' });
    }
  });

  // ---- durable restart cooldown (the restart-loop guard) ----

  it('records a restart and reports it as the last-restart timestamp', () => {
    expect(channel.lastRestartAt(SESS)).toBeNull();
    channel.recordRestart(SESS, 1_000_000);
    expect(channel.lastRestartAt(SESS)).toBe(1_000_000);
  });

  it('isInCooldown is true within the window and false after it', () => {
    channel.recordRestart(SESS, 1_000_000);
    expect(channel.isInCooldown(SESS, 1_000_000 + 5_000, 60_000)).toBe(true);   // 5s after, 60s window
    expect(channel.isInCooldown(SESS, 1_000_000 + 120_000, 60_000)).toBe(false); // 120s after, 60s window
  });

  it('isInCooldown is false for a session that never restarted', () => {
    expect(channel.isInCooldown('never-restarted', 9_999_999, 60_000)).toBe(false);
  });

  it('the latest restart overwrites the prior timestamp', () => {
    channel.recordRestart(SESS, 1_000_000);
    channel.recordRestart(SESS, 2_000_000);
    expect(channel.lastRestartAt(SESS)).toBe(2_000_000);
    expect(channel.isInCooldown(SESS, 2_000_000 + 1_000, 60_000)).toBe(true);
  });

  it('cooldown is isolated per session', () => {
    channel.recordRestart('sess-a', 1_000_000);
    expect(channel.isInCooldown('sess-a', 1_000_500, 60_000)).toBe(true);
    expect(channel.isInCooldown('sess-b', 1_000_500, 60_000)).toBe(false);
  });
});
