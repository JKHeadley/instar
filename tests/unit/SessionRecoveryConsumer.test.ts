/**
 * Unit tests for SessionRecoveryConsumer — the lifeline-side tier-C executor.
 *
 * Uses a real SessionRecoveryChannel (temp dir) + mocked restart/replay + an
 * injectable clock. Pins the safety properties: dry-run does not restart, the
 * durable cooldown blocks a re-restart, dedup skips an already-handled attempt,
 * non-tier-C requests are ignored, and a throwing restart is acked failed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRecoveryChannel, type RecoveryRequest } from '../../src/core/SessionRecoveryChannel.js';
import { SessionRecoveryConsumer } from '../../src/core/SessionRecoveryConsumer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SESS = 'echo-codey-mentor';
const COOLDOWN = 60_000;

function tierCReq(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    sessionId: SESS, tier: 'server-restart-replay',
    reason: 'keypress ladder exhausted; prompt still stuck',
    observedAt: '2026-06-03T05:00:00Z', attemptId: `${SESS}#1`, requestedBy: 'StuckInputSentinel',
    ...overrides,
  };
}

describe('SessionRecoveryConsumer', () => {
  let stateDir: string;
  let channel: SessionRecoveryChannel;
  let restart: ReturnType<typeof vi.fn>;
  let replay: ReturnType<typeof vi.fn>;
  let clockMs: number;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-consumer-'));
    channel = new SessionRecoveryChannel(stateDir);
    restart = vi.fn(async () => true);
    replay = vi.fn();
    clockMs = 1_000_000;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/SessionRecoveryConsumer.test.ts' });
  });

  function consumer(dryRun: boolean) {
    return new SessionRecoveryConsumer({
      channel, restart, replay, dryRun, cooldownMs: COOLDOWN,
      now: () => clockMs, log: () => {},
    });
  }

  it('DRY-RUN: acks recovered without restarting, but still records the cooldown', async () => {
    channel.requestRecovery(tierCReq());
    await consumer(true).tick();
    expect(restart).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(channel.readAck(SESS)?.outcome).toBe('recovered');
    expect(channel.lastRestartAt(SESS)).toBe(clockMs); // cooldown recorded even in dry-run
  });

  it('REAL: restarts the server, replays the queue, and acks recovered', async () => {
    channel.requestRecovery(tierCReq());
    await consumer(false).tick();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith(expect.stringContaining(SESS));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(channel.readAck(SESS)?.outcome).toBe('recovered');
  });

  it('acks failed and does NOT replay when the restart returns false', async () => {
    restart.mockResolvedValueOnce(false);
    channel.requestRecovery(tierCReq());
    await consumer(false).tick();
    expect(replay).not.toHaveBeenCalled();
    expect(channel.readAck(SESS)?.outcome).toBe('failed');
  });

  it('COOLDOWN: refuses a second restart within the window (loop guard)', async () => {
    // First restart at t0.
    channel.requestRecovery(tierCReq({ attemptId: `${SESS}#1` }));
    await consumer(false).tick();
    expect(restart).toHaveBeenCalledTimes(1);

    // A NEW request 5s later (simulating the post-restart sentinel re-escalating).
    clockMs += 5_000;
    channel.requestRecovery(tierCReq({ attemptId: `${SESS}#2` }));
    await consumer(false).tick();
    expect(restart).toHaveBeenCalledTimes(1); // still 1 — cooldown blocked it
    expect(channel.readAck(SESS)?.outcome).toBe('failed');
    expect(channel.readAck(SESS)?.detail).toContain('cooldown');
  });

  it('allows another restart once the cooldown window has elapsed', async () => {
    channel.requestRecovery(tierCReq({ attemptId: `${SESS}#1` }));
    await consumer(false).tick();
    clockMs += COOLDOWN + 1_000; // past the window
    channel.requestRecovery(tierCReq({ attemptId: `${SESS}#2` }));
    await consumer(false).tick();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('DEDUP: does not re-execute a request whose attempt already reached a terminal ack', async () => {
    channel.requestRecovery(tierCReq());
    await consumer(false).tick(); // executes once, acks recovered, leaves request in place
    // The request lingers (server owns clearing it); a second tick must not re-restart.
    await consumer(false).tick();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('ignores non-tier-C requests (tier C is the lifeline\'s only responsibility)', async () => {
    channel.requestRecovery(tierCReq({ tier: 'redeliver' }));
    await consumer(false).tick();
    expect(restart).not.toHaveBeenCalled();
    expect(channel.readAck(SESS)).toBeNull();
  });

  it('acks failed (and does not throw out of tick) when the restart throws', async () => {
    restart.mockRejectedValueOnce(new Error('supervisor exploded'));
    channel.requestRecovery(tierCReq());
    await expect(consumer(false).tick()).resolves.toBeUndefined();
    expect(channel.readAck(SESS)?.outcome).toBe('failed');
    expect(channel.readAck(SESS)?.detail).toContain('supervisor exploded');
  });
});
