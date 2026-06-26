/**
 * Per-framework circuit-breaker isolation (topic-28744 backend-reliability work).
 *
 * The incident: outbound Telegram went silent because a claude-code (claude -p)
 * rate-limit kept tripping a breaker, and the perception was that it "paused ALL
 * LLM-backed work" — including the pi/gemini-routed tone gate. This test pins the
 * actual contract: each framework provider carries its OWN LlmCircuitBreaker
 * instance (server.ts buildFrameworkProvider: `breaker: new LlmCircuitBreaker()`),
 * so a claude-code rate-limit trip must NOT block a call routed to a DIFFERENT
 * framework (pi-cli). The breaker is per-PROVIDER (an account-wide rate-limit
 * legitimately backs off every call to THAT provider) — never cross-provider.
 *
 * Completion-condition #2 for the 12h fix session: "the LLM circuit breaker is
 * per-framework — a claude-code rate-limit trip does NOT pause pi/gemini/codex —
 * demonstrated by code + a passing test."
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IntelligenceRouter,
} from '../../src/core/IntelligenceRouter.js';
import {
  LlmCircuitBreaker,
  LlmCircuitOpenError,
  RateLimitError,
} from '../../src/core/LlmCircuitBreaker.js';
import { CircuitBreakingIntelligenceProvider } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

class FakeProvider implements IntelligenceProvider {
  calls = 0;
  constructor(private behavior: () => Promise<string>) {}
  async evaluate(): Promise<string> {
    this.calls += 1;
    return this.behavior();
  }
}

// A gating call routed to pi-cli (the user-facing tone gate's posture after the fix).
const PI_GATING: IntelligenceOptions = {
  attribution: { component: 'MessagingToneGate', gating: true },
};
// A gating call with NO override → resolves to the default framework (claude-code).
const DEFAULT_GATING: IntelligenceOptions = {
  attribution: { component: 'SomeDefaultGate', gating: true },
};

describe('per-framework circuit-breaker isolation', () => {
  let nowMs: number;
  let claudeBreaker: LlmCircuitBreaker;
  let piBreaker: LlmCircuitBreaker;

  beforeEach(() => {
    nowMs = 1_000_000;
    claudeBreaker = new LlmCircuitBreaker({ openMs: 60_000, now: () => nowMs, log: () => {} });
    piBreaker = new LlmCircuitBreaker({ openMs: 60_000, now: () => nowMs, log: () => {} });
  });

  it('a claude-code rate-limit trip does NOT block a pi-cli-routed call (and DOES block a claude-routed call)', async () => {
    // claude-code (default) provider — wrapped in its OWN breaker; rate-limited.
    const claudeInner = new FakeProvider(async () => {
      throw new Error('Claude CLI error: 429 Too Many Requests — usage limit reached');
    });
    const claudeProvider = new CircuitBreakingIntelligenceProvider(claudeInner, claudeBreaker);

    // pi-cli provider — wrapped in its OWN, independent breaker; healthy.
    const piInner = new FakeProvider(async () => 'pi-verdict');
    const piProvider = new CircuitBreakingIntelligenceProvider(piInner, piBreaker);

    const router = new IntelligenceRouter({
      defaultProvider: claudeProvider,
      defaultFramework: 'claude-code',
      // Route the user-facing tone gate to pi-cli; everything else stays default.
      resolveConfig: () => ({ overrides: { MessagingToneGate: 'pi-cli' } }),
      buildProvider: (fw: IntelligenceFramework) =>
        fw === 'pi-cli' ? piProvider : null,
    });

    // 1) Trip claude-code's breaker via a default-routed gating call (rate-limited).
    await expect(router.evaluate('x', DEFAULT_GATING)).rejects.toBeInstanceOf(RateLimitError);
    expect(claudeBreaker.status().state).toBe('open');
    expect(piBreaker.status().state).toBe('closed');

    // 2) THE ISOLATION CONTRACT: a pi-cli-routed call STILL SUCCEEDS while claude's
    //    breaker is open — the trip did not cross provider boundaries.
    await expect(router.evaluate('hello', PI_GATING)).resolves.toBe('pi-verdict');
    expect(piInner.calls).toBe(1);

    // 3) A further default-routed call is SHORT-CIRCUITED by claude's open breaker
    //    (proves the breaker is real AND scoped to claude — not a no-op, not global).
    await expect(router.evaluate('y', DEFAULT_GATING)).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(claudeInner.calls).toBe(1); // no extra spawn against the rate-limited account

    // 4) pi remains fully usable across repeated calls — its breaker never tripped.
    await expect(router.evaluate('again', PI_GATING)).resolves.toBe('pi-verdict');
    expect(piInner.calls).toBe(2);
    expect(piBreaker.status().state).toBe('closed');
  });
});
