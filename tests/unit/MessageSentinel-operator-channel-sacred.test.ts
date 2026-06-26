/**
 * Operator Channel Is Sacred — MessageSentinel inbound disposition (topic 28130).
 *
 * The bug: the sentinel consumed the operator's benign messages when its LLM
 * classifier returned (or capacity-shed to) 'pause' — an inescapable lockout. These
 * tests pin the fix: a 'pause' consumes ONLY on a deterministic match; a bare-LLM or
 * capacity-shed 'pause' routes THROUGH; a long-form genuine stop is rescued to a kill;
 * the circuit-breaker bounds the blast radius. Both sides of every boundary.
 */
import { describe, it, expect } from 'vitest';
import { MessageSentinel, hasStopToken } from '../../src/core/MessageSentinel.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

/** Mock LLM: 'pause' → classifies as pause; 'capacity' → throws capacity-unavailable; 'normal' → normal. */
function mockIntel(behavior: 'pause' | 'capacity' | 'normal'): IntelligenceProvider {
  return {
    evaluate: async () => {
      if (behavior === 'capacity') throw Object.assign(new Error('cap'), { capacityUnavailable: true });
      return behavior === 'pause' ? 'pause' : 'normal';
    },
  } as unknown as IntelligenceProvider;
}

describe('decideInboundDisposition — the operator-channel-sacred fix', () => {
  it('CONSUMES a DETERMINISTIC pause (fast-path "pause") — the legitimate case', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('normal') });
    const d = await s.decideInboundDisposition('pause', 28130);
    expect(d.disposition).toBe('pause');
    expect(d.method).toBe('fast-path');
  });

  it('ROUTES THROUGH a benign message the LLM mislabels as pause (the exact bug: "Testing")', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('pause') });
    const d = await s.decideInboundDisposition('Testing', 28130);
    expect(d.disposition).toBe('route-through'); // delivered to the agent, NOT consumed
    expect(d.method).toBe('llm');
  });

  it('ROUTES THROUGH a capacity-shed pause (the actual 2026-06-25 spawn-cap mechanism)', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('capacity') });
    const d = await s.decideInboundDisposition('Checking in to see if telegram is working', 28130);
    expect(d.disposition).toBe('route-through'); // capacity-shed pause must NOT consume
  });

  it('RESCUES a long-form genuine stop that was capacity-shed → kill (not route-through)', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('capacity') });
    const d = await s.decideInboundDisposition('I really need you to stop deleting everything right now', 28130);
    expect(d.disposition).toBe('kill'); // stop-token scan rescues it
    expect(d.category).toBe('emergency-stop');
  });

  it('RESCUES a long-form stop the LLM mislabeled as pause → kill', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('pause') });
    const d = await s.decideInboundDisposition('please could you stop the current operation', 28130);
    expect(d.disposition).toBe('kill');
  });

  it('a deterministic emergency-stop still kills instantly', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('normal') });
    const d = await s.decideInboundDisposition('stop', 28130);
    expect(d.disposition).toBe('kill');
    expect(d.method).toBe('fast-path');
  });

  it('a genuinely normal message routes through', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('normal') });
    const d = await s.decideInboundDisposition('hello, can you check the build status?', 28130);
    expect(d.disposition).toBe('route-through');
  });

  it('CIRCUIT-BREAKER: after the cap of deterministic pauses, a further non-deterministic pause auto-recovers', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('pause') });
    // 3 deterministic pauses consume (the cap is 3 per window)
    for (let i = 0; i < 3; i++) {
      const d = await s.decideInboundDisposition('pause', 28130);
      expect(d.disposition).toBe('pause');
    }
    // a benign message the LLM mislabels as pause now routes through regardless (already would),
    // and a 4th deterministic pause is suppressed by the tripped breaker → route-through
    const d4 = await s.decideInboundDisposition('pause', 28130);
    expect(d4.disposition).toBe('route-through'); // breaker tripped → never lock out
    expect(s.dispositionStats.breakerRecovered).toBeGreaterThanOrEqual(1);
  });

  it('breaker is per-topic: a different topic is unaffected', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('pause') });
    for (let i = 0; i < 4; i++) await s.decideInboundDisposition('pause', 111);
    const other = await s.decideInboundDisposition('pause', 222);
    expect(other.disposition).toBe('pause'); // topic 222 has its own budget
  });

  it('observability counters increment on each branch', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('pause') });
    await s.decideInboundDisposition('pause', 28130);   // consumed
    await s.decideInboundDisposition('Testing', 28130); // routed-through
    expect(s.dispositionStats.pauseConsumed).toBe(1);
    expect(s.dispositionStats.pauseRoutedThrough).toBe(1);
  });
});

describe('hasStopToken — non-word-count-gated deterministic stop scan', () => {
  it('detects stop words anywhere (no length gate)', () => {
    expect(hasStopToken('I really need you to stop everything now please')).toBe(true);
    expect(hasStopToken('stop')).toBe(true);
    expect(hasStopToken('cancel the operation')).toBe(true);
    expect(hasStopToken('please abort')).toBe(true);
    expect(hasStopToken('kill it')).toBe(true);
    expect(hasStopToken('/stop')).toBe(true);
  });
  it('does NOT fire on benign messages or pause', () => {
    expect(hasStopToken('Testing')).toBe(false);
    expect(hasStopToken('pause')).toBe(false);
    expect(hasStopToken('can you check the build status?')).toBe(false);
    expect(hasStopToken('')).toBe(false);
    expect(hasStopToken('stopwords are common in NLP pipelines')).toBe(false); // "stopwords" is not whole-word "stop"
  });
  it('is intentionally CONSERVATIVE: a whole-word stop (even in "non-stop") rescues to kill — a kill is recoverable, a missed stop is not', () => {
    expect(hasStopToken('this was a non-stop session')).toBe(true); // hyphen is a word boundary → whole-word "stop"
  });
});
