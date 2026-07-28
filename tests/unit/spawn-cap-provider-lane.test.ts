/**
 * F5 — SpawnCapIntelligenceProvider lane resolution + lane-aware ingress
 * (docs/specs/spawn-cap-interactive-priority.md §A/§B).
 *
 * Locks: the structural allowlist (a non-allowlisted `lane:'interactive'` — e.g. the
 * CoherenceReviewer fan-out — is DOWNGRADED to background); byte-identical ingress when
 * the feature is OFF; the interactive fast-path reaching the reserve; and the lane
 * actually flowing into `semaphore.acquire`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SpawnCapIntelligenceProvider,
  INTERACTIVE_LANE_ALLOWLIST,
  isCapacityUnavailable,
  _resetSpawnPollersForTest,
} from '../../src/core/SpawnCapIntelligenceProvider.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

/** A fake semaphore recording the lane passed to acquire(). */
function fakeSemaphore(opts: { enabled: boolean; admit?: (lane: string) => boolean }) {
  const calls: Array<{ id: string; lane: string }> = [];
  return {
    calls,
    acquire(id: string, lane: string = 'background') {
      calls.push({ id, lane });
      return opts.admit ? opts.admit(lane) : true;
    },
    release() {},
    interactivePriorityEnabled() {
      return opts.enabled;
    },
  };
}

const inner: IntelligenceProvider = { evaluate: async () => 'OK' };
const attr = (component: string, lane?: 'interactive' | 'background'): IntelligenceOptions => ({
  attribution: { component, gating: true, ...(lane ? { lane } : {}) },
});

beforeEach(() => _resetSpawnPollersForTest());

describe('SpawnCapIntelligenceProvider — F5 lane resolution', () => {
  it('allowlist: MessagingToneGate + lane:interactive → acquires on the interactive lane', async () => {
    const sem = fakeSemaphore({ enabled: true });
    const p = new SpawnCapIntelligenceProvider(inner, { semaphore: sem as never });
    await p.evaluate('x', attr('MessagingToneGate', 'interactive'));
    expect(sem.calls[0].lane).toBe('interactive');
  });

  it('allowlist DOWNGRADE: CoherenceReviewer tagged interactive → background (the fan-out cannot grab the reserve)', async () => {
    const sem = fakeSemaphore({ enabled: true });
    const p = new SpawnCapIntelligenceProvider(inner, { semaphore: sem as never });
    await p.evaluate('x', attr('CoherenceReviewer', 'interactive'));
    expect(sem.calls[0].lane).toBe('background');
  });

  it('feature OFF: even an allowlisted interactive tag resolves to background (byte-identical)', async () => {
    const sem = fakeSemaphore({ enabled: false });
    const p = new SpawnCapIntelligenceProvider(inner, { semaphore: sem as never });
    await p.evaluate('x', attr('MessagingToneGate', 'interactive'));
    expect(sem.calls[0].lane).toBe('background');
  });

  it('no lane tag → background', async () => {
    const sem = fakeSemaphore({ enabled: true });
    const p = new SpawnCapIntelligenceProvider(inner, { semaphore: sem as never });
    await p.evaluate('x', attr('MessagingToneGate'));
    expect(sem.calls[0].lane).toBe('background');
  });

  it('the allowlist is exactly {MessagingToneGate, MessageSentinel} (membership cannot silently grow)', () => {
    expect([...INTERACTIVE_LANE_ALLOWLIST].sort()).toEqual(['MessageSentinel', 'MessagingToneGate']);
  });

  it('interactive fast-path: an immediately-available reserve admits WITHOUT entering the waiters loop', async () => {
    // admit interactive immediately → fast-path returns; never increments pollers.
    const sem = fakeSemaphore({ enabled: true, admit: (lane) => lane === 'interactive' });
    const p = new SpawnCapIntelligenceProvider(inner, { semaphore: sem as never, waitersMax: 2, interactiveWaiters: 1 });
    const out = await p.evaluate('x', attr('MessagingToneGate', 'interactive'));
    expect(out).toBe('OK');
    expect(sem.calls[0].lane).toBe('interactive');
  });

  it('a saturated interactive call still fails CLOSED (typed shed) — reserve does not mean never-sheds', async () => {
    const sem = fakeSemaphore({ enabled: true, admit: () => false }); // never admits
    const p = new SpawnCapIntelligenceProvider(inner, {
      semaphore: sem as never,
      waitersMax: 4,
      acquireMs: 5,
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
    });
    const err = await p.evaluate('x', attr('MessagingToneGate', 'interactive')).catch((e) => e);
    expect(isCapacityUnavailable(err)).toBe(true);
  });
});
