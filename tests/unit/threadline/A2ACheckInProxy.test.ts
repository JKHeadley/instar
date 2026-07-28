/**
 * Unit tests for the Layer 4 orchestration (runCheckIn): decide → summarize → guard → surface.
 * Uses injected mock deps — verifies LLM spend is skipped on 'none', the summary is surfaced on
 * salience/heartbeat, and an unsafe summary is dropped (never surfaced).
 */
import { describe, it, expect, vi } from 'vitest';
import { runCheckIn, type CheckInDeps, type CheckInRequest } from '../../../src/threadline/A2ACheckInProxy.js';

function makeDeps(overrides: Partial<CheckInDeps> = {}): CheckInDeps & {
  summarize: ReturnType<typeof vi.fn>;
  surface: ReturnType<typeof vi.fn>;
} {
  return {
    summarize: vi.fn(async () => 'Dawn says parity is green; nothing needs you yet.'),
    surface: vi.fn(async () => {}),
    getHistory: () => 'Dawn: status?\nMe: parity green.',
    ...overrides,
  } as any;
}

const req: CheckInRequest = {
  threadId: 't1',
  peerName: 'Dawn',
  topicId: 12476,
  conversationActive: true,
  hasSalientEvent: true, // salience
  lastSurfaceAt: 0,
  now: 1_000,
  heartbeatIntervalMs: 420_000,
  heartbeatEnabled: true,
};

describe('runCheckIn — Layer 4 orchestration', () => {
  it('summarizes and surfaces on a salient event', async () => {
    const deps = makeDeps();
    const out = await runCheckIn(req, deps);
    expect(out.surfaced).toBe(true);
    expect(out.kind).toBe('salience');
    expect(deps.summarize).toHaveBeenCalledOnce();
    expect(deps.surface).toHaveBeenCalledOnce();
    expect(deps.surface.mock.calls[0][0]).toMatchObject({ threadId: 't1', topicId: 12476, kind: 'salience' });
  });

  it("skips entirely on 'none' — no LLM spend, no surface", async () => {
    const deps = makeDeps();
    // no salient event + recently surfaced → none
    const out = await runCheckIn({ ...req, hasSalientEvent: false, lastSurfaceAt: 900, now: 1_000 }, deps);
    expect(out.surfaced).toBe(false);
    expect(out.kind).toBe('none');
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(deps.surface).not.toHaveBeenCalled();
  });

  it('fires the silence-breaker heartbeat after the interval (no salient event)', async () => {
    const deps = makeDeps();
    const out = await runCheckIn(
      { ...req, hasSalientEvent: false, lastSurfaceAt: 0, now: 500_000 }, // > 7 min silence
      deps,
    );
    expect(out.surfaced).toBe(true);
    expect(out.kind).toBe('heartbeat');
    expect(deps.surface).toHaveBeenCalledOnce();
  });

  it('drops the check-in when the summary fails the guard (never surfaces unsafe output)', async () => {
    const deps = makeDeps({ summarize: vi.fn(async () => 'Click https://evil.example to approve') });
    const out = await runCheckIn(req, deps);
    expect(out.surfaced).toBe(false);
    expect(out.reason).toMatch(/guard-blocked/);
    expect(deps.surface).not.toHaveBeenCalled();
  });
});
