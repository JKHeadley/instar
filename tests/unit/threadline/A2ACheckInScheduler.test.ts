/**
 * Unit tests for the Layer 4 cadence scheduler. Uses an injected clock + a mock checkIn whose
 * "surfaced" verdict mirrors the policy (silence >= interval). Asserts on the call args (reliable)
 * to verify: first-sight starts the clock (no fire), fires after the interval, resets after a
 * surface, no-op when disabled, and recordSurface seeds the clock.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  A2ACheckInScheduler,
  type A2ACheckInSchedulerDeps,
  type ActiveThreadRef,
} from '../../../src/threadline/A2ACheckInScheduler.js';

const INTERVAL = 420_000; // 7 min

function makeDeps(over: Partial<A2ACheckInSchedulerDeps> = {}) {
  const clock = { t: 0 };
  const threads: ActiveThreadRef[] = [{ threadId: 't1', peerName: 'Dawn', topicId: 12476 }];
  const checkIn = vi.fn(async (req: any) => {
    const surfaced = req.now - req.lastSurfaceAt >= req.heartbeatIntervalMs;
    return { surfaced, kind: surfaced ? 'heartbeat' : 'none', reason: 'test' };
  });
  const deps: A2ACheckInSchedulerDeps = {
    listActiveThreads: () => threads,
    checkIn,
    now: () => clock.t,
    config: { enabled: true, heartbeatEnabled: true, heartbeatIntervalMs: INTERVAL },
    ...over,
  };
  return { deps, clock, checkIn };
}

describe('A2ACheckInScheduler', () => {
  it('first sight starts the silence clock and does NOT fire', async () => {
    const { deps, clock, checkIn } = makeDeps();
    clock.t = 1_000_000;
    const s = new A2ACheckInScheduler(deps);
    await s.tick();
    expect(checkIn).not.toHaveBeenCalled();
  });

  it('fires a heartbeat after the interval of silence, then resets the clock', async () => {
    const { deps, clock, checkIn } = makeDeps();
    const s = new A2ACheckInScheduler(deps);

    clock.t = 0;
    await s.tick(); // first sight: clock starts at 0, no call
    expect(checkIn).not.toHaveBeenCalled();

    clock.t = INTERVAL + 1; // > interval of silence
    await s.tick();
    expect(checkIn).toHaveBeenCalledOnce();
    expect(checkIn.mock.calls[0][0]).toMatchObject({ lastSurfaceAt: 0, now: INTERVAL + 1, hasSalientEvent: false });

    // The mock surfaced=true → scheduler reset lastSurfaceAt to INTERVAL+1.
    clock.t = INTERVAL + 2;
    await s.tick();
    expect(checkIn).toHaveBeenCalledTimes(2);
    // Next call sees the reset baseline (only ~1ms of silence) → would not surface.
    expect(checkIn.mock.calls[1][0]).toMatchObject({ lastSurfaceAt: INTERVAL + 1 });
  });

  it('is a no-op when disabled', async () => {
    const { deps, clock, checkIn } = makeDeps({
      config: { enabled: false, heartbeatEnabled: true, heartbeatIntervalMs: INTERVAL },
    });
    const s = new A2ACheckInScheduler(deps);
    s.start(1000); // does not schedule
    clock.t = INTERVAL * 10;
    await s.tick();
    expect(checkIn).not.toHaveBeenCalled();
    s.stop();
  });

  it('recordSurface seeds the silence clock so a recent surface suppresses the heartbeat', async () => {
    const { deps, clock, checkIn } = makeDeps();
    const s = new A2ACheckInScheduler(deps);
    s.recordSurface('t1', 100_000);
    clock.t = 100_000 + INTERVAL - 1; // just under interval since the surface
    await s.tick();
    expect(checkIn).toHaveBeenCalledOnce();
    expect(checkIn.mock.calls[0][0]).toMatchObject({ lastSurfaceAt: 100_000 });
  });
});
