/**
 * Wiring-integrity test for the WS1.2 drain verb (MULTI-MACHINE-SEAMLESSNESS).
 * The drain sits in the transfer path (it closes a live session and lands the
 * target's claim), so its boot wiring is pinned structurally:
 *   - the mesh handler is registered and answers 'drain disabled' until the
 *     runner exists (a doomed order is never silently dropped);
 *   - the heartbeat advertises capability from RUNNER PRESENCE, never a
 *     hardcoded true (the WS1.1 honest-advertisement pattern);
 *   - the runner's CAS dep journals placement (history never grows a hole);
 *   - the sender leg drains the LOCAL owner via the same runner (no HTTP to
 *     ourselves) and bounds the remote call (the route can never hang);
 *   - the transfer route degrades to today's pin path on any non-abort
 *     failure and refuses with 409 ONLY on the emergency-stop abort.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'src/commands/server.ts');
const ROUTES = path.join(process.cwd(), 'src/server/routes.ts');

describe('WS1.2 drain wiring (server boot + transfer route)', () => {
  const server = fs.readFileSync(SERVER, 'utf-8');
  const routes = fs.readFileSync(ROUTES, 'utf-8');

  it('the mesh drain handler is registered beside deliverMessage with the disabled fallback', () => {
    const idx = server.indexOf('deliverMessage: deliverMessageHandler');
    expect(idx).toBeGreaterThan(-1);
    const block = server.slice(idx, idx + 1800);
    expect(block).toContain('drain: async (cmd)');
    expect(block).toContain("'drain disabled'");
    expect(block).toContain('senderObservedEpoch: c.ownershipEpoch');
  });

  it('the heartbeat advertises ws12DrainReceive from RUNNER PRESENCE (honest capability)', () => {
    expect(server).toContain('ws12DrainReceive: !!_drainRunner');
    // Never a hardcoded advertisement.
    expect(server).not.toContain('ws12DrainReceive: true');
  });

  it('the runner is constructed with journaling CAS, the WS1.4 suspend arm, and the activity-based quiet signal', () => {
    const idx = server.indexOf('new drainMod.SessionDrainRunner');
    expect(idx).toBeGreaterThan(-1);
    const block = server.slice(idx - 400, idx + 3200);
    // CAS dep journals placement like every other CAS site.
    expect(block).toContain("emitPlacement(c.sessionKey, r, 'user-move', prev)");
    // WS1.4 remote arm.
    expect(block).toContain('suspendAutonomousTopicForMove');
    // Turn-boundary signal reads REAL session activity, defaulting quiet when
    // there is nothing local to drain.
    expect(block).toContain('isSessionActivelyWorking');
    // Emergency stop is freshness-bounded — a stale flag file cannot
    // permanently veto every future transfer.
    expect(block).toContain('autonomous-emergency-stop');
    expect(block).toContain('120_000');
  });

  it('the sender leg drains a LOCAL owner via the runner directly and BOUNDS the remote call', () => {
    const idx = server.indexOf('_sendDrain = async');
    expect(idx).toBeGreaterThan(-1);
    const block = server.slice(idx, idx + 2200);
    expect(block).toContain('ownerMachineId === meshSelfId');
    expect(block).toContain('_drainRunner.run');
    expect(block).toContain("type: 'drain'");
    // Bounded: a transfer route call can never hang on a dead peer.
    expect(block).toContain('timeoutMs: 50_000');
    // 501 no-handler (old peer) is reported, not thrown.
    expect(block).toContain('noHandler: res.status === 501');
  });

  it('the transfer route gates the drain on owner capability and 409s ONLY the emergency-stop abort', () => {
    const idx = routes.indexOf('WS1.2 drain leg');
    expect(idx).toBeGreaterThan(-1);
    const block = routes.slice(idx, idx + 3500);
    expect(block).toContain('ws12DrainReceive === true');
    expect(block).toContain("r.status === 'aborted-emergency-stop'");
    expect(block).toContain('failedNeedsRetry: true');
    // Self-owner case bypasses the remote capability flag (the runner's own
    // availability is checked inside sendDrain).
    expect(block).toContain('currentOwner === self ||');
    // The drain runs BEFORE the pin is set.
    const pinIdx = routes.indexOf('ctx.topicPinStore.set(topicId, target', idx);
    expect(pinIdx).toBeGreaterThan(idx);
  });
});
