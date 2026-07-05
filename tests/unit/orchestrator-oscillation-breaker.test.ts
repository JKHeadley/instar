/**
 * OscillationBreaker — Tier-1 unit tests (spec: llm-seamlessness-orchestrator.md §F6 +
 * the Tier-1 "oscillation breaker blacklists + raises one item" requirement).
 */
import { describe, it, expect } from 'vitest';
import { OscillationBreaker } from '../../src/core/OscillationBreaker.js';

describe('OscillationBreaker (F6)', () => {
  it('blacklists a topic after N actuations in the window + fires the trip ONCE', () => {
    const b = new OscillationBreaker({ maxActuationsPerWindow: 3, oscillationWindowMs: 60_000, blacklistTtlMs: 600_000 });
    expect(b.recordActuation(1, 1000)).toBe(false); // 1
    expect(b.recordActuation(1, 2000)).toBe(false); // 2
    expect(b.recordActuation(1, 3000)).toBe(true);  // 3 → trip (one-shot)
    expect(b.isBlacklisted(1, 3500)).toBe(true);
    // subsequent actuations while blacklisted do NOT re-fire the trip (one attention item per episode)
    expect(b.recordActuation(1, 4000)).toBe(false);
  });

  it('does not blacklist when actuations are spread beyond the window', () => {
    const b = new OscillationBreaker({ maxActuationsPerWindow: 3, oscillationWindowMs: 10_000, blacklistTtlMs: 600_000 });
    expect(b.recordActuation(1, 1000)).toBe(false);
    expect(b.recordActuation(1, 20_000)).toBe(false); // > window from #1 → #1 pruned
    expect(b.recordActuation(1, 40_000)).toBe(false); // still only 1 in-window
    expect(b.isBlacklisted(1, 40_000)).toBe(false);
  });

  it('a blacklist self-clears after its TTL', () => {
    const b = new OscillationBreaker({ maxActuationsPerWindow: 2, oscillationWindowMs: 60_000, blacklistTtlMs: 100_000 });
    b.recordActuation(1, 1000);
    expect(b.recordActuation(1, 2000)).toBe(true);
    expect(b.isBlacklisted(1, 50_000)).toBe(true);
    expect(b.isBlacklisted(1, 200_000)).toBe(false); // past TTL → cleared
  });

  it('tracks blacklisted topics independently', () => {
    const b = new OscillationBreaker({ maxActuationsPerWindow: 2, oscillationWindowMs: 60_000, blacklistTtlMs: 600_000 });
    b.recordActuation(1, 1000); b.recordActuation(1, 2000); // topic 1 blacklisted
    b.recordActuation(2, 1000);                              // topic 2: only 1
    expect(b.blacklistedTopics(3000)).toEqual([1]);
  });
});
