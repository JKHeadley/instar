/**
 * LlmRateGate — actuator primitive for the burn-detection auto-heal system.
 *
 * Phase 1 (this file): ships as a NO-OP. The primitive exists, the shape is
 * stable, and instar-internal LLM callers can already consult it before each
 * call — but no decision-maker is wired in yet, so `shouldFire(key)` always
 * returns true. This deliberate sequencing avoids a regression window where
 * the BurnDetector emits signals with no actuator to honour them.
 *
 * Future phases (per docs/specs/token-burn-detection-and-self-heal.md):
 *   - Phase 4 (burn-throttle runbook): the Remediator-Tier-2 runbook stores
 *     signed throttle decisions; the gate consults that store.
 *   - Phase 4 (HMAC-signed jobs.json.throttle-overrides): scheduled-job
 *     overrides land via this gate so the same actuator covers cron entries.
 *
 * Authority shape: the gate ENFORCES decisions that were made elsewhere. It
 * does NOT decide. Brittle threshold detectors must never write to this
 * gate directly — only the Remediator (with signed-context Tier-2 capability
 * tokens) can install a throttle. This honours the signal-vs-authority
 * boundary in docs/signal-vs-authority.md.
 *
 * Singleton-per-process: every LLM caller in the process shares one gate so
 * a single throttle decision covers every code path that uses the same
 * attribution key. The class exposes a static `instance()` accessor; tests
 * use the public constructor + `reset()` to isolate from the singleton.
 */

export interface LlmRateGateDecision {
  /** Whether the gate currently allows the next LLM call for this key. */
  allowed: boolean;
  /** ISO timestamp the decision was made (debug / log). */
  decidedAt: string;
  /** Why — for log + verification trace. */
  reason: 'phase-1-noop' | 'no-throttle-installed' | 'throttle-active' | 'throttle-expired';
}

export class LlmRateGate {
  private static singleton: LlmRateGate | null = null;

  /**
   * Process-wide singleton. Tests should use `new LlmRateGate()` + `reset()`
   * rather than this accessor, so they don't bleed throttles into each other.
   */
  static instance(): LlmRateGate {
    if (!LlmRateGate.singleton) {
      LlmRateGate.singleton = new LlmRateGate();
    }
    return LlmRateGate.singleton;
  }

  /**
   * Phase 1: always returns true. The signature is stable so callers can
   * adopt the consult-before-call pattern today; future phases enforce it.
   *
   * @param attributionKey  componentName::promptFingerprint key. Reserved
   *                        values: keys starting with `burn-throttle-runbook::`
   *                        are exempt by design (self-reinforcing-loop guard
   *                        per spec §"Self-reinforcing loop guard").
   */
  shouldFire(attributionKey: string): boolean {
    return this.decide(attributionKey).allowed;
  }

  /**
   * Same as shouldFire() but returns the full decision record. Useful for
   * tests and for the burn-throttle runbook's verification step.
   */
  decide(attributionKey: string): LlmRateGateDecision {
    // Self-attribution exempt (spec §"Self-reinforcing loop guard"): the
    // runbook's own LLM calls cannot be throttled by the runbook's own
    // decisions, ever. This is the structural floor that prevents a
    // deadlock where the throttle stops the alert from being sent.
    if (attributionKey.startsWith('burn-throttle-runbook::')) {
      return {
        allowed: true,
        decidedAt: new Date().toISOString(),
        reason: 'phase-1-noop',
      };
    }
    return {
      allowed: true,
      decidedAt: new Date().toISOString(),
      reason: 'phase-1-noop',
    };
  }

  /**
   * Reset all installed throttles. Phase 1 has no throttles, so this is a
   * no-op; future phases will clear the in-memory throttle map. Exposed for
   * tests so a misconfigured singleton can't bleed across `describe` blocks.
   */
  reset(): void {
    // Phase 1: no state to reset. Intentional empty body.
  }
}
