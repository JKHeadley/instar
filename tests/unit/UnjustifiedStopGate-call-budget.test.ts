/**
 * Per-call budget widening (CMT-1006). Shadow recording runs after the Stop
 * hook is answered, so it may give the authority more than the 2s blocking
 * budget. The option may only LENGTHEN the configured default, never shorten it.
 */
import { describe, it, expect } from 'vitest';
import { UnjustifiedStopGate, MAX_CALL_TIMEOUT_MS, type EvaluateInput } from '../../src/core/UnjustifiedStopGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const INPUT: EvaluateInput = {
  evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
  untrustedContent: { stopReason: 'done', recentTurns: [] },
};
const ALLOW = JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'complete' });

function slowProvider(delayMs: number): IntelligenceProvider {
  return { evaluate: () => new Promise(resolve => setTimeout(() => resolve(ALLOW), delayMs)) };
}

describe('UnjustifiedStopGate — per-call timeout option', () => {
  it('a call slower than the default budget times out without the option', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(150), clientTimeoutMs: 40, breakerThreshold: 0 });
    const outcome = await gate.evaluate(INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('timeout');
  });

  it('the same call succeeds with a widened budget and closes the breaker', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(150), clientTimeoutMs: 40, breakerThreshold: 1, breakerCooldownMs: 1 });
    await gate.evaluate(INPUT); // timeout -> breaker opens
    await new Promise(r => setTimeout(r, 5)); // cooldown elapses -> half-open probe
    const outcome = await gate.evaluate(INPUT, { timeoutMs: 2_000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.rule).toBe('U_LEGIT_COMPLETION');
    expect(gate.breakerState().consecutiveFailures).toBe(0);
  });

  it('a shorter requested budget is clamped up to the configured default', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(30), clientTimeoutMs: 200, breakerThreshold: 0 });
    const outcome = await gate.evaluate(INPUT, { timeoutMs: 5 });
    expect(outcome.ok).toBe(true);
  });

  it('a non-finite requested budget falls back to the default', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(150), clientTimeoutMs: 40, breakerThreshold: 0 });
    const outcome = await gate.evaluate(INPUT, { timeoutMs: Number.NaN });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.detail).toBe('>40ms');
  });

  it('an over-large requested budget is capped at MAX_CALL_TIMEOUT_MS', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(1), clientTimeoutMs: 40, breakerThreshold: 0 });
    const reached = (gate as unknown as { effectiveTimeoutMs(n: number): number }).effectiveTimeoutMs(10 * MAX_CALL_TIMEOUT_MS);
    expect(reached).toBe(MAX_CALL_TIMEOUT_MS);
  });

  it('onProviderSettled fires when the provider call really ends, after a timeout resolved evaluate', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(150), clientTimeoutMs: 40, breakerThreshold: 0 });
    let settledAt = 0;
    const t0 = Date.now();
    const outcome = await gate.evaluate(INPUT, { onProviderSettled: () => { settledAt = Date.now(); } });
    expect(outcome.ok).toBe(false);
    expect(settledAt).toBe(0); // provider still running after the timeout
    await new Promise(r => setTimeout(r, 200));
    expect(settledAt - t0).toBeGreaterThanOrEqual(140);
  });

  it('onProviderSettled fires once at once when no provider call is made (breaker open)', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: slowProvider(150), clientTimeoutMs: 40, breakerThreshold: 1, breakerCooldownMs: 60_000 });
    await gate.evaluate(INPUT); // opens the breaker
    let n = 0;
    const outcome = await gate.evaluate(INPUT, { onProviderSettled: () => { n += 1; } });
    expect(!outcome.ok && outcome.failure.kind).toBe('breakerOpen');
    expect(n).toBe(1);
  });

  it('onProviderSettled fires once when the provider throws synchronously', async () => {
    const gate = new UnjustifiedStopGate({ intelligence: { evaluate: () => { throw new Error('boom'); } }, clientTimeoutMs: 40, breakerThreshold: 0 });
    let n = 0;
    await gate.evaluate(INPUT, { onProviderSettled: () => { n += 1; } });
    expect(n).toBe(1);
  });
});
