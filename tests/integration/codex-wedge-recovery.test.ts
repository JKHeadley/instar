/**
 * Integration test for codex session-wedge self-recovery — the FULL loop across
 * both components through their real seam (SessionRecoveryChannel):
 *
 *   StuckInputSentinel (server side) detects a stuck codex injection → exhausts
 *   the keypress ladder → REQUESTS tier-C recovery via the channel
 *     → SessionRecoveryConsumer (lifeline side) reads the request → executes
 *       (restart + replay, here mocked) → ACKS recovered
 *         → StuckInputSentinel reads the ack on its next tick → clears the
 *           request and marks the episode recovered.
 *
 * This proves the cross-process contract (request shape, attemptId matching,
 * ack round-trip, request-clear) works end-to-end — the part unit tests stub on
 * each side. Uses a real on-disk channel; the tmux/SessionManager and the actual
 * server restart are the only mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StuckInputSentinel } from '../../src/core/StuckInputSentinel.js';
import { SessionRecoveryChannel } from '../../src/core/SessionRecoveryChannel.js';
import { SessionRecoveryConsumer } from '../../src/core/SessionRecoveryConsumer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SESS = 'echo-codey-mentor';
const MARKER = 'INJ_MARKER_int';
const STUCK = ['── codey ──', `› ${MARKER}`, 'Session paused.'].join('\n');
const DRAINED = ['── codey ──', 'working…', 'esc to interrupt'].join('\n');

describe('codex wedge self-recovery — full sentinel↔channel↔consumer loop', () => {
  let stateDir: string;
  let channel: SessionRecoveryChannel;
  let paneState: string;
  let markerLive: boolean;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codex-wedge-int-'));
    channel = new SessionRecoveryChannel(stateDir);
    paneState = STUCK;
    markerLive = true;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/codex-wedge-recovery.test.ts' });
  });

  function manager() {
    return {
      listRunningSessions: vi.fn(() => [{ tmuxSession: SESS }]),
      tmuxSessionExists: vi.fn(() => true),
      captureOutput: vi.fn(() => paneState),
      fireStuckInputRecovery: vi.fn(),
      getStrandedDraftMarker: vi.fn(() => (markerLive ? { marker: MARKER, framework: 'codex-cli', injectedAt: 0 } : undefined)),
      clearStrandedDraftMarker: vi.fn(() => { markerLive = false; }),
      strandedDraftMarkerSessions: vi.fn(() => (markerLive ? [SESS] : [])),
      isMarkerStuckAtPrompt: vi.fn((pane: string, marker: string) =>
        pane.split('\n').some(l => (l.includes('❯') || l.includes('›')) && l.includes(marker)),
      ),
    };
  }

  it('recovers a wedged codex session end-to-end (real restart path, mocked supervisor)', async () => {
    const mgr = manager();
    const sentinel = new StuckInputSentinel(mgr as any, {
      stateDir, noPersist: true, minTicksBeforeFire: 2, maxAttempts: 4,
      recoveryChannel: channel, escalationEnabled: true, escalationTimeoutTicks: 6,
    });

    // The consumer's "restart" stands in for performGracefulRestart: when it
    // fires, the wedge clears (the replayed message finally drains).
    const restart = vi.fn(async () => { paneState = DRAINED; markerLive = false; return true; });
    const replay = vi.fn();
    const consumer = new SessionRecoveryConsumer({
      channel, restart, replay, dryRun: false, cooldownMs: 600_000, log: () => {},
    });

    // 1. Sentinel runs the keypress ladder then escalates → tier-C request emitted.
    for (let i = 0; i < 6; i++) sentinel.tick();
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(4);
    const reqs = channel.readPendingRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tier).toBe('server-restart-replay');

    // 2. Lifeline consumer executes the restart + replay and acks recovered.
    await consumer.tick();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(channel.readAck(SESS)?.outcome).toBe('recovered');

    // 3. Sentinel reads the ack on its next tick → clears the request.
    //    (The pane has drained, so the marker-based detector sees fresh state.)
    sentinel.tick();
    expect(channel.readPendingRequests()).toEqual([]);
  });

  it('dry-run completes the loop without a real restart', async () => {
    const mgr = manager();
    const sentinel = new StuckInputSentinel(mgr as any, {
      stateDir, noPersist: true, minTicksBeforeFire: 2, maxAttempts: 4,
      recoveryChannel: channel, escalationEnabled: true,
    });
    const restart = vi.fn(async () => true);
    const consumer = new SessionRecoveryConsumer({
      channel, restart, replay: vi.fn(), dryRun: true, cooldownMs: 600_000, log: () => {},
    });

    for (let i = 0; i < 6; i++) sentinel.tick();
    expect(channel.readPendingRequests()).toHaveLength(1);

    await consumer.tick();
    expect(restart).not.toHaveBeenCalled();           // dry-run: no real restart
    expect(channel.readAck(SESS)?.outcome).toBe('recovered');
    expect(channel.lastRestartAt(SESS)).not.toBeNull(); // cooldown still recorded
  });

  it('end-to-end stays inert when escalation is disabled (dark default)', async () => {
    const mgr = manager();
    const sentinel = new StuckInputSentinel(mgr as any, {
      stateDir, noPersist: true, minTicksBeforeFire: 2, maxAttempts: 4,
      recoveryChannel: channel, escalationEnabled: false,
    });
    for (let i = 0; i < 10; i++) sentinel.tick();
    expect(channel.readPendingRequests()).toEqual([]); // nothing ever requested
  });
});
