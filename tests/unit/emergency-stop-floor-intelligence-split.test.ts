/**
 * The floor/intelligence split — emergency-stop decision authority.
 *
 * Settled 2026-08-07 by operator ruling on external-review finding 1, which found an
 * UNQUALIFIED conflict between two ratified articles: *Intelligence Infers, Keywords
 * Only Guard* said a command decision "is made by an LLM" and a keyword list is
 * "NEVER the decision-maker", while *The Operator Channel Is Sacred* said a
 * message-CONSUMING decision "requires a DETERMINISTIC match, never a bare-LLM guess".
 * For emergency-stop the resolution is a two-layer UNION:
 *
 *   (a) the literal-match FLOOR always stops and can NEVER be vetoed by the model —
 *       a floor match short-circuits and returns BEFORE the model is consulted;
 *   (b) the model layer may only ADD stops it infers from any phrasing — an
 *       LLM-inferred stop is a real stop and kills on its own.
 *
 * Stop = floor OR model, never floor AND model.
 *
 * This ratchet pins BOTH arms plus a discriminator. It is deliberately two-sided:
 * an A-case alone would prove only that the harness can produce a kill, not that
 * either layer is load-bearing (the rung-three amendment, ratified 2026-08-06 — a
 * guard must ACT when it should AND HOLD BACK when it should).
 *
 * Case: docs/audits/phase-b/window8-review-settlement.md §1.
 */
import { describe, it, expect } from 'vitest';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

/**
 * Mock LLM that RECORDS whether it was consulted. `calls` is the load-bearing
 * observation for arm (a): "cannot be vetoed" is only proven if the model is never
 * asked — a model that answers and is then ignored is a weaker property.
 */
function recordingIntel(verdict: 'emergency-stop' | 'normal') {
  const calls: string[] = [];
  const provider = {
    evaluate: async (prompt: string) => {
      calls.push(prompt);
      return verdict;
    },
  } as unknown as IntelligenceProvider;
  return { provider, calls };
}

describe('emergency-stop floor/intelligence split', () => {
  it('(a) FLOOR IS UN-VETOABLE: a literal match kills even when the model would say "normal" — and the model is never consulted', async () => {
    const { provider, calls } = recordingIntel('normal');
    const s = new MessageSentinel({ intelligence: provider });

    const d = await s.decideInboundDisposition('stop', 28130);

    expect(d.disposition).toBe('kill');
    expect(d.category).toBe('emergency-stop');
    expect(d.method).toBe('fast-path');
    // The load-bearing assertion: the model layer had no opportunity to veto,
    // because it was never asked. A short-circuit, not an override.
    expect(calls).toHaveLength(0);
  });

  it('(b) MODEL MAY ADD: a stop the literal floor does NOT match still kills when the model infers it', async () => {
    const { provider, calls } = recordingIntel('emergency-stop');
    const s = new MessageSentinel({ intelligence: provider });

    // Phrasing deliberately outside the literal stop set. The `method` assertion
    // is what makes this arm honest: if this wording were to fast-path, the test
    // fails loudly rather than silently proving the wrong thing.
    const d = await s.decideInboundDisposition(
      'belay that entirely and unwind whatever you just began, I have changed my mind',
      28130,
    );

    expect(d.method).toBe('llm'); // the floor did NOT fire — the model added this stop
    expect(d.disposition).toBe('kill');
    expect(d.category).toBe('emergency-stop');
    expect(calls).toHaveLength(1);
  });

  it('DISCRIMINATOR: the same non-literal phrasing does NOT kill when the model says "normal"', async () => {
    const { provider } = recordingIntel('normal');
    const s = new MessageSentinel({ intelligence: provider });

    const d = await s.decideInboundDisposition(
      'belay that entirely and unwind whatever you just began, I have changed my mind',
      28130,
    );

    // Without this arm, test (b) would pass on a harness that kills everything.
    expect(d.disposition).not.toBe('kill');
  });

  it('UNION, NOT INTERSECTION: a floor match with no model available still kills', async () => {
    // No intelligence provider at all — the floor must remain sufficient on its own.
    // This is the arm that contradicts the withdrawn "never the sole decision" clause.
    const s = new MessageSentinel({});

    const d = await s.decideInboundDisposition('stop', 28130);

    expect(d.disposition).toBe('kill');
    expect(d.method).toBe('fast-path');
  });
});
