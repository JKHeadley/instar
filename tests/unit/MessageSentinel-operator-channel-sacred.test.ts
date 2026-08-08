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
import { MessageSentinel, isExactStopMessage } from '../../src/core/MessageSentinel.js';
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

  // ── REVERSED 2026-08-07 under operator ruling A ────────────────────────────
  // These two asserted that a long-form message CONTAINING a stop word is rescued
  // to a KILL during capacity shed. That is structure deciding alone on a
  // SUBSTRING, which *Structure Decides Alone Only on an Exact Match* forbids —
  // and the same actuator killed "please do not cancel the review because it is
  // complete", inverting the operator's meaning. Found by Codey's advisory review
  // and reproduced before being changed.
  //
  // The safety they were protecting is NOT lost: an EXACT stop short-circuits
  // before the provider is consulted, so it never reaches this path. A non-exact
  // message now ROUTES THROUGH — delivered to the agent, not consumed, not killed.
  it('DOES NOT kill a long-form non-exact stop that was capacity-shed — it routes through', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('capacity') });
    const d = await s.decideInboundDisposition('I really need you to stop deleting everything right now', 28130);
    expect(d.disposition).toBe('route-through'); // delivered to the agent, not killed by a substring
  });

  it('DOES NOT kill a long-form non-exact stop the LLM mislabeled as pause — it routes through', async () => {
    const s = new MessageSentinel({ intelligence: mockIntel('pause') });
    const d = await s.decideInboundDisposition('please could you stop the current operation', 28130);
    expect(d.disposition).toBe('route-through');
  });

  it('but an EXACT stop still kills on BOTH fallback paths — the floor is intact', async () => {
    for (const behavior of ['capacity', 'pause'] as const) {
      for (const m of ['stop', 'stop everything', '/stop']) {
        const s = new MessageSentinel({ intelligence: mockIntel(behavior) });
        const d = await s.decideInboundDisposition(m, 28131);
        expect(d.disposition, `exact "${m}" under ${behavior}`).toBe('kill');
      }
    }
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

describe('isExactStopMessage — EXACT membership, not a substring scan', () => {
  // Renamed and inverted 2026-08-07 (ruling A). The old `hasStopToken` scanned for
  // a stop word ANYWHERE and accepted slash PREFIXES; it was the actuator behind
  // the capacity-shed substring kills. Exact membership replaces it.
  it('accepts EXACT enumerated stops, including slash commands', () => {
    expect(isExactStopMessage('stop')).toBe(true);
    expect(isExactStopMessage('stop everything')).toBe(true);
    expect(isExactStopMessage('cancel everything')).toBe(true);
    expect(isExactStopMessage('kill it')).toBe(true);
    expect(isExactStopMessage('/stop')).toBe(true);
    expect(isExactStopMessage('  STOP  ')).toBe(true); // trimmed + case-insensitive
  });

  it('REFUSES every non-exact message the old substring scan accepted', () => {
    // Each of these was previously `true` and produced a real kill under shed.
    expect(isExactStopMessage('I really need you to stop everything now please')).toBe(false);
    expect(isExactStopMessage('cancel the operation')).toBe(false);
    expect(isExactStopMessage('please abort')).toBe(false);
    expect(isExactStopMessage('/stop the build only')).toBe(false); // slash PREFIX, not the command
  });

  it('THE CASE THAT SETTLES IT: a message whose MEANING IS THE OPPOSITE is refused', () => {
    // The old scan killed this. The operator says do NOT cancel; a substring cannot
    // carry negation, which is why no scan can be safe on this path.
    expect(isExactStopMessage('please do not cancel the review because it is complete')).toBe(false);
    // And the hyphen case the old test explicitly ASSERTED should kill:
    expect(isExactStopMessage('this was a non-stop session')).toBe(false);
  });

  it('still refuses benign messages and pause', () => {
    expect(isExactStopMessage('Testing')).toBe(false);
    expect(isExactStopMessage('pause')).toBe(false);
    expect(isExactStopMessage('can you check the build status?')).toBe(false);
    expect(isExactStopMessage('')).toBe(false);
  });
});
